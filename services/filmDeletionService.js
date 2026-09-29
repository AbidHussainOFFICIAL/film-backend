// backend/services/filmDeletionService.js

/**
 * Permanent, irreversible film deletion (Slice 13) — the real cleanup
 * work behind DELETE /api/admin/films/:id (see
 * controllers/filmManagementController.js, which stays a thin wrapper
 * around this). Every step here is best-effort, matching this project's
 * pattern everywhere else: a failure in any single cleanup step never
 * blocks the film from actually being deleted — the Mongo document is
 * always removed LAST, once every other cleanup attempt has run, whether
 * or not it succeeded.
 *
 * Each step's outcome is returned in `steps` so the caller can surface a
 * partial-failure warning instead of a blanket "deleted successfully"
 * when something (e.g. an orphaned storage object) may need manual
 * follow-up.
 *
 * Deliberately does NOT touch the film's Archive.org backup copy, if it
 * has one (archiveBackup.pushed) — IAS3 has no delete API; removal there
 * is a manual moderation process on archive.org itself, not something
 * this app can automate. The admin-facing delete confirmation is
 * responsible for stating this plainly before this function is ever
 * called.
 *
 * Thumbnail/preview/captions object keys: only their public URLs were
 * ever stored at creation time, so while a film still has its masterKey
 * they're derived from it using the fixed naming convention already used
 * to create them:
 *   - thumb:    {base}-thumb.jpg      (film-media-worker's process-upload.yml)
 *   - preview:  {base}-preview.mp4    (same)
 *   - captions: {base}-captions.vtt   (controllers/uploadController.js's createUpload)
 * where {base} is masterKey with its file extension stripped.
 *
 * Slice 18 — once masterCleanupService.js deletes a master and clears
 * masterKey, that derivation is no longer possible, so the cleanup
 * records all three keys on the film at that moment (Film.thumbKey /
 * previewKey / captionsKey) and this file prefers those stored keys.
 * Either way, every own-upload's thumbnail, preview and captions are
 * found and removed — nothing is left orphaned.
 *
 * Slice 15 addition: an ABR-generated HLS ladder lives under
 * uploads/{filmId}/hls/ (see film-media-worker's abr-transcode.yml) — a
 * whole folder of files (including, Slice 17, the flat top_quality.mp4
 * download file), not a single key, and keyed directly by the film's
 * own _id, so it never depends on masterKey at all. Cleaned up via
 * StorageAdapter.deletePrefix(), and its counted storage capacity
 * (abrOutputBytes) released separately from the master file's own
 * capacity release below.
 */

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const Provider = require("../models/Provider");
const { getAdapter } = require("./adapterRegistry");
const R2Adapter = require("../adapters/R2Adapter");
const { deleteFilmEmbedding } = require("./qdrantService");
const { decrementCategoryCounts } = require("./categoryService");
const { releaseAbrCapacity } = require("./storageCapacityService");

function baseKeyOf(masterKey) {
  return masterKey.replace(/\.[^/.]+$/, "");
}

// Stored key (Slice 18, set at master-cleanup time) if there is one,
// otherwise derived from masterKey while the master still exists, or
// null if neither is possible (an archive.org film, which has none of
// these files at all).
function resolveDerivedKeys(film) {
  const base = film.masterKey ? baseKeyOf(film.masterKey) : null;
  return {
    thumbKey: film.thumbKey || (base ? `${base}-thumb.jpg` : null),
    previewKey: film.previewKey || (base ? `${base}-preview.mp4` : null),
    captionsKey: film.captionsKey || (base ? `${base}-captions.vtt` : null),
  };
}

// Must match the prefix film-media-worker's abr-transcode.yml uploads
// its output to — see that workflow's "Upload HLS output to storage"
// step. Keyed by film._id alone, independent of masterKey.
function hlsPrefixOf(filmId) {
  return `uploads/${filmId}/hls/`;
}

/**
 * Deletes a film and everything it owns. Returns `null` if no film with
 * that id exists (mirrors filmService's other lookup functions);
 * otherwise returns `{ film, steps }` — `film` is the now-deleted
 * document as it was immediately before deletion (for the caller to
 * log/report with), `steps` records the outcome of each best-effort
 * cleanup step: each value is "ok", "partial", "failed", or "skipped"
 * (skipped meaning the step didn't apply to this film at all — e.g. an
 * archive.org-sourced film has no storageProvider to clean up, an
 * own-upload whose master was already cleaned up has no master file
 * left to delete or capacity left to release, or a film whose ABR job
 * never ran has no HLS folder or output bytes to release).
 */
