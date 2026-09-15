// backend/controllers/uploadController.js

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const storage = require("../services/storage");
const storageRouter = require("../services/storageRouter");
const { getAdapter } = require("../services/adapterRegistry");
const { mapToTaxonomy } = require("../services/categoryMapper");
const { transcribeToVtt } = require("../services/deepgram");
const { triggerUploadProcessing, triggerAbrTranscode } = require("../services/githubActions");
const { releaseReservedCapacity } = require("../services/storageCapacityService");

// Slice 15 — must match the same constant in controllers/
// serviceController.js. Duplicated rather than imported from a shared
// constants file since it's a single primitive value used by two
// independent validation paths (the automatic dispatch decision there,
// the manual "Generate multi-quality" retry validation here) — worth
// keeping in sync by comment, not worth a new shared module for one
// number.
const ABR_MIN_SOURCE_HEIGHT = 480;

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
// Body: { key, storageProvider, fingerprint, title, description?, year?, country?, category?, tags?, director?, cast?, fileSizeBytes?, abrRequested? }
//
// storageProvider and fingerprint must be whatever getUploadUrl returned/
// was called with above — the frontend just relays them through
// unchanged. category is mapped through the fixed taxonomy here too
// (not just relying on the frontend's picker), so the invariant
// "Film.category only ever contains valid taxonomy names" holds
// regardless of entry path.
//
// abrRequested (Slice 15) is the admin's upload-form toggle — "Generate
// multiple quality levels for this upload" — defaulting to true if not
// sent at all. It's stored now but not acted on here: eligibility
// (whether the source is actually >= 480p) isn't known until the
// existing thumbnail/preview job reports sourceHeight, so the real
// dispatch decision happens later, in
// serviceController.decideAndDispatchAbr.
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
//    transcodeStartedAt is set at this dispatch moment (Slice 14) — see
//    serviceController.reconcileStuckJobs for how that's used to detect
//    a run that never calls back.
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
      abrRequested,
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
        abrRequested: typeof abrRequested === "boolean" ? abrRequested : true,
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
      film.transcodeStartedAt = new Date();
      await film.save();
    } catch (dispatchErr) {
      console.error(`Failed to dispatch media processing for ${film._id}:`, dispatchErr.message);
      Sentry.captureException(dispatchErr);
      film.transcodeStatus = "failed";
      film.transcodeError = dispatchErr.message;
      await film.save();

      // The dispatch itself failed, so process-upload.yml never ran —
      // meaning serviceController.js's callback-based capacity release
      // never fires for this film either. Release the reservation here
      // instead, so a dispatch failure (bad GITHUB_PAT, GitHub API
      // hiccup, etc.) doesn't permanently consume quota for a file that
      // was never actually processed. (Note: since thumbnail/preview
      // never ran, sourceHeight is never known either, so ABR is never
      // even considered for this film — abrStatus stays at its default
      // "not_applicable".)
      await releaseReservedCapacity(film);
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
//
// A manual admin retry is a deliberate fresh attempt, distinct from the
// automated stuck-transcode sweep's own one-shot retry (Slice 14) — so
// this resets transcodeRetryCount to 0 (giving that sweep a full fresh
// attempt of its own if this retry also gets stuck) and clears any
// previous transcodeError, rather than treating this as a continuation
// of whatever attempt came before. Does not touch anything ABR-related —
// see generateAbr below for that.
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
    film.transcodeStartedAt = new Date();
    film.transcodeRetryCount = 0;
    film.transcodeError = undefined;
    await film.save();

    res.json(film);
  } catch (err) {
    console.error("Error retrying processing:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to retry processing" });
  }
}

// POST /api/admin/uploads/:id/generate-abr
//
// Slice 15 — the admin-facing "Generate multi-quality" / "Retry
// multi-quality" action, covering two real cases: a film originally
// uploaded with the toggle off (or before Slice 15 existed at all) that
// the admin later decides is worth the multi-quality treatment, and a
// failed ABR job needing a manual retry (the automatic stuck-job sweep
// deliberately never auto-retries ABR — see serviceController.
// reconcileStuckAbrJobs for why). Works from any prior abrStatus except
// "processing" (checked implicitly: dispatching again while one is
// already in flight would just waste a second job on the same film —
// the frontend already disables this button while processing, this is
// the server-side backstop).
async function generateAbr(req, res) {
  try {
    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: "Film not found" });
    if (!film.masterKey || !film.storageProvider) {
      return res
        .status(400)
        .json({ error: "This film has no master file to generate multi-quality streaming from" });
    }
    if (film.abrStatus === "processing") {
      return res.status(409).json({ error: "Multi-quality streaming is already being generated for this film" });
    }
    if (!film.sourceHeight || film.sourceHeight < ABR_MIN_SOURCE_HEIGHT) {
      return res.status(400).json({
        error: `This film's source resolution (${film.sourceHeight || "unknown"}p) is below the ${ABR_MIN_SOURCE_HEIGHT}p threshold required for multi-quality streaming.`,
      });
    }

    await triggerAbrTranscode(film._id, film.masterKey, film.storageProvider);
    film.abrRequested = true;
    film.abrStatus = "processing";
    film.abrStartedAt = new Date();
    film.abrError = undefined;
    await film.save();

    res.json(film);
  } catch (err) {
    console.error("Error generating multi-quality streaming:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to generate multi-quality streaming" });
  }
}

module.exports = { getUploadUrl, createUpload, retryProcessing, generateAbr };
