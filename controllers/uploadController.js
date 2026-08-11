const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const storage = require("../services/storage");
const { transcribeToVtt } = require("../services/deepgram");
const { triggerUploadProcessing } = require("../services/githubActions");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

// GET /api/admin/upload-url?filename=...&contentType=...
async function getUploadUrl(req, res) {
  try {
    const { filename, contentType } = req.query;
    if (!filename) {
      return res.status(400).json({ error: "Missing required query parameter: filename" });
    }

    const result = await storage.getUploadUrl(filename, contentType);
    res.json(result); // { uploadUrl, key, publicUrl }
  } catch (err) {
    console.error("Error generating upload URL:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
}

// POST /api/admin/uploads
// Body: { key, title, description?, year?, country?, category?, tags?, director?, cast? }
//
// Two processing tracks run from here:
//  - Captions (Deepgram): awaited synchronously. Deepgram fetches the R2
//    URL itself and does the transcription remotely — this is just an
//    idle HTTP wait on our end, not local compute, so it's fine to await.
//  - Thumbnail/preview (GitHub Actions in the dedicated heavy-backend
//    repo): dispatched and NOT awaited — it reports back later via
//    POST /api/service/uploads/:id/callback. transcodeStatus reflects
//    this: it's "processing" when this request returns, not "completed".
async function createUpload(req, res) {
  try {
    const { key, title, description, year, country, category, tags, director, cast } = req.body;

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Missing required field: title" });
    }

    const streamUrl = storage.getPublicUrl(key);

    const film = await Film.create({
      title: title.trim(),
      description,
      year: year ? Number(year) : undefined,
      country,
      category: toArray(category),
      tags: toArray(tags),
      director,
      cast: toArray(cast),
      source: "own-upload",
      storageProvider: "r2",
      masterKey: key,
      streamUrl,
      downloadUrl: streamUrl,
      transcodeStatus: "queued",
      status: "pending",
      verifiedBy: req.user?.email || req.user?.uid,
    });

    // --- Captions (Deepgram, awaited) ---
    try {
      const vtt = await transcribeToVtt(streamUrl);
      const captionsKey = `${key.replace(/\.[^/.]+$/, "")}-captions.vtt`;
      film.captionsUrl = await storage.uploadBuffer(captionsKey, vtt, "text/vtt");
      await film.save();
    } catch (captionErr) {
      // Best-effort — a captions failure shouldn't block thumbnail/preview
      // or publishing. Logged for the admin to notice and possibly retry.
      console.error(`Captioning failed for upload ${film._id}:`, captionErr.message);
      Sentry.captureException(captionErr);
    }

    // --- Thumbnail + preview (GitHub Actions, dispatched not awaited) ---
    try {
      await triggerUploadProcessing(film._id, key);
      film.transcodeStatus = "processing";
      await film.save();
    } catch (dispatchErr) {
      console.error(`Failed to dispatch media processing for ${film._id}:`, dispatchErr.message);
      Sentry.captureException(dispatchErr);
      film.transcodeStatus = "failed";
      await film.save();
    }

    res.status(201).json(film);
  } catch (err) {
    console.error("Error creating upload:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to create upload" });
  }
}

// POST /api/admin/uploads/:id/retry-processing
// Re-dispatches thumbnail/preview processing without re-uploading — the
// master file is already sitting in R2. Used by the "Retry" button next
// to failed own-uploads in the admin queue.
async function retryProcessing(req, res) {
  try {
    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: "Film not found" });
    if (!film.masterKey) {
      return res.status(400).json({ error: "This film has no masterKey to reprocess" });
    }

    await triggerUploadProcessing(film._id, film.masterKey);
    film.transcodeStatus = "processing";
    await film.save();

    res.json(film);
  } catch (err) {
    console.error("Error retrying processing:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to retry processing" });
  }
}

module.exports = { getUploadUrl, createUpload, retryProcessing };
