/**
 * backend/services/masterCleanupService.js
 *
 * Slice 17 — once an own-upload's multi-quality (ABR) ladder has
 * completed AND its Archive.org backup has succeeded, the original
 * master file no longer needs to sit in R2/B2/Storj: the HLS ladder is
 * now the playback copy, the flat top_quality.mp4 uploaded alongside it
 * (see film-media-worker's buildAbrLadder.sh) is the download copy, and
 * Archive.org holds the true original as an off-site backup. Keeping
 * the master too was the single biggest driver of storage consumption
 * identified in the Slice 14-16 review (up to 2-4x a film's real size
 * per own-upload) — this is the fix.
 *
 * Three independent triggers can find every condition satisfied, and
 * whichever does first performs the deletion: the Archive.org backup
 * step (serviceController.runPostApprovalSideEffects, or the admin's
 * Retry backup), the ABR success callback (serviceController.
 * handleAbrCallback), and — Slice 18 — a periodic reconciliation sweep
 * (serviceController.reconcileMasterCleanup) that retries any film whose
 * backup couldn't be verified yet the last time around.
 *
 * Always re-fetches the film fresh by id (never trusts a caller's
 * possibly-stale in-memory document), and uses an atomic, conditional
 * findOneAndUpdate as its own idempotency guard — so even if two
 * triggers reach this within the same instant, only one of them
 * actually deletes the storage object and flips masterDeletedAt.
 *
 * Deliberately never applies to archive.org-sourced films: those never
 * have a storageProvider/masterKey at all (their streamUrl already
 * points directly at archive.org from ingestion — see worker/scripts/
 * ingest.js) and never have an ABR ladder either. The storageProvider/
 * masterKey check below is what makes this a correct no-op for them,
 * not a special case that needs separate handling.
 *
 * Also never applies to a film where ABR was skipped or never
 * requested (sub-480p source, or the admin's upload-form toggle was
 * off) — for those, the master is the ONLY playback copy that exists,
 * so abrStatus must be exactly "completed", never merely "not failed".
 *
 * Slice 18 — the Archive.org backup is VERIFIED against archive.org
 * itself (verifyArchiveOrgBackup) before anything is deleted: the app's
 * own status field only records that an upload request returned success,
 * not that the file is really there.
 *
 * Best-effort like every other side effect in this codebase: a failure
 * here is logged/reported but never thrown — it just means the master
 * stays around longer than ideal, which is always the safe failure
 * direction (never delete on uncertainty).
 *
 * Returns "cleaned" when this call deleted the master, otherwise a short
 * reason string ("not_eligible", "unverified", "already_handled",
 * "error") that the reconciliation sweep uses for its counts.
 */

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const { getAdapter } = require("./adapterRegistry");
const { releaseReservedCapacity } = require("./storageCapacityService");
const { verifyArchiveOrgBackup } = require("./archiveBackup");

// Same fixed naming convention film-media-worker's process-upload.yml
// (thumb/preview) and uploadController.createUpload (captions) use.
// Recorded on the film at cleanup time — see Film.thumbKey's comment.
function baseKeyOf(masterKey) {
  return masterKey.replace(/\.[^/.]+$/, "");
}

async function maybeCleanupMaster(filmId) {
  const film = await Film.findById(filmId);
  if (!film) return "not_eligible";

  // Archive.org films (no storageProvider/masterKey at all), and
  // own-uploads whose master was already cleaned up by an earlier call
  // to this function, both correctly fall out here.
  if (!film.storageProvider || !film.masterKey) return "not_eligible";

  // Not yet eligible: no ladder to stand in for direct-file playback
  // ("skipped"/"not_applicable"/"processing"/"failed" all mean the
  // master is still the only or authoritative copy).
  if (film.abrStatus !== "completed") return "not_eligible";

  // Not yet eligible: no off-site copy of the true original recorded.
  if (film.archiveBackup?.status !== "completed") return "not_eligible";

  // Already handled by another trigger.
  if (film.masterDeletedAt) return "already_handled";

  if (!film.topQualityKey) {
    // A film whose ladder finished before top_quality.mp4 existed
    // (pre-Slice-17), or — should not happen — a callback that somehow
    // omitted it. Refusing to proceed is the safe direction: never
    // delete the master without a replacement download file already in
    // hand. The admin's "Regenerate multi-quality" produces one.
    return "not_eligible";
  }

  // Slice 18 — trust archive.org's own view of what it holds, not just
  // our record that an upload call returned success.
  const verified = await verifyArchiveOrgBackup(film);
  if (!verified) {
    console.warn(
      `Master cleanup deferred for film ${filmId}: Archive.org backup not verified yet (will be retried by the reconciliation sweep).`
    );
    return "unverified";
  }

  let adapter;
  let newDownloadUrl;
  try {
    adapter = getAdapter(film.storageProvider);
    newDownloadUrl = adapter.getPublicUrl(film.topQualityKey);
  } catch (err) {
    console.error(`Could not resolve storage adapter/top-quality URL for film ${filmId}:`, err.message);
    Sentry.captureException(err);
    return "error";
  }

  const base = baseKeyOf(film.masterKey);

  // Atomic, conditional update — the real idempotency guard. If two
  // triggers race, only the first to reach this actually matches a
  // document (masterDeletedAt still unset); the second sees `updated`
  // come back null and does nothing further. storageProvider is
  // deliberately left untouched — the HLS folder and every future
  // lookup are keyed by film._id + storageProvider, never by masterKey.
  const updated = await Film.findOneAndUpdate(
    { _id: filmId, masterDeletedAt: { $exists: false } },
    {
      $set: {
        masterDeletedAt: new Date(),
        downloadUrl: newDownloadUrl,
        thumbKey: `${base}-thumb.jpg`,
        previewKey: `${base}-preview.mp4`,
        captionsKey: `${base}-captions.vtt`,
      },
      $unset: { masterKey: "", streamUrl: "" },
    },
    { new: false }
  );
  if (!updated) return "already_handled";

  try {
    await adapter.delete(film.masterKey);
    // Only release the reserved capacity once the physical delete has
    // actually succeeded — releasing it on a failed delete would free
    // up quota for space that's still genuinely occupied.
    await releaseReservedCapacity(film);
  } catch (err) {
    // The DB has already moved on (masterKey cleared) even if the
    // physical delete fails here — logged for manual follow-up rather
    // than retried automatically, matching this project's existing
    // best-effort pattern (e.g. filmDeletionService.js's per-step
    // handling).
    console.error(`Failed to delete master object for film ${filmId} from storage:`, err.message);
    Sentry.captureException(err);
    return "error";
  }

  return "cleaned";
}

module.exports = { maybeCleanupMaster };
