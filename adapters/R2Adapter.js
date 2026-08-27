/**
 * backend/adapters/R2Adapter.js
 *
 * Cloudflare R2 adapter. Deliberately a thin wrapper around the existing
 * services/storage.js — that file already has R2's client/credential
 * setup fully working (proven by the APK upload flow and every own-upload
 * before this slice), so this adapter reuses it directly instead of
 * duplicating an S3 client + credentials a second time.
 */

const StorageAdapter = require("./StorageAdapter");
const storage = require("../services/storage");

class R2Adapter extends StorageAdapter {
  async getUploadUrl(key, contentType) {
    return storage.getFixedUploadUrl(key, contentType);
  }

  getPublicUrl(key) {
    return storage.getPublicUrl(key);
  }

  async delete(key) {
    return storage.deleteObject(key);
  }
}

// Stateless (reads env at call time via storage.js) — safe to share one
// instance across every request.
module.exports = new R2Adapter();