// backend/controllers/uploadController.js

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const storage = require("../services/storage");
const storageRouter = require("../services/storageRouter");
const { getAdapter } = require("../services/adapterRegistry");
const { transcribeToVtt } = require("../services/deepgram");
const { triggerUploadProcessing } = require("../services/githubActions");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

// GET /api/admin/upload-url?filename=...&contentType=...&fileSizeBytes=...
//
// Since Slice 12, this no longer always presigns against R2 — it asks
// storageRouter which provider (R2/B2/Storj) currently has free capacity,
// per the priority order configured at /admin/storage, and presigns
// against whichever one it picks. fileSizeBytes is required now: the
// router needs it up front to decide whether a candidate provider
// actually has room, not just to record it after the fact.
async function getUploadUrl(req, res) {
  try {
    const { filename, contentType, fileSizeBytes } = req.query;
    if (!filename) {
      return res.status(400).json({ error: "Missing required query parameter: filename" });
    }
    if (!fileSizeBytes || Number.isNaN(Number(fileSizeBytes))) {
      return res
        .status(400)
        .json({ error: "Missing or invalid required query parameter: fileSizeBytes" });
    }

    const result = await storageRouter.reserveUploadSlot(
      filename,
      contentType,
      Number(fileSizeBytes)
    );
    res.json(result); // { uploadUrl, key, publicUrl, storageProvider }
  } catch (err) {
    console.error("Error generating upload URL:", err);
    Sentry.captureException(err);
    const status = err.code === "NO_CAPACITY" ? 503 : 500;
    res.status(status).json({ error: err.message || "Failed to generate upload URL" });
  }
}

// POST /api/admin/uploads
// Body: { key, storageProvider, title, description?, year?, country?, category?, tags?, director?, cast?, fileSizeBytes? }
//
// storageProvider must be whatever getUploadUrl returned above — the
// frontend just relays it through unchanged, it never picks a provider
// itself.
//
// Two processing tracks run from here:
//  - Captions (Deepgram): awaited synchronously. Deepgram fetches the
//    public URL itself and does the transcription remotely — this is
//    just an idle HTTP wait on our end, not local compute, so it's fine
//    to await. Captions themselves always live on R2 regardless of which
//    provider the master is on (see storage.js's uploadBuffer comment).
//  - Thumbnail/preview (GitHub Actions in the dedicated heavy-backend
//    repo): dispatched and NOT awaited — it reports back later via
//    POST /api/service/uploads/:id/callback. transcodeStatus reflects
//    this: it's "processing" when this request returns, not "completed".
async function createUpload(req, res) {
  try {
    const {
      key,
      storageProvider,
      title,
      description,
      year,
      country,
      category,
      tags,
      director,
      cast,
      fileSizeBytes,
    } = req.body;

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }
    if (!storageProvider) {
      return res.status(400).json({ error: "Missing required field: storageProvider" });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Missing required field: title" });
    }

    const adapter = getAdapter(storageProvider);
    const streamUrl = adapter.getPublicUrl(key);

    const film = await Film.create({
      title: title.trim(),
      description,
      year: year ? Number(year) : undefined,
      country,
      category: toArray(category),
      tags: toArray(tags),
      director,
      cast: toArray(cast),
      fileSizeBytes: fileSizeBytes ? Number(fileSizeBytes) : undefined,
      source: "own-upload",
      storageProvider,
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
      await triggerUploadProcessing(film._id, key, storageProvider);
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
// master file is already sitting with its recorded storageProvider. Used
// by the "Retry" button next to failed own-uploads in the admin queue.
async function retryProcessing(req, res) {
  try {
    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: "Film not found" });
    if (!film.masterKey) {
      return res.status(400).json({ error: "This film has no masterKey to reprocess" });
    }
    if (!film.storageProvider) {
      return res
        .status(400)
        .json({ error: "This film has no storageProvider recorded — cannot determine which storage backend to reprocess from" });
    }

    await triggerUploadProcessing(film._id, film.masterKey, film.storageProvider);
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
