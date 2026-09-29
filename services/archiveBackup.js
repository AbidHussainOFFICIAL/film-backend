/**
 * backend/services/archiveBackup.js
 *
 * Fire-and-forget insurance mirror: after an own-upload's master file is
 * playable, pushes a copy to an Internet Archive item via IAS3
 * (Archive.org's S3-like API). Writes results into Film.archiveBackup
 * (see models/Film.js), following the same best-effort pattern as
 * Qdrant: callers should catch and log/report rather than let this
 * block anything else in the upload flow.
 *
 * IMPORTANT: IAS3 authenticates with its own simple scheme — an
 * `Authorization: LOW accesskey:secretkey` header — NOT AWS SigV4.
 * @aws-sdk/client-s3's presigner would sign requests the WRONG way here,
 * so this talks to IAS3 directly via fetch() instead of going through an
 * adapter/StorageAdapter shape like R2/B2/Storj.
 *
 * Tested live against a real archive.org account: a streamed request
 * body hit "411 Length Required" (IAS3's old Apache server rejects
 * chunked transfer encoding on PUT outright); adding an explicit
 * Content-Length to that same streamed body then hit a raw socket
 * termination instead. Buffering the file fully in memory before
 * sending it avoided both and is confirmed working — this is one of the
 * few places in this backend that touches file bytes directly, a
 * deliberate, narrow exception (a per-upload RAM spike for the duration
 * of one background request; worth keeping in mind for very large films
 * on a memory-constrained host).
 *
 * Slice 18 additions:
 *  - Items are uploaded with `noindex`, so they don't appear in
 *    archive.org's public search or sitemap. They stay reachable by
 *    direct URL (which is all recovery needs), but are no longer
 *    discoverable by browsing or searching the uploader's account.
 *  - verifyArchiveOrgBackup(): before this app deletes its own only copy
 *    of an original master (see masterCleanupService.js), it asks
 *    archive.org what it actually holds — a successful PUT response is
 *    not proof the file survived the item's ingest.
 *  - pickOriginalVideoFile(): shared "which file in this item is the
 *    real original" logic, used both to verify and to fall back to
 *    Archive.org as a download source (masterSourceResolver.js).
 */

const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY;
const IA_SECRET_KEY = process.env.IA_SECRET_KEY;
const IAS3_ENDPOINT = "https://s3.us.archive.org";

// Generous but bounded — this uploads a real video file to a third
// party, not a lightweight API call, so it needs real time, but a
// genuinely stuck request shouldn't hang the process indefinitely.
const IAS3_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const METADATA_TIMEOUT_MS = 15 * 1000;

// Video containers an admin may upload (the upload form accepts any
// video/*). Archive.org keeps the uploaded file under its original name
// as source "original", and adds its own re-encoded .mp4 as a
// "derivative" — which is NOT the original and must not be mistaken
// for it.
const ORIGINAL_VIDEO_EXTENSIONS = /\.(mp4|mkv|mov|avi|webm|m4v|mpg|mpeg|wmv|flv|ts)$/i;

function buildIdentifier(film) {
  // Archive.org item identifiers are global across ALL of archive.org,
  // not scoped to this app — prefixed to make collisions with unrelated
  // existing items extremely unlikely.
  return `reelvault-${film._id}`;
}

function buildFilename(film) {
  const safeTitle = String(film.title || "film").replace(/[^a-zA-Z0-9._-]/g, "_");
  const match = film.masterKey && film.masterKey.match(/\.[^/.]+$/);
  const ext = (match && match[0]) || ".mp4";
  return `${safeTitle}${ext}`;
}

// IAS3 stores whatever raw string is sent in an x-archive-meta-* header
// value AS-IS — it does NOT percent-decode it. The only real constraint
// is that HTTP header values can't contain a raw newline/carriage
// return, so this only strips those, leaving every other character
// exactly as typed.
function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

/**
 * From an Archive.org item's `files` array, returns the file that is the
 * real uploaded original: the largest source:"original" video file. Falls
 * back to the largest .mp4 of any kind only if no original video is
 * listed (e.g. a legacy item) — and returns null if there's nothing.
 */
