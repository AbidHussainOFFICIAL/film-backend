/**
 * backend/services/archiveBackup.js
 *
 * Fire-and-forget insurance mirror: after an own-upload's master file is
 * playable, pushes a copy to an Internet Archive item via IAS3
 * (Archive.org's S3-like API). Writes results into Film.archiveBackup
 * (see models/Film.js — that field already existed, just unused until
 * now), following the same best-effort pattern as Qdrant/Telegram/
 * WhatsApp: callers should catch and log/report rather than let this
 * block anything else in the upload flow.
 *
 * IMPORTANT: IAS3 authenticates with its own simple scheme — an
 * `Authorization: LOW accesskey:secretkey` header — NOT AWS SigV4.
 * @aws-sdk/client-s3's presigner would sign requests the WRONG way here,
 * so this talks to IAS3 directly via fetch() instead of going through an
 * adapter/StorageAdapter shape like R2/B2/Storj. This has been verified
 * against Archive.org's own IAS3 documentation, but has NOT been
 * exercised against a live archive.org account by this integration yet —
 * test with one real film before relying on it.
 *
 * This is one of the few places in this backend that touches file bytes
 * directly rather than only ever handing out a presigned URL —
 * unavoidable here, since IAS3 (unlike Telegram/Deepgram) has no "fetch
 * this URL yourself" mechanism; the bytes must be PUT by the uploader.
 * The film's own public streamUrl is streamed through, not buffered
 * fully into memory — the same bounded exception already accepted for
 * WhatsApp's Baileys integration (see services/whatsapp.js's header
 * comment for that precedent).
 */

const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY;
const IA_SECRET_KEY = process.env.IA_SECRET_KEY;
const IAS3_ENDPOINT = "https://s3.us.archive.org";

// Generous but bounded — this streams a real video file to a third
// party, not a lightweight API call, so it needs real time, but a
// genuinely stuck request shouldn't hang the process indefinitely.
const IAS3_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

/**
 * Pushes film.streamUrl's bytes to a new (or existing) Internet Archive
 * item. Returns the item's identifier on success; throws on any failure
 * — callers are expected to catch this and record failure state
 * themselves (see controllers/serviceController.js's usage).
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
  if (!sourceRes.ok || !sourceRes.body) {
    throw new Error(`Could not fetch source file for backup (HTTP ${sourceRes.status})`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IAS3_TIMEOUT_MS);

  try {
    const putRes = await fetch(url, {
      method: "PUT",
      body: sourceRes.body,
      duplex: "half", // required by Node's fetch when streaming a request body
      signal: controller.signal,
      headers: {
        Authorization: `LOW ${IA_ACCESS_KEY}:${IA_SECRET_KEY}`,
        // Auto-creates the item if it doesn't exist yet — a no-op on any
        // retry once the item already exists.
        "x-archive-auto-make-bucket": "1",
        "x-archive-meta01-title": encodeURIComponent(film.title || "Untitled"),
        "x-archive-meta02-mediatype": "movies",
        "x-archive-meta03-collection": "opensource_movies",
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

module.exports = { backupFilmToArchiveOrg };