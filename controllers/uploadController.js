// backend/controllers/uploadController.js

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const Provider = require("../models/Provider");
const storage = require("../services/storage");
const storageRouter = require("../services/storageRouter");
const { getAdapter } = require("../services/adapterRegistry");
const { mapToTaxonomy } = require("../services/categoryMapper");
const { transcribeToVtt } = require("../services/deepgram");
const { triggerUploadProcessing } = require("../services/githubActions");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

// GET /api/admin/upload-url?filename=...&contentType=...&fileSizeBytes=...&fingerprint=...
//
// fingerprint is a lightweight client-computed fingerprint of the file
// (see frontend's lib/fileFingerprint.ts) — a hash of just the first few
// MB plus the exact file size, not a full-file hash. The backend never
// receives the file's bytes at all (uploads go straight from the browser
// to storage), so it can't compute this itself; the browser has to.
//
// Checked here, BEFORE storageRouter reserves any capacity — rejecting a
// duplicate after already reserving (and having to release) space would
// be unnecessary churn for an upload that was always going to be
// rejected. Film.fileHash also has a unique+sparse index as a DB-level
// backstop against a race between two near-simultaneous uploads of the
// same file (see createUpload's catch block below).
async function getUploadUrl(req, res) {
  try {
    const { filename, contentType, fileSizeBytes, fingerprint } = req.query;
    if (!filename) {
      return res.status(400).json({ error: "Missing required query parameter: filename" });
    }
    if (!fileSizeBytes || Number.isNaN(Number(fileSizeBytes))) {
      return res
        .status(400)
        .json({ error: "Missing or invalid required query parameter: fileSizeBytes" });
    }
    if (!fingerprint) {
      return res.status(400).json({ error: "Missing required query parameter: fingerprint" });
    }

    const existing = await Film.findOne({ fileHash: fingerprint }, { title: 1 });
    if (existing) {
      return res.status(409).json({
        error: `This file was already uploaded as "${existing.title}".`,
        duplicateOf: existing._id,
      });
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
// Body: { key, storageProvider, fingerprint, title, description?, year?, country?, category?, tags?, director?, cast?, fileSizeBytes? }
//
// storageProvider and fingerprint must be whatever getUploadUrl returned/
// was called with above — the frontend just relays them through
// unchanged. category is mapped through the fixed taxonomy here too
// (not just relying on the frontend's picker), so the invariant
// "Film.category only ever contains valid taxonomy names" holds
// regardless of entry path.
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
      fingerprint,
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
    if (!fingerprint) {
      return res.status(400).json({ error: "Missing required field: fingerprint" });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Missing required field: title" });
    }

    const adapter = getAdapter(storageProvider);
    const streamUrl = adapter.getPublicUrl(key);

    let film;
    try {
      film = await Film.create({
        title: title.trim(),
        description,
        year: year ? Number(year) : undefined,
        country,
        category: mapToTaxonomy(toArray(category)),
        tags: toArray(tags),
        director,
        cast: toArray(cast),
        fileSizeBytes: fileSizeBytes ? Number(fileSizeBytes) : undefined,
        fileHash: fingerprint,
        source: "own-upload",
        storageProvider,
        masterKey: key,
        streamUrl,
        downloadUrl: streamUrl,
        transcodeStatus: "queued",
        status: "pending",
        verifiedBy: req.user?.email || req.user?.uid,
      });
    } catch (createErr) {
      // A near-simultaneous duplicate upload can slip past
      // getUploadUrl's precheck (both requests see "no match yet" before
      // either finishes) — the unique+sparse index on fileHash is the
      // real guarantee, and a duplicate-key error here means exactly
      // that race happened. Surface it the same way as a normal
      // precheck rejection, not as a raw 500.
      if (createErr?.code === 11000) {
        return res.status(409).json({ error: "This file was already uploaded." });
      }
      throw createErr;
    }

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

      // The dispatch itself failed, so process-upload.yml never ran —
      // meaning serviceController.js's callback-based capacity release
      // never fires for this film either. Release the reservation here
      // instead, so a dispatch failure (bad GITHUB_PAT, GitHub API
      // hiccup, etc.) doesn't permanently consume quota for a file that
      // was never actually processed.
      if (typeof film.fileSizeBytes === "number") {
        await Provider.updateOne(
          { name: storageProvider },
          { $inc: { usedBytes: -film.fileSizeBytes } }
        ).catch((releaseErr) => {
          console.error(
            `Failed to release reserved capacity for provider ${storageProvider} (film ${film._id}):`,
            releaseErr.message
          );
          Sentry.captureException(releaseErr);
        });
      }
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
