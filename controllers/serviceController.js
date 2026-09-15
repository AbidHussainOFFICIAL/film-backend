// backend/controllers/serviceController.js

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const JobRun = require("../models/JobRun");
const Provider = require("../models/Provider");
const filmService = require("../services/filmService");
const ingestionService = require("../services/ingestionService");
const storage = require("../services/storage");
const { getAdapter } = require("../services/adapterRegistry");
const { postFilmToTelegram } = require("../services/telegram");
const { postFilmToChannel } = require("../services/whatsapp");
const { backupFilmToArchiveOrg } = require("../services/archiveBackup");
const { incrementCategoryCounts } = require("../services/categoryService");
const { triggerUploadProcessing, triggerAbrTranscode } = require("../services/githubActions");
const { releaseReservedCapacity } = require("../services/storageCapacityService");
const { withTimeout } = require("../utils/withTimeout");

// Fixed R2 key for the Android APK release asset — always overwritten in
// place by film-frontend's build-apk.yml workflow, so the public download
// URL never changes between builds. Overridable via env in case the key
// ever needs to move (e.g. a bucket reorganization).
const APK_STORAGE_KEY = process.env.APK_STORAGE_KEY || "releases/reel-vault.apk";
const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

// Hard ceiling for each best-effort post-approval side effect. See
// utils/withTimeout.js — a try/catch alone only protects against a
// THROW, not a HANG (WhatsApp's postFilmToChannel in particular can
// hang indefinitely if its persistent session isn't currently live).
const SIDE_EFFECT_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes

// Slice 14 — how long a film can sit in transcodeStatus: "processing"
// (measured from transcodeStartedAt, set at dispatch time) before the
// reconciliation sweep below treats it as stuck. process-upload.yml's
// own job has a hard timeout-minutes: 120 ceiling, so anything still
// "processing" well past that either hung, got killed, or its callback
// never arrived — 150 minutes gives a 30-minute buffer for callback
// delivery/network delay on top of that.
const STUCK_TRANSCODE_THRESHOLD_MS = 150 * 60 * 1000; // 150 minutes

// Slice 15 — same idea, for the much longer-running ABR job.
// abr-transcode.yml's own job has timeout-minutes: 300, so this uses the
// same "job's own ceiling + ~30 minute callback buffer" logic as above,
// just against the longer ceiling.
const STUCK_ABR_THRESHOLD_MS = 330 * 60 * 1000; // 330 minutes

// Slice 15 — the floor below which multi-quality streaming isn't
// attempted at all (nothing to ladder below this). Duplicated (in
// comment and value, not logic) in controllers/uploadController.js for
// the "Generate multi-quality" retry action's own validation — the two
// must be kept in sync if this ever changes.
const ABR_MIN_SOURCE_HEIGHT = 480;

// ---------------------------------------------------------------------
// Films — used by the ingest.yml and qdrant-reindex.yml workflows
// ---------------------------------------------------------------------

// POST /api/service/films/check-existing
// Body: { identifiers: string[], hashes: string[] }
async function checkExistingFilms(req, res) {
  try {
    const { identifiers, hashes } = req.body;
    const result = await ingestionService.checkExisting(identifiers, hashes);
    res.json(result);
  } catch (err) {
    console.error("Error checking existing films:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to check existing films" });
  }
}

// POST /api/service/films/ingest-batch
// Body: { films: [...], jobRunId?: string }
async function ingestBatch(req, res) {
  try {
    const { films = [], jobRunId } = req.body;

    const result = await ingestionService.insertBatch(films);
    await ingestionService.logIngestionRun({ itemsFound: films.length, ...result });

    if (jobRunId) {
      await JobRun.findByIdAndUpdate(jobRunId, {
        status: result.errored > 0 && result.inserted === 0 ? "failed" : "completed",
        result,
        completedAt: new Date(),
      }).catch((err) => console.error(`Could not update JobRun ${jobRunId}:`, err.message));
    }

    res.json(result);
  } catch (err) {
    console.error("Error ingesting batch:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to ingest batch" });
  }
}