function pickOriginalVideoFile(files) {
  const list = Array.isArray(files) ? files : [];
  const bySizeDesc = (a, b) => Number(b.size || 0) - Number(a.size || 0);

  const originals = list
    .filter(
      (f) => f.source === "original" && typeof f.name === "string" && ORIGINAL_VIDEO_EXTENSIONS.test(f.name)
    )
    .sort(bySizeDesc);
  if (originals.length > 0) return originals[0];

  const mp4s = list
    .filter((f) => typeof f.name === "string" && f.name.toLowerCase().endsWith(".mp4"))
    .sort(bySizeDesc);
  return mp4s[0] || null;
}

async function fetchItemMetadata(identifier) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Archive.org metadata request failed (HTTP ${res.status})`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pushes film.streamUrl's bytes to a new (or existing) Internet Archive
 * item. Returns the item's identifier on success; throws on any failure
 * — callers are expected to catch and record failure state themselves.
 */
async function backupFilmToArchiveOrg(film) {
  if (!IA_ACCESS_KEY || !IA_SECRET_KEY) {
    throw new Error("Missing IA_ACCESS_KEY / IA_SECRET_KEY in .env");
  }
  if (!film.streamUrl) {
    throw new Error(`Film ${film._id} has no streamUrl to back up`);
  }

  const identifier = buildIdentifier(film);
  const filename = buildFilename(film);
  const url = `${IAS3_ENDPOINT}/${identifier}/${encodeURIComponent(filename)}`;

  const sourceRes = await fetch(film.streamUrl);
  if (!sourceRes.ok) {
    throw new Error(`Could not fetch source file for backup (HTTP ${sourceRes.status})`);
  }

  // Buffered fully into memory rather than streamed — see this file's
  // header comment for the two failure modes streaming hit.
  const fileBuffer = Buffer.from(await sourceRes.arrayBuffer());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IAS3_TIMEOUT_MS);

  try {
    const putRes = await fetch(url, {
      method: "PUT",
      body: fileBuffer,
      signal: controller.signal,
      headers: {
        Authorization: `LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}`,
        // Auto-creates the item if it doesn't exist yet — a no-op on any
        // retry once the item already exists.
        "x-archive-auto-make-bucket": "1",
        "x-archive-meta01-title": sanitizeHeaderValue(film.title || "Untitled"),
        "x-archive-meta02-mediatype": "movies",
        "x-archive-meta03-collection": "opensource_movies",
        // Slice 18 — the mere presence of this tag keeps the item out of
        // archive.org's public search and sitemap.
        "x-archive-meta-noindex": "true",
      },
    });

    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      throw new Error(`IAS3 upload failed (HTTP ${putRes.status}): ${body}`);
    }

    return identifier;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Slice 18 — confirms Archive.org actually holds this film's original
 * file before the app deletes its own only local copy. Compares the
 * item's real original video file against the byte size recorded at
 * upload time (film.fileSizeBytes); if no size was ever recorded, the
 * existence of an original video file is the best check available.
 *
 * Returns true/false, never throws: any doubt (network error, item not
 * yet visible in metadata, size mismatch) is "not verified", which
 * always fails safe — the caller simply doesn't delete yet, and the
 * periodic reconciliation sweep tries again later. A freshly PUT item
 * can take a little while to show its files in Archive.org's metadata,
 * which is exactly why this is retried by the sweep rather than treated
 * as a one-shot.
 */
async function verifyArchiveOrgBackup(film) {
  const identifier = film.archiveBackup?.archiveIdentifier;
  if (!identifier) return false;

  try {
    const data = await fetchItemMetadata(identifier);
    const original = pickOriginalVideoFile(data.files);
    if (!original || original.source !== "original") return false;

    if (typeof film.fileSizeBytes === "number") {
      return Number(original.size) === film.fileSizeBytes;
    }
    return true;
  } catch (err) {
    console.warn(`Could not verify Archive.org backup for film ${film._id}:`, err.message);
    return false;
  }
}

module.exports = {
  backupFilmToArchiveOrg,
  verifyArchiveOrgBackup,
  pickOriginalVideoFile,
  fetchItemMetadata,
};
