/**
 * backend/services/storageCapacityService.js
 *
 * A single shared place to release storage capacity that was reserved
 * for an own-upload but never actually consumed (because processing
 * failed before or after it started). Before Slice 14 this exact
 * Provider.updateOne({ $inc: { usedBytes: -fileSizeBytes } }) block was
 * copy-pasted in three places that all needed the same guard — a film
 * whose capacity was already released must never have it released a
 * second time, or a provider's usedBytes drifts permanently negative.
 * Factored out here rather than adding a fourth copy for the new
 * stuck-transcode reconciliation sweep (services/serviceController.js's
 * reconcileStuckTranscodes).
 *
 * Best-effort, matching this project's pattern everywhere else — a
 * transient DB hiccup releasing capacity shouldn't block whatever
 * caller-side failure handling is already in progress (marking a film
 * failed, giving up on a stuck transcode, etc.).
 *
 * Callers are responsible for their own "was this already released"
 * guard before calling this — see controllers/serviceController.js's
 * handleUploadCallback (guards on transcodeStatus !== "failed" already
 * being true) and reconcileStuckTranscodes (safe by construction: a film
 * only ever matches the stuck-transcode query once, since giving up
 * flips its status away from "processing").
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

module.exports = { releaseReservedCapacity };