// GET /api/service/films/for-embedding
async function listFilmsForEmbedding(req, res) {
  try {
    const films = await filmService.getFilmsForEmbedding();
    res.json(films);
  } catch (err) {
    console.error("Error listing films for embedding:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to list films for embedding" });
  }
}

// GET /api/service/films/for-link-check
// Used by film-media-worker's checkLinks.js — returns just enough for the
// heavy backend to HEAD-check every approved film's stream URL, without
// exposing anything else about the film.
async function listFilmsForLinkCheck(req, res) {
  try {
    const films = await Film.find(
      { status: "approved", streamUrl: { $exists: true, $ne: null } },
      { streamUrl: 1 }
    );
    res.json(films.map((f) => ({ filmId: f._id, streamUrl: f.streamUrl })));
  } catch (err) {
    console.error("Error listing films for link check:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to list films for link check" });
  }
}

// POST /api/service/films/link-health-batch
// Body: { results: [{ filmId, isHealthy, lastError? }] }
// Called once at the end of a checkLinks.js run with every result, rather
// than one request per film — cheaper and means a partial network blip
// mid-run can't leave some films updated and others not.
async function reportLinkHealthBatch(req, res) {
  try {
    const { results = [] } = req.body;
    const now = new Date();

    const operations = results.map((r) => ({
      updateOne: {
        filter: { _id: r.filmId },
        update: {
          $set: {
            "linkHealth.lastChecked": now,
            "linkHealth.isHealthy": !!r.isHealthy,
            "linkHealth.lastError": r.isHealthy ? undefined : r.lastError || "Unknown error",
          },
        },
      },
    }));

    if (operations.length > 0) {
      await Film.bulkWrite(operations);
    }

    res.json({ ok: true, updated: operations.length });
  } catch (err) {
    console.error("Error reporting link health batch:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to report link health batch" });
  }
}

// ---------------------------------------------------------------------
// Jobs — generic status reporting for ingest/qdrant-reindex/link-check JobRuns
// ---------------------------------------------------------------------

// POST /api/service/jobs/:id/start
async function startJob(req, res) {
  try {
    const job = await JobRun.findByIdAndUpdate(
      req.params.id,
      { status: "running", startedAt: new Date() },
      { new: true }
    );
    if (!job) return res.status(404).json({ error: "JobRun not found" });
    res.json(job);
  } catch (err) {
    console.error("Error starting job:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to start job" });
  }
}

// POST /api/service/jobs/:id/complete
// Body: { status: "completed"|"failed", result?, error? }
async function completeJob(req, res) {
  try {
    const { status, result, error } = req.body;
    if (!["completed", "failed"].includes(status)) {
      return res.status(400).json({ error: 'status must be "completed" or "failed"' });
    }

    const job = await JobRun.findByIdAndUpdate(
      req.params.id,
      { status, result, error, completedAt: new Date() },
      { new: true }
    );
    if (!job) return res.status(404).json({ error: "JobRun not found" });

    // The heavy backend reported this job as failed — capture it here
    // centrally, since ingest.js/qdrantReindex.js/checkLinks.js scripts
    // don't have their own guaranteed-delivery way to report to Sentry
    // directly (a crash before their own capture code runs would go
    // unseen).
    if (status === "failed") {
      Sentry.captureMessage(`JobRun ${job._id} (${job.type}) failed: ${error || "no error message"}`, "error");
    }

    res.json(job);
  } catch (err) {
    console.error("Error completing job:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to complete job" });
  }
}

// ---------------------------------------------------------------------
// Uploads — the process-upload.yml workflow's completion callback
// ---------------------------------------------------------------------

