/**
 * backend/services/masterSourceResolver.js
 *
 * Slice 17 — resolves what to hand the heavy backend (film-media-worker)
 * as the source for an ABR (re)generation dispatch: normally the film's
 * own master file in storage, but falling back to its Archive.org backup
 * copy for a film whose master has already been cleaned up (see
 * masterCleanupService.js) and is later re-dispatched anyway — e.g. an
 * admin explicitly choosing to regenerate multi-quality streaming a
 * second time from /admin/films.
 *
 * Used only by uploadController.generateAbr. Every other dispatch site
 * (uploadController.createUpload, serviceController.decideAndDispatchAbr,
 * uploadController.retryProcessing, serviceController's stuck-transcode
 * reconciliation sweep) only ever runs at a point in a film's lifecycle
 * where the master is guaranteed to still exist — ABR, and therefore any
 * possible master deletion, hasn't happened yet at any of those points —
 * so they dispatch directly and never need this resolver.
 *
 * Deliberately a single, bounded attempt — no internal retry loop. A
 * transient Archive.org hiccup here surfaces as a clear, specific error
 * to the admin (the same way transcodeError/abrError already work),
 * never as unbounded background retrying.
 */

const { fetchItemMetadata, pickOriginalVideoFile } = require("./archiveBackup");

/**
 * Finds the download URL of the true original file inside one of this
 * app's Archive.org backup items. Slice 18 — prefers the item's real
 * uploaded original (of any video container) over Archive.org's own
 * re-encoded .mp4 derivative: regenerating a ladder from a derivative
 * would silently lose fidelity, extra audio tracks and embedded
 * subtitles, which is the whole reason the true original is backed up.
 */
async function resolveArchiveOrgFileUrl(archiveIdentifier) {
  const data = await fetchItemMetadata(archiveIdentifier);
  const file = pickOriginalVideoFile(data.files);
  if (!file) {
    throw new Error(`No video file found in Archive.org item "${archiveIdentifier}"`);
  }
  return `https://archive.org/download/${archiveIdentifier}/${encodeURIComponent(file.name)}`;
}

/**
 * Returns { masterKey, storageProvider, sourceUrl } — always
 * storageProvider (needed regardless, so the workflow knows where to
 * upload the regenerated output), and EITHER masterKey (normal case) OR
 * sourceUrl (Archive.org fallback), never both. Throws (with
 * `.code = "NO_SOURCE"`) if neither a live master nor a completed
 * Archive.org backup exists — a genuine dead end, not something to
 * paper over.
 */
async function resolveMasterSource(film) {
  if (!film.storageProvider) {
    const err = new Error("This film has no recorded storage provider — it may not be an own-upload.");
    err.code = "NO_SOURCE";
    throw err;
  }

  if (film.masterKey) {
    return { masterKey: film.masterKey, storageProvider: film.storageProvider, sourceUrl: undefined };
  }

  if (film.archiveBackup?.pushed && film.archiveBackup?.archiveIdentifier) {
    try {
      const sourceUrl = await resolveArchiveOrgFileUrl(film.archiveBackup.archiveIdentifier);
      return { masterKey: undefined, storageProvider: film.storageProvider, sourceUrl };
    } catch (err) {
      const wrapped = new Error(
        `This film's master file was already cleaned up, and its Archive.org backup could not be reached right now: ${err.message}`
      );
      wrapped.code = "NO_SOURCE";
      throw wrapped;
    }
  }

  const err = new Error(
    "This film's master file was already cleaned up, and it has no Archive.org backup to fall back to."
  );
  err.code = "NO_SOURCE";
  throw err;
}

module.exports = { resolveMasterSource };
