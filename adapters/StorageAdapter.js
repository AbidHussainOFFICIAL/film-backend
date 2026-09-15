/**
 * backend/adapters/StorageAdapter.js
 *
 * Base interface every storage adapter (R2Adapter, B2Adapter,
 * StorjAdapter) implements. Presign-based throughout, matching this
 * project's existing rule that the light backend never handles file
 * bytes directly — every adapter hands back a URL the browser uploads
 * straight to, not a buffer this server writes itself.
 *
 * Subclasses override every method below; this base class only exists to
 * document the shared contract and fail loudly (rather than silently
 * returning undefined) if a method is ever missed.
 */
class StorageAdapter {
  /**
   * @param {string} key - object key within the provider's bucket
   * @param {string} contentType
   * @returns {Promise<{ uploadUrl: string, key: string, publicUrl: string }>}
   */
  async getUploadUrl(key, contentType) {
    throw new Error(`${this.constructor.name} must implement getUploadUrl()`);
  }

  /**
   * @param {string} key
   * @returns {string} a publicly reachable URL for this object
   */
  getPublicUrl(key) {
    throw new Error(`${this.constructor.name} must implement getPublicUrl()`);
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error(`${this.constructor.name} must implement delete()`);
  }

  /**
   * Slice 15 — deletes every object under a given key prefix, e.g.
   * "uploads/{filmId}/hls/". Needed because an ABR-generated HLS ladder
   * is a whole folder of files (a master playlist, one playlist per
   * rendition, every segment, audio-group playlists) rather than a
   * single named object like everything delete() above handles —
   * there's no individual key to pass it. Used by
   * services/filmDeletionService.js when permanently deleting a film
   * that has (or may have partially generated) an HLS ladder.
   * @param {string} prefix
   * @returns {Promise<void>}
   */
  async deletePrefix(prefix) {
    throw new Error(`${this.constructor.name} must implement deletePrefix()`);
  }
}

module.exports = StorageAdapter;