// Slice 15 — decides whether to dispatch the ABR job and mutates `film`
// in place accordingly (abrStatus/abrError/abrStartedAt). Called from
// handleUploadCallback's "completed" branch below, the moment
// sourceHeight becomes known — this is deliberately synchronous (not
// decoupled/fire-and-forget like runPostApprovalSideEffects further
// down): it's a single fast GitHub API dispatch call, the same kind of
// call triggerUploadProcessing already makes elsewhere in this codebase,
// not a potentially slow/hanging integration like Telegram/WhatsApp.
// Does not save() — the caller saves once, after this and every other
// field on `film` for this callback have been set.
async function decideAndDispatchAbr(film) {
  if (!film.abrRequested) {
    film.abrStatus = "not_applicable";
    return;
  }

  if (!film.sourceHeight || film.sourceHeight < ABR_MIN_SOURCE_HEIGHT) {
    film.abrStatus = "skipped";
    film.abrError = `Source resolution (${film.sourceHeight || "unknown"}p) is below the ${ABR_MIN_SOURCE_HEIGHT}p threshold for multi-quality streaming.`;
    return;
  }

  try {
    await triggerAbrTranscode(film._id, film.masterKey, film.storageProvider);
    film.abrStatus = "processing";
    film.abrStartedAt = new Date();
    film.abrError = undefined;
  } catch (dispatchErr) {
    console.error(`Failed to dispatch ABR transcode for film ${film._id}:`, dispatchErr.message);
    Sentry.captureException(dispatchErr);
    film.abrStatus = "failed";
    film.abrError = dispatchErr.message;
  }
}

