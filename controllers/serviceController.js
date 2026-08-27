// backend/controllers/serviceController.js

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const JobRun = require("../models/JobRun");
const filmService = require("../services/filmService");
const ingestionService = require("../services/ingestionService");
const storage = require("../services/storage");
const { postFilmToTelegram } = require("../services/telegram");
const { postFilmToChannel } = require("../services/whatsapp");

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

// ---------------------------------------------------------------------
// Jobs — generic status reporting for ingest/qdrant-reindex JobRuns
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
    // centrally, since ingest.js/qdrantReindex.js scripts don't have
    // their own guaranteed-delivery way to report to Sentry directly
    // (a crash before their own capture code runs would go unseen).
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
    } else if (status === "completed") {
      if (!thumbKey || !previewKey) {
        return res.status(400).json({ error: "Missing thumbKey/previewKey for a completed callback" });
      }

      film.posterUrl = storage.getPublicUrl(thumbKey);
      film.previewUrl = storage.getPublicUrl(previewKey);
      film.streamUrl = storage.getPublicUrl(film.masterKey);
      film.downloadUrl = film.streamUrl;

      if (sourceHeight) film.sourceHeight = Number(sourceHeight);
      if (durationSeconds) film.runtime = Math.round(Number(durationSeconds) / 60);

      film.transcodeStatus = "completed";
      // Own uploads skip the moderation queue — the admin already vetted
      // this by choosing to upload it in the first place.
      film.status = "approved";
      film.verifiedDate = new Date();
    } else {
      film.transcodeStatus = "failed";
      console.error(`Media processing reported failure for film ${id}:`, error || "(no error message provided)");
      // Centralized capture point for process-upload.yml's failures — that
      // workflow is pure bash/ffmpeg, it has no way to call Sentry itself,
      // so this callback is the only place its failures become visible.
      Sentry.captureMessage(`Upload processing failed for film ${id}: ${error || "no error message"}`, "error");
    }

    await film.save();

    // Own-upload just auto-approved — post it, same best-effort pattern
    // as the manual-approval path in adminController.js.
    if (status === "completed") {
      try {
        await postFilmToTelegram(film);
      } catch (telegramErr) {
        console.error(`Telegram post failed for film ${id}:`, telegramErr.message);
        Sentry.captureException(telegramErr);
      }

      try {
        await postFilmToChannel(film);
      } catch (whatsappErr) {
        console.error(`WhatsApp post failed for film ${id}:`, whatsappErr.message);
        Sentry.captureException(whatsappErr);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Error handling upload callback:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to process callback" });
  }
}

module.exports = {
  checkExistingFilms,
  ingestBatch,
  listFilmsForEmbedding,
  startJob,
  completeJob,
  handleUploadCallback,
};
