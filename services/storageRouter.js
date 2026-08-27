/**
 * backend/services/storageRouter.js
 *
 * Decides which storage provider a new own-upload's master file should
 * land on, based on remaining free capacity and priority order — instead
 * of every upload hardcoding R2. Selection happens once, at
 * getUploadUrl-request time (see controllers/uploadController.js):
 * usedBytes is incremented immediately when a provider is chosen, not
 * later when the upload actually completes, keeping the accounting
 * simple and synchronous rather than eventually-consistent.
 *
 * A small race window exists if two uploads are requested at nearly the
 * same instant (both could read "has room" before either's usedBytes
 * update lands) — accepted as harmless at this scale: worst case a
 * provider goes slightly over its own soft free-tier limit by one
 * file's size, self-correcting on the next selection.
 */

const crypto = require("crypto");
const Provider = require("../models/Provider");
const { getAdapter } = require("./adapterRegistry");

/**
 * Builds a collision-safe object key from a user-supplied filename —
 * shared across all providers so the same key format works regardless of
 * which one gets picked.
 */
function buildKey(filename) {
  const safeName = String(filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `uploads/${crypto.randomUUID()}-${safeName}`;
}

/**
 * Returns the first active Provider (by priority, ascending) with enough
 * remaining free capacity for a file of the given size. Throws (with
 * `.code = "NO_CAPACITY"`) if none qualify — callers should surface this
 * as a clear, distinguishable error rather than silently defaulting to
 * one provider, since exceeding every free tier at once is a real
 * operational signal worth noticing.
 */
async function selectProvider(fileSizeBytes) {
  const candidates = await Provider.find({ isActive: true }).sort({ priority: 1 });

  const chosen = candidates.find((p) => p.usedBytes + fileSizeBytes <= p.freeLimitBytes);

  if (!chosen) {
    const err = new Error(
      "No storage provider has enough free capacity for this upload. " +
        "Check /admin/storage — every active provider is at or near its limit."
    );
    err.code = "NO_CAPACITY";
    throw err;
  }

  return chosen;
}

/**
 * Picks a provider, reserves capacity for it ($inc'd immediately, not
 * after the upload completes — see file header), and returns everything
 * the upload controller needs to hand back to the browser.
 */
async function reserveUploadSlot(filename, contentType, fileSizeBytes) {
  const provider = await selectProvider(fileSizeBytes);
  const adapter = getAdapter(provider.name);
  const key = buildKey(filename);

  const { uploadUrl, publicUrl } = await adapter.getUploadUrl(key, contentType);

  await Provider.updateOne({ _id: provider._id }, { $inc: { usedBytes: fileSizeBytes } });

  return { uploadUrl, key, publicUrl, storageProvider: provider.name };
}

module.exports = { selectProvider, reserveUploadSlot, buildKey };