// POST /api/service/uploads/:id/callback
// Body on start:    { status: "running" }
// Body on success:  { status: "completed", thumbKey, previewKey, sourceHeight?, durationSeconds? }
// Body on failure:  { status: "failed", error }
async function handleUploadCallback(req, res) {
  try {
    const { id } = req.params;
    const { status, thumbKey, previewKey, sourceHeight, durationSeconds, error } = req.body;

    const film = await Film.findById(id);
    if (!film) {
      return res.status(404).json({ error: "Film not found" });
    }

    if (status === "running") {
      film.transcodeStatus = "processing";
      await film.save();
      return res.json({ ok: true });
    }

    if (status === "completed") {
      if (!thumbKey || !previewKey) {
        return res.status(400).json({ error: "Missing thumbKey/previewKey for a completed callback" });
      }
      if (!film.storageProvider) {
        return res
          .status(400)
          .json({ error: "Film has no storageProvider recorded — cannot resolve public URLs" });
      }

      // Since Slice 12, thumb/preview/master might live on R2, B2, or
      // Storj — process-upload.yml always uploads them back to whichever
      // provider the master came from, so we resolve URLs through that
      // same provider's adapter rather than assuming R2.
      const adapter = getAdapter(film.storageProvider);

      film.posterUrl = adapter.getPublicUrl(thumbKey);
      film.previewUrl = adapter.getPublicUrl(previewKey);
      film.streamUrl = adapter.getPublicUrl(film.masterKey);
      film.downloadUrl = film.streamUrl;

      if (sourceHeight) film.sourceHeight = Number(sourceHeight);
      if (durationSeconds) film.runtime = Math.round(Number(durationSeconds) / 60);

      film.transcodeStatus = "completed";
      film.transcodeError = undefined;
      // Own uploads skip the moderation queue — the admin already vetted
      // this by choosing to upload it in the first place.
      film.status = "approved";
      film.verifiedDate = new Date();

      // Slice 15: now that sourceHeight is known, decide whether to
      // dispatch the separate ABR job. See decideAndDispatchAbr above.
      await decideAndDispatchAbr(film);

      await film.save();

      // Respond to the caller (process-upload.yml's "Report success to
      // backend" step) immediately, right after the film update is
      // safely persisted — do NOT make that curl call wait on Telegram,
      // WhatsApp, or the Archive.org backup below. Those can legitimately
      // take anywhere from seconds to several minutes (WhatsApp in
      // particular can hang far longer than that if its persistent
      // session isn't currently live — see services/whatsapp.js), and a
      // slow/hung side effect here should never be able to make CI think
      // the whole upload failed when the film itself already saved fine.
      res.json({ ok: true });

      runPostApprovalSideEffects(film).catch((err) => {
        // Should be unreachable — every branch inside already catches
        // its own errors — but guards against anything unexpected
        // slipping through as a genuinely unhandled rejection.
        console.error(`Unexpected error in post-approval side effects for film ${id}:`, err.message);
        Sentry.captureException(err);
      });
      return;
    }

    // status === "failed"
    // Capture whether this film was ALREADY marked failed before this
    // callback — if so, its reserved capacity was already released the
    // first time (see below), and a retry that fails again must not
    // release it a second time for a slot that was only ever reserved
    // once.
    const alreadyMarkedFailed = film.transcodeStatus === "failed";

    film.transcodeStatus = "failed";
    film.transcodeError = error || "Media processing reported failure with no error message";
    console.error(`Media processing reported failure for film ${id}:`, error || "(no error message provided)");
    // Centralized capture point for process-upload.yml's failures — that
    // workflow is pure bash/ffmpeg, it has no way to call Sentry itself,
    // so this callback is the only place its failures become visible.
    Sentry.captureMessage(`Upload processing failed for film ${id}: ${error || "no error message"}`, "error");
    await film.save();

    // Release the capacity reserved for this upload back to its
    // provider — storageRouter.reserveUploadSlot() increments usedBytes
    // optimistically, before processing even starts, so a failed run
    // must give that space back rather than permanently consuming quota
    // for a file that was never actually stored successfully.
    if (!alreadyMarkedFailed) {
      await releaseReservedCapacity(film);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error handling upload callback:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to process callback" });
  }
}

// Runs AFTER the callback has already responded — see the comment above
// where this is invoked. Every step here keeps its own try/catch, so a
// failure in one never affects the approval that already succeeded in
// Mongo, and never blocks the steps after it (see utils/withTimeout.js).
async function runPostApprovalSideEffects(film) {
  const id = film._id;

  // Fast, synchronous, no external network call — runs first and
  // unconditionally, no timeout needed.
  await incrementCategoryCounts(film.category);

  // Archive.org backup runs next — deliberately ordered ahead of
  // WhatsApp/Telegram so a hung or slow WhatsApp connection can never
  // delay this permanent-record backup. Best-effort like the rest.
  try {
    const identifier = await withTimeout(
      backupFilmToArchiveOrg(film),
      SIDE_EFFECT_TIMEOUT_MS,
      "Archive.org backup"
    );
    film.archiveBackup = {
      pushed: true,
      archiveIdentifier: identifier,
      pushedDate: new Date(),
      status: "completed",
    };
    await film.save();
  } catch (archiveErr) {
    console.error(`Archive.org backup failed for film ${id}:`, archiveErr.message);
    Sentry.captureException(archiveErr);
    film.archiveBackup = {
      pushed: false,
      status: "failed",
      error: archiveErr.message,
    };
    await film.save().catch(() => {});
  }

  try {
    await withTimeout(postFilmToChannel(film), SIDE_EFFECT_TIMEOUT_MS, "WhatsApp post");
    film.whatsappPost = { pushed: true, status: "completed", pushedDate: new Date() };
    await film.save().catch(() => {});
  } catch (whatsappErr) {
    console.error(`WhatsApp post failed for film ${id}:`, whatsappErr.message);
    Sentry.captureException(whatsappErr);
    film.whatsappPost = { pushed: false, status: "failed", error: whatsappErr.message };
    await film.save().catch(() => {});
  }

  try {
    await withTimeout(postFilmToTelegram(film), SIDE_EFFECT_TIMEOUT_MS, "Telegram post");
    film.telegramPost = { pushed: true, status: "completed", pushedDate: new Date() };
    await film.save().catch(() => {});
  } catch (telegramErr) {
    console.error(`Telegram post failed for film ${id}:`, telegramErr.message);
    Sentry.captureException(telegramErr);
    film.telegramPost = { pushed: false, status: "failed", error: telegramErr.message };
    await film.save().catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Slice 15 — ABR (adaptive bitrate) transcode callback
// ---------------------------------------------------------------------

// POST /api/service/uploads/:id/abr-callback
// Body on success: { status: "completed", manifestKey, renditions: [{resolution,height,bitrateKbps,key,segmentCount}], audioTracks: [{index,language,label,isDefault}], totalOutputBytes }
// Body on failure: { status: "failed", error }
//
// Entirely separate from handleUploadCallback above — this is the much
// longer-running, fully independent ABR job's own completion callback.
// A failure here NEVER touches the film's transcodeStatus, status
// (approved/pending/rejected), or its original direct-file playback —
// the film was already published by the fast thumbnail/preview job long
// before this callback ever arrives.
async function handleAbrCallback(req, res) {
  try {
    const { id } = req.params;
    const { status, manifestKey, renditions, audioTracks, totalOutputBytes, error } = req.body;

    const film = await Film.findById(id);
    if (!film) {
      return res.status(404).json({ error: "Film not found" });
    }

    if (status === "completed") {
      if (!manifestKey || !Array.isArray(renditions) || renditions.length === 0) {
        return res.status(400).json({ error: "Missing manifestKey/renditions for a completed ABR callback" });
      }
      if (!film.storageProvider) {
        return res
          .status(400)
          .json({ error: "Film has no storageProvider recorded — cannot resolve public URLs" });
      }

      const adapter = getAdapter(film.storageProvider);

      film.manifestUrl = adapter.getPublicUrl(manifestKey);
      film.renditions = renditions.map((r) => ({
        resolution: r.resolution,
        height: r.height,
        bitrateKbps: r.bitrateKbps,
        key: r.key,
        playlistUrl: adapter.getPublicUrl(r.key),
        segmentCount: r.segmentCount,
        codec: "h264",
      }));
      film.audioTracks = Array.isArray(audioTracks) ? audioTracks : [];
      film.abrStatus = "completed";
      film.abrError = undefined;

      if (typeof totalOutputBytes === "number") {
        film.abrOutputBytes = totalOutputBytes;
        // Counted against the provider now, for real, using the actual
        // reported size — unlike the master file's capacity (reserved
        // upfront, before the bytes exist, since that upload is
        // presigned and race-prone), there's no race to guard against
        // here: this is a backend-dispatched job whose outcome is only
        // known after the fact, so it's simply added once it's known.
        await Provider.updateOne(
          { name: film.storageProvider },
          { $inc: { usedBytes: totalOutputBytes } }
        ).catch((provErr) => {
          console.error(`Failed to account for ABR output size for film ${id}:`, provErr.message);
          Sentry.captureException(provErr);
        });
      }

      await film.save();
      return res.json({ ok: true });
    }

    // status === "failed"
    film.abrStatus = "failed";
    film.abrError = error || "ABR transcode reported failure with no error message";
    console.error(`ABR transcode failed for film ${id}:`, error || "(no error message provided)");
    Sentry.captureMessage(`ABR transcode failed for film ${id}: ${error || "no error message"}`, "error");
    await film.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error handling ABR callback:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to process ABR callback" });
  }
}

// ---------------------------------------------------------------------
// Slice 14/15 — stuck-job reconciliation (thumbnail/preview + ABR)
// ---------------------------------------------------------------------

// Thumbnail/preview jobs (Slice 14) — retries once via the same
// triggerUploadProcessing() dispatch used everywhere else in this app,
// then gives up and marks the film "failed" (releasing its reserved
// storage capacity) if it's still stuck on a second pass.
async function reconcileStuckTranscodeJobs() {
  const cutoff = new Date(Date.now() - STUCK_TRANSCODE_THRESHOLD_MS);
  const stuckFilms = await Film.find({
    transcodeStatus: "processing",
    transcodeStartedAt: { $lte: cutoff },
  });

  let retried = 0;
  let failed = 0;

  for (const film of stuckFilms) {
    const canRetry = film.transcodeRetryCount === 0 && film.masterKey && film.storageProvider;

    if (canRetry) {
      try {
        await triggerUploadProcessing(film._id, film.masterKey, film.storageProvider);
        film.transcodeStartedAt = new Date();
        film.transcodeRetryCount += 1;
        await film.save();
        retried += 1;
        continue;
      } catch (dispatchErr) {
        console.error(
          `Stuck-transcode retry dispatch failed for film ${film._id}:`,
          dispatchErr.message
        );
        Sentry.captureException(dispatchErr);
        // Falls through to give up below — a dispatch that fails
        // outright is no better than one that silently hangs.
      }
    }

    film.transcodeStatus = "failed";
    film.transcodeError =
      "Processing did not complete within the expected time, including one automatic retry.";
    await film.save();
    await releaseReservedCapacity(film);

    Sentry.captureMessage(
      `Stuck transcode gave up for film ${film._id} (retryCount: ${film.transcodeRetryCount})`,
      "error"
    );
    failed += 1;
  }

  return { checked: stuckFilms.length, retried, failed };
}

// ABR jobs (Slice 15) — deliberately NEVER auto-retried, unlike
// thumbnail/preview above. ABR jobs are far longer-running (up to 300
// minutes) and meaningfully more expensive per attempt than the fast
// thumbnail/preview job, so silently auto-retrying a job this costly on
// a timer is a real CI-minutes decision better left to the admin's
// explicit "Generate multi-quality" action (uploadController.generateAbr)
// than to an automatic sweep. A stuck ABR job goes straight to "failed"
// — the film's direct-file playback is completely unaffected either way,
// and no capacity needs releasing since ABR output bytes are only ever
// added on a SUCCESS callback, never reserved upfront.
async function reconcileStuckAbrJobs() {
  const cutoff = new Date(Date.now() - STUCK_ABR_THRESHOLD_MS);
  const stuckFilms = await Film.find({
    abrStatus: "processing",
    abrStartedAt: { $lte: cutoff },
  });

  let failed = 0;

  for (const film of stuckFilms) {
    film.abrStatus = "failed";
    film.abrError = "ABR transcode did not complete within the expected time.";
    await film.save();

    Sentry.captureMessage(`Stuck ABR job gave up for film ${film._id}`, "error");
    failed += 1;
  }

  return { checked: stuckFilms.length, retried: 0, failed };
}

// POST /api/service/transcodes/reconcile-stuck
//
// Called on a schedule by film-media-worker's reconcile-transcodes.yml
// (every 30 minutes) — not admin-triggerable and not a JobRun, this is a
// pure background maintenance sweep, same trust boundary as every other
// /api/service/* route (verifyServiceSecret, not Firebase). Covers both
// independent job types (thumbnail/preview, and Slice 15's ABR job) in
// one pass rather than two separate near-identical sweeps/endpoints.
async function reconcileStuckJobs(req, res) {
  try {
    const transcode = await reconcileStuckTranscodeJobs();
    const abr = await reconcileStuckAbrJobs();
    res.json({ transcode, abr });
  } catch (err) {
    console.error("Error reconciling stuck jobs:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to reconcile stuck jobs" });
  }
}

// ---------------------------------------------------------------------
// APK — used by film-frontend's build-apk.yml workflow
// ---------------------------------------------------------------------

// GET /api/service/apk/upload-url
async function getApkUploadUrl(req, res) {
  try {
    const result = await storage.getFixedUploadUrl(APK_STORAGE_KEY, APK_CONTENT_TYPE);
    res.json(result); // { uploadUrl, key, publicUrl }
  } catch (err) {
    console.error("Error generating APK upload URL:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to generate APK upload URL" });
  }
}

module.exports = {
  checkExistingFilms,
  ingestBatch,
  listFilmsForEmbedding,
  listFilmsForLinkCheck,
  reportLinkHealthBatch,
  startJob,
  completeJob,
  handleUploadCallback,
  handleAbrCallback,
  reconcileStuckJobs,
  getApkUploadUrl,
};