async function deleteFilm(filmId) {
  const film = await Film.findById(filmId);
  if (!film) return null;

  const steps = {
    masterDelete: "skipped",
    thumbPreviewDelete: "skipped",
    captionsDelete: "skipped",
    hlsCleanup: "skipped",
    capacityRelease: "skipped",
    abrCapacityRelease: "skipped",
    qdrantDelete: "skipped",
    categoryDecrement: "skipped",
  };

  const hasMasterKey = Boolean(film.storageProvider && film.masterKey);
  // storageProvider is deliberately never cleared even after the master
  // itself is (see masterCleanupService.js), so this adapter is still
  // resolvable for every step below regardless of masterKey.
  const adapter = film.storageProvider ? getAdapter(film.storageProvider) : null;
  const { thumbKey, previewKey, captionsKey } = resolveDerivedKeys(film);

  // --- 1. Master file (only while it still exists) ---
  if (hasMasterKey) {
    try {
      await adapter.delete(film.masterKey);
      steps.masterDelete = "ok";
    } catch (err) {
      console.error(`Master file delete failed for film ${filmId}:`, err.message);
      Sentry.captureException(err);
      steps.masterDelete = "failed";
    }
  }

  if (adapter) {
    // --- 2. Thumbnail + preview ---
    // Attempted independently so one succeeding while the other fails
    // (or was never generated in the first place, e.g. a film whose
    // transcode never completed) doesn't hide the one that did work.
    let thumbOk = false;
    let previewOk = false;
    if (thumbKey) {
      try {
        await adapter.delete(thumbKey);
        thumbOk = true;
      } catch (err) {
        // Not unexpected on its own — plenty of films never had a
        // completed transcode to generate one.
        console.warn(`Thumbnail delete failed for film ${filmId}:`, err.message);
      }
    }
    if (previewKey) {
      try {
        await adapter.delete(previewKey);
        previewOk = true;
      } catch (err) {
        console.warn(`Preview delete failed for film ${filmId}:`, err.message);
      }
    }
    if (thumbKey || previewKey) {
      steps.thumbPreviewDelete = thumbOk && previewOk ? "ok" : thumbOk || previewOk ? "partial" : "failed";
    }

    // --- 3. Captions — always R2, regardless of storageProvider ---
    if (captionsKey) {
      try {
        await R2Adapter.delete(captionsKey);
        steps.captionsDelete = "ok";
      } catch (err) {
        // Not unexpected — captioning is itself best-effort at upload
        // time (see uploadController.createUpload), so plenty of films
        // never had a captions file to begin with.
        console.warn(`Captions delete failed for film ${filmId}:`, err.message);
        steps.captionsDelete = "failed";
      }
    }

    // --- 4. HLS ladder folder (Slice 15/17) ---
    // Independent of masterKey entirely. Attempted whenever the film
    // has a storage provider at all, regardless of abrStatus — a failed
    // or still-processing ABR run can still have left partial output in
    // storage, and deletePrefix() is a safe no-op if the prefix never
    // existed.
    try {
      await adapter.deletePrefix(hlsPrefixOf(film._id));
      steps.hlsCleanup = "ok";
    } catch (err) {
      console.error(`HLS folder cleanup failed for film ${filmId}:`, err.message);
      Sentry.captureException(err);
      steps.hlsCleanup = "failed";
    }
  }

  // --- 5. Release reserved master-file capacity — unless already
  // released ---
  // A "failed" transcodeStatus means one of the two existing
  // failure-handling paths (serviceController.handleUploadCallback or
  // uploadController.createUpload's dispatch-failure branch) already
  // released this film's reserved capacity back to its provider. Gated
  // on hasMasterKey too: if the master was already cleaned up by
  // masterCleanupService.js, that function already released this exact
  // capacity when it deleted the file — releasing it again here would
  // double-release quota that was only ever reserved once.
  if (hasMasterKey && film.transcodeStatus !== "failed" && typeof film.fileSizeBytes === "number") {
    try {
      await Provider.updateOne(
        { name: film.storageProvider },
        { $inc: { usedBytes: -film.fileSizeBytes } }
      );
      steps.capacityRelease = "ok";
    } catch (err) {
      console.error(`Capacity release failed for film ${filmId}:`, err.message);
      Sentry.captureException(err);
      steps.capacityRelease = "failed";
    }
  }

  // --- 6. Release ABR output capacity (Slice 15) ---
  // Independent of hasMasterKey above — releaseAbrCapacity internally
  // no-ops if abrOutputBytes was never set, so it's safe to always
  // attempt. No "already released" guard needed here the way step 5
  // needs one: abrOutputBytes is a single running total (a
  // regeneration adjusts it by the difference — see
  // serviceController.handleAbrCallback), so it's only ever released
  // once, here.
  try {
    await releaseAbrCapacity(film);
    steps.abrCapacityRelease = typeof film.abrOutputBytes === "number" ? "ok" : "skipped";
  } catch (err) {
    // releaseAbrCapacity already logs/captures its own errors internally
    // and never throws — this catch exists only as a defensive backstop.
    steps.abrCapacityRelease = "failed";
  }

  // --- 7. Qdrant embedding — runs regardless of storage/source, since
  // any approved film (archive.org or own-upload) can be indexed. ---
  await deleteFilmEmbedding(film._id);
  steps.qdrantDelete = "ok";

  // --- 8. Category count — only if this film was actually counted ---
  if (film.status === "approved") {
    await decrementCategoryCounts(film.category);
    steps.categoryDecrement = "ok";
  }

  // --- 9. The Mongo document itself, last — always runs, regardless of
  // how any step above went. ---
  await Film.findByIdAndDelete(filmId);

  return { film, steps };
}

module.exports = { deleteFilm };
