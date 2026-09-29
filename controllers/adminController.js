// backend/controllers/adminController.js

const Sentry = require("@sentry/node");
const filmService = require("../services/filmService");
const { getEmbedding, buildEmbeddingText } = require("../services/embedding");
const { upsertFilmEmbedding, deleteFilmEmbedding } = require("../services/qdrantService");
const { incrementCategoryCounts, decrementCategoryCounts } = require("../services/categoryService");

const VALID_STATUSES = ["pending", "approved", "rejected", "all"];

// GET /api/admin/films?status=pending
// "all" (Slice 13) returns every film regardless of status — backs
// /admin/films, the "manage everything" view. Kept as a query-param
// value on this same route rather than a new endpoint, since it's the
// same underlying resource just without a status filter.
async function listFilmsByStatus(req, res) {
  try {
    const status = req.query.status || "pending";
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }
    const films =
      status === "all" ? await filmService.getAllFilms() : await filmService.getFilmsByStatus(status);
    res.json(films);
  } catch (err) {
    console.error("Error listing films by status:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to fetch films" });
  }
}

// GET /api/admin/films/unhealthy
// Approved films whose last link-health check (see
// scripts/checkLinks.js, run weekly) came back unhealthy — surfaced
// separately from the pending queue since these need a different kind
// of review (a dead link, not a moderation decision).
async function listUnhealthyFilms(req, res) {
  try {
    const films = await filmService.getUnhealthyFilms();
    res.json(films);
  } catch (err) {
    console.error("Error listing unhealthy films:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to fetch unhealthy films" });
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
    // wait on the Qdrant embedding step below, which can occasionally be
    // slow. A slow/hung side effect here should never be able to leave
    // the admin staring at a stuck "Approving…" button when the
    // approval itself already succeeded.
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
// failure in one never affects the approval that already succeeded in
// Mongo. This path is for archive.org-sourced (and any manually-approved
// pending) films only — own-uploads auto-approve through a separate path
// (see serviceController.js's own runPostApprovalSideEffects), which is
// also the only place Archive.org backup / master-cleanup logic applies,
// since only own-uploads ever have a storageProvider/masterKey to begin
// with.
async function runPostApprovalSideEffects(film) {
  // Fast, synchronous, no external network call — runs first and
  // unconditionally, no timeout needed.
  await incrementCategoryCounts(film.category);

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
}

// POST /api/admin/films/:id/reject
//
// The pending-only /admin/queue's Reject button. Shares its core logic
// with "Remove" (filmManagementController.removeFilm, Slice 13) via
// rejectOrRemoveFilm below — see that function's comment for why the two
// are one implementation behind two distinct routes.
async function rejectFilm(req, res) {
  try {
    const film = await rejectOrRemoveFilm(req.params.id, req.user?.email || req.user?.uid);
    if (!film) return res.status(404).json({ error: "Film not found" });
    res.json(film);
  } catch (err) {
    console.error("Error rejecting film:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to reject film" });
  }
}

// Core status-transition logic shared by Reject (this file, called from
// the pending-only /admin/queue) and Remove
// (filmManagementController.removeFilm, called from /admin/films on an
// already-approved film, Slice 13). Kept in one place so the two routes
// can never drift out of sync with each other — "Reject" and "Remove"
// are different admin-facing concepts, but underneath they're the exact
// same transition: flip status to rejected, clean up the film's Qdrant
// embedding, and decrement Category.filmCount ONLY if the film was
// actually approved before this call. That guard is what makes it safe
// to call this on an approved film too, as of Slice 13 — a still-pending
// film was never counted in the first place, so rejecting one must never
// decrement anything.
//
// Left as a synchronous await chain (not decoupled from the caller like
// approveFilm's side effects above) — deleteFilmEmbedding() already
// swallows its own errors internally (see qdrantService.js) and
// decrementCategoryCounts() does too (see categoryService.js); neither
// is a slow external chain with a known hang risk, so there's nothing
// here that needs decoupling from the response.
async function rejectOrRemoveFilm(filmId, verifiedBy) {
  const existing = await filmService.getFilmById(filmId);
  if (!existing) return null;

  const wasApproved = existing.status === "approved";

  const film = await filmService.setFilmStatus(filmId, "rejected", {
    verifiedBy,
    verifiedDate: new Date(),
  });

  // Best-effort: if this film was previously approved and indexed, make
  // sure it stops showing up in search now that it's rejected.
  await deleteFilmEmbedding(film._id);

  if (wasApproved) {
    await decrementCategoryCounts(film.category);
  }

  return film;
}

module.exports = {
  listFilmsByStatus,
  listUnhealthyFilms,
  approveFilm,
  rejectFilm,
  rejectOrRemoveFilm,
};
