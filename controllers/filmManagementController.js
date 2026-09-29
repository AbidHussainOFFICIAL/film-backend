// backend/controllers/filmManagementController.js

/**
 * Slice 13 — the actions that let an admin manage a film across its
 * whole lifecycle from /admin/films, not just moderate pending
 * submissions: Remove (unpublish an approved film), Restore (bring a
 * rejected film back), Delete (permanent, irreversible removal with
 * real storage/search cleanup), and, Slice 17, Retry backup (re-attempt
 * a failed Archive.org backup so a transient IA hiccup doesn't
 * permanently block that film's master-cleanup savings).
 *
 * Kept separate from adminController.js on purpose — approveFilm/
 * rejectFilm there are the pending-only moderation workflow; this file
 * is the heavier "manage everything" surface, and deleteFilm in
 * particular is substantial enough (see services/filmDeletionService.js)
 * that folding it into adminController.js would make that file harder
 * to follow.
 */

const Sentry = require("@sentry/node");
const { rejectOrRemoveFilm } = require("./adminController");
const filmService = require("../services/filmService");
const { incrementCategoryCounts } = require("../services/categoryService");
const { getEmbedding, buildEmbeddingText } = require("../services/embedding");
const { upsertFilmEmbedding } = require("../services/qdrantService");
const { deleteFilm: deleteFilmAndCleanUp } = require("../services/filmDeletionService");
const { backupFilmToArchiveOrg } = require("../services/archiveBackup");
const { maybeCleanupMaster } = require("../services/masterCleanupService");

// POST /api/admin/films/:id/remove
//
// "Remove" is the admin-facing name for unpublishing an approved film —
// underneath, this is the exact same status transition as Reject
// (approved -> rejected), reusing adminController's shared,
// status-aware rejectOrRemoveFilm() so the two routes can never drift
// out of sync. Kept as its own route (rather than just relabeling the
// existing Reject button when it's shown in /admin/films) because
// "Remove" and "Reject" are different admin-facing concepts, even though
// they currently do identical work underneath.
async function removeFilm(req, res) {
  try {
    const film = await rejectOrRemoveFilm(req.params.id, req.user?.email || req.user?.uid);
    if (!film) return res.status(404).json({ error: "Film not found" });
    res.json(film);
  } catch (err) {
    console.error("Error removing film:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to remove film" });
  }
}

// POST /api/admin/films/:id/restore
//
// Rejected -> approved. Deliberately does NOT re-run the full approval
// side-effect chain — nothing here should get announced/backed up a
// second time. The one exception: this film's Qdrant embedding was
// deleted when it was rejected (see adminController.rejectOrRemoveFilm),
// so restoring has to re-add it — otherwise the film would be visible
// on /browse again but permanently missing from search.
async function restoreFilm(req, res) {
  try {
    const { id } = req.params;

    const existing = await filmService.getFilmById(id);
    if (!existing) return res.status(404).json({ error: "Film not found" });
    if (existing.status !== "rejected") {
      return res.status(400).json({ error: "Only rejected films can be restored" });
    }

    const film = await filmService.setFilmStatus(id, "approved", {
      verifiedBy: req.user?.email || req.user?.uid,
      verifiedDate: new Date(),
    });

    // Symmetric with rejectOrRemoveFilm's decrement — fast, no external
    // network call, safe to await inline.
    await incrementCategoryCounts(film.category);

    // Best-effort re-embed, same pattern as approveFilm's embedding
    // step. Bounded by embedding.js's own internal fetch timeout
    // (15s), so there's no hang risk here that would justify decoupling
    // this from the response.
    try {
      const text = buildEmbeddingText(film);
      const vector = await getEmbedding(text, { taskType: "document" });
      await upsertFilmEmbedding(film._id, vector, { title: film.title, year: film.year });
    } catch (embedErr) {
      console.error(`Re-embedding failed for restored film ${film._id}:`, embedErr.message);
      Sentry.captureException(embedErr);
    }

    res.json(film);
  } catch (err) {
    console.error("Error restoring film:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to restore film" });
  }
}

// DELETE /api/admin/films/:id
//
// Permanent, irreversible deletion — real cleanup of everything this
// film owns (storage objects, captions, Qdrant embedding, reserved
// provider capacity, category count), then the Mongo document itself.
// See services/filmDeletionService.js for the full step-by-step
// breakdown and its best-effort-per-step reasoning. Deliberately does
// NOT touch the film's Archive.org backup copy, if it has one — IAS3 has
// no delete API; removal there is a manual moderation process. The
// frontend's confirmation dialog is responsible for stating this
// plainly before the admin ever reaches this endpoint.
async function deleteFilm(req, res) {
  try {
    const result = await deleteFilmAndCleanUp(req.params.id);
    if (!result) return res.status(404).json({ error: "Film not found" });
    res.json({ ok: true, steps: result.steps });
  } catch (err) {
    console.error("Error deleting film:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to delete film" });
  }
}

// POST /api/admin/films/:id/retry-backup
//
// Slice 17 — a single transient Internet Archive hiccup shouldn't
// permanently block a film's master file from ever being cleaned up
// (see masterCleanupService.js) — this gives the admin a manual way to
// re-attempt a FAILED Archive.org backup, reusing the exact same
// function the automatic post-approval flow already calls. Only
// meaningful when archiveBackup.status is "failed" — the frontend only
// ever shows this button in that state, and re-running it on an
// already-"completed" backup would just create a second, redundant
// Archive.org item for no reason, so this route rejects that case
// explicitly rather than silently doing needless work.
//
// A real Archive.org upload can take several minutes (see
// archiveBackup.js's own 10-minute internal timeout) — far too long to
// hold an admin's browser request open for, so this follows the same
// "respond immediately, do the slow work in the background" pattern
// used everywhere else in this codebase for exactly this reason.
async function retryArchiveBackup(req, res) {
  try {
    const film = await filmService.getFilmById(req.params.id);
    if (!film) return res.status(404).json({ error: "Film not found" });
    if (film.archiveBackup?.status !== "failed") {
      return res.status(400).json({
        error: 'Archive.org backup can only be retried when its current status is "failed".',
      });
    }

    film.archiveBackup.status = "pending";
    film.archiveBackup.startedAt = new Date();
    await film.save();
    res.json(film);

    runArchiveBackupRetry(film).catch((err) => {
      console.error(`Unexpected error retrying Archive.org backup for film ${film._id}:`, err.message);
      Sentry.captureException(err);
    });
  } catch (err) {
    console.error("Error retrying Archive.org backup:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to retry Archive.org backup" });
  }
}

async function runArchiveBackupRetry(film) {
  try {
    const identifier = await backupFilmToArchiveOrg(film);
    film.archiveBackup = {
      pushed: true,
      archiveIdentifier: identifier,
      pushedDate: new Date(),
      status: "completed",
    };
    await film.save();
  } catch (backupErr) {
    console.error(`Retry of Archive.org backup failed for film ${film._id}:`, backupErr.message);
    Sentry.captureException(backupErr);
    film.archiveBackup = { pushed: false, status: "failed", error: backupErr.message };
    await film.save().catch(() => {});
    return;
  }

  // This may be the second of the two conditions maybeCleanupMaster
  // checks (see that file) — safe to call unconditionally either way.
  await maybeCleanupMaster(film._id);
}

module.exports = { removeFilm, restoreFilm, deleteFilm, retryArchiveBackup };
