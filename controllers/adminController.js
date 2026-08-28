// backend/controllers/adminController.js

const Sentry = require("@sentry/node");
const filmService = require("../services/filmService");
const { getEmbedding, buildEmbeddingText } = require("../services/embedding");
const { upsertFilmEmbedding, deleteFilmEmbedding } = require("../services/qdrantService");
const { postFilmToTelegram } = require("../services/telegram");
const { postFilmToChannel } = require("../services/whatsapp");

const VALID_STATUSES = ["pending", "approved", "rejected"];

// GET /api/admin/films?status=pending
async function listFilmsByStatus(req, res) {
  try {
    const status = req.query.status || "pending";
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }
    const films = await filmService.getFilmsByStatus(status);
    res.json(films);
  } catch (err) {
    console.error("Error listing films by status:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to fetch films" });
  }
}

// POST /api/admin/films/:id/approve
async function approveFilm(req, res) {
  try {
    const film = await filmService.setFilmStatus(req.params.id, "approved", {
      verifiedBy: req.user?.email || req.user?.uid,
      verifiedDate: new Date(),
    });
    if (!film) return res.status(404).json({ error: "Film not found" });

    // Respond to the admin's browser immediately, right after the
    // approval itself is safely persisted — do NOT make that request
    // wait on Qdrant embedding, Telegram, or WhatsApp below. Any of
    // these can be slow, and WhatsApp in particular can hang far longer
    // than a browser request should reasonably stay open if its
    // persistent session isn't currently live (see services/whatsapp.js).
    // A slow/hung side effect here should never be able to leave the
    // admin staring at a stuck "Approving…" button when the approval
    // itself already succeeded. Same fix, same reasoning, as
    // serviceController.js's handleUploadCallback.
    res.json(film);

    runPostApprovalSideEffects(film).catch((err) => {
      // Should be unreachable — every branch inside already catches its
      // own errors — but guards against anything unexpected slipping
      // through as a genuinely unhandled rejection.
      console.error(`Unexpected error in post-approval side effects for film ${film._id}:`, err.message);
      Sentry.captureException(err);
    });
  } catch (err) {
    console.error("Error approving film:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to approve film" });
  }
}

// Runs AFTER approveFilm has already responded — see the comment above
// where this is invoked. Every step here keeps its own try/catch, so a
// failure in one (or all three) never affects the approval that already
// succeeded in Mongo.
async function runPostApprovalSideEffects(film) {
  // Index into Qdrant for semantic search. Best-effort: the film is
  // already approved in Mongo at this point, so a failure here (missing
  // API key, Nomic/Qdrant hiccup) shouldn't roll that back — it just
  // means this title won't turn up in search until it's re-indexed.
  try {
    const text = buildEmbeddingText(film);
    const vector = await getEmbedding(text, { taskType: "document" });
    await upsertFilmEmbedding(film._id, vector, {
      title: film.title,
      year: film.year,
    });
  } catch (embedErr) {
    console.error(`Embedding/indexing failed for film ${film._id}:`, embedErr.message);
    Sentry.captureException(embedErr);
  }

  // Post to the Telegram channel. Best-effort — a failure here (bad
  // bot token, self-hosted server down, channel permissions) shouldn't
  // undo the approval, it just means this title didn't get announced.
  try {
    await postFilmToTelegram(film);
  } catch (telegramErr) {
    console.error(`Telegram post failed for film ${film._id}:`, telegramErr.message);
    Sentry.captureException(telegramErr);
  }

  // Post to the WhatsApp channel. Best-effort like Telegram — a
  // failure here (not paired, channel JID wrong) shouldn't undo the
  // approval.
  try {
    await postFilmToChannel(film);
  } catch (whatsappErr) {
    console.error(`WhatsApp post failed for film ${film._id}:`, whatsappErr.message);
    Sentry.captureException(whatsappErr);
  }
}

// POST /api/admin/films/:id/reject
//
// Left as a synchronous await chain (not decoupled like approveFilm
// above) — deleteFilmEmbedding() already swallows its own errors
// internally (see qdrantService.js) and is a single fast Qdrant call,
// not a multi-integration chain with a known hang risk like WhatsApp.
async function rejectFilm(req, res) {
  try {
    const film = await filmService.setFilmStatus(req.params.id, "rejected", {
      verifiedBy: req.user?.email || req.user?.uid,
      verifiedDate: new Date(),
    });
    if (!film) return res.status(404).json({ error: "Film not found" });

    // Best-effort: if this film was previously approved and indexed, make
    // sure it stops showing up in search now that it's rejected.
    await deleteFilmEmbedding(film._id);

    res.json(film);
  } catch (err) {
    console.error("Error rejecting film:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to reject film" });
  }
}

module.exports = {
  listFilmsByStatus,
  approveFilm,
  rejectFilm,
};
