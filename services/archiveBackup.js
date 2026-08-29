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
 * adapter/StorageAdapter shape like R2/B2/Storj.
 *
 * Tested live against a real archive.org account, twice: a streamed
 * request body hit "411 Length Required" (IAS3's old Apache server
 * rejects chunked transfer encoding on PUT outright); adding an explicit
 * Content-Length to that same streamed body then hit a raw socket
 * termination instead. Both failure modes are specific to piping a
 * fetch() response stream into another fetch()'s request body against
 * this particular old server — buffering the file fully in memory before
 * sending it (see below) avoided both entirely and is now confirmed
 * working.
 *
 * This is one of the few places in this backend that touches file bytes
 * directly rather than only ever handing out a presigned URL —
 * unavoidable here, since IAS3 (unlike Telegram/Deepgram) has no "fetch
 * this URL yourself" mechanism; the bytes must be PUT by the uploader.
 * Unlike everything else in this backend, the film's master file IS
 * fully buffered into memory here (not streamed) for the duration of
 * this one background request — a deliberate, narrower exception than
 * WhatsApp's Baileys integration (which streams; see
 * services/whatsapp.js's header comment), made necessary by IAS3's old
 * server not reliably supporting a streamed request body at all. Worth
 * keeping in mind for very large films on a memory-constrained host.
 */

const IA_ACCESS_KEY = process.env.IA_ACCESS_KEY;
const IA_SECRET_KEY = process.env.IA_SECRET_KEY;
const IAS3_ENDPOINT = "https://s3.us.archive.org";

// Generous but bounded — this uploads a real video file to a third
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

// IAS3 stores whatever raw string is sent in an x-archive-meta-* header
// value AS-IS — it does NOT percent-decode it (encodeURIComponent()-ing
// a title here previously caused it to display literally as
// "sdv%20sd%20vsd" on archive.org instead of "sdv sd vsd"). The only
// real constraint is that HTTP header values can't contain a raw
// newline/carriage return, so this only strips those, leaving every
// other character (spaces, punctuation, accents) exactly as typed.
function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
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
  if (!sourceRes.ok) {
    throw new Error(`Could not fetch source file for backup (HTTP ${sourceRes.status})`);
  }

  // Buffered fully into memory rather than streamed — IAS3's server is
  // old enough (an Apache 2.4 setup, per its own error responses) that it
  // doesn't reliably handle a streamed request body even with an
  // explicit Content-Length declared: the first version of this function
  // hit "411 Length Required" (chunked encoding rejected outright), and
  // adding an explicit Content-Length to the streamed body then hit a
  // raw socket termination instead ("other side closed") — piping one
  // fetch()'s response stream into another fetch()'s request body, with
  // a manually-set Content-Length, is a less-common path in Node's
  // undici that this particular old server doesn't tolerate reliably.
  // Buffering sidesteps both failure modes: fetch computes Content-Length
  // automatically and sends one normal, non-chunked, non-streamed body —
  // the same way virtually every HTTP client behaves by default, and the
  // most compatible option for a server this old — at the cost of
  // holding the whole file in memory for the duration of this one
  // background request.
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