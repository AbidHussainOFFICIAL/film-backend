/**
 * backend/services/storageCapacityService.js
 *
 * A single shared place to release storage capacity that was reserved
 * or counted for an own-upload but shouldn't keep being charged against
 * a provider's free limit. Two independent cases, two functions:
 *
 * releaseReservedCapacity — for the ORIGINAL master file's size
 * (fileSizeBytes), reserved optimistically at upload time before the
 * bytes even exist (storageRouter.reserveUploadSlot). Before Slice 14
 * this exact release logic was copy-pasted in multiple places that all
 * needed the same guard — a film whose capacity was already released
 * must never have it released a second time, or a provider's usedBytes
 * drifts permanently negative.
 *
 * releaseAbrCapacity (Slice 15) — for the SEPARATE, much larger amount
 * added on top once an ABR job succeeds (abrOutputBytes) — the full HLS
 * ladder's total output size, which is never known upfront and is only
 * ever added once, by the ABR success callback, so unlike
 * releaseReservedCapacity it needs no "already released" guard: it's
 * simply a no-op if abrOutputBytes was never set in the first place.
 *
 * Both are best-effort, matching this project's pattern everywhere
 * else — a transient DB hiccup releasing capacity shouldn't block
 * whatever caller-side failure/deletion handling is already in
 * progress.
 */

const Sentry = require("@sentry/node");
const Provider = require("../models/Provider");

async function releaseReservedCapacity(film) {
  if (!film.storageProvider || typeof film.fileSizeBytes !== "number") return;

  try {
    await Provider.updateOne(
      { name: film.storageProvider },
      { $inc: { usedBytes: -film.fileSizeBytes } }
    );
  } catch (err) {
    console.error(
      `Failed to release reserved capacity for provider ${film.storageProvider} (film ${film._id}):`,
      err.message
    );
    Sentry.captureException(err);
  }
}

async function releaseAbrCapacity(film) {
  if (!film.storageProvider || typeof film.abrOutputBytes !== "number") return;

  try {
    await Provider.updateOne(
      { name: film.storageProvider },
      { $inc: { usedBytes: -film.abrOutputBytes } }
    );
  } catch (err) {
    console.error(
      `Failed to release ABR output capacity for provider ${film.storageProvider} (film ${film._id}):`,
      err.message
    );
    Sentry.captureException(err);
  }
}

module.exports = { releaseReservedCapacity, releaseAbrCapacity };
