/**
 * backend/services/storage.js
 *
 * Wraps Cloudflare R2 (S3-compatible) for the things the light backend
 * does with it:
 *  1. Presigned PUT URLs so the browser uploads the master video file
 *     directly to R2 — the large file never passes through this server
 *     (getUploadUrl, random per-upload key).
 *  2. A presigned PUT URL for a FIXED key — used for assets that should
 *     always be overwritten in place rather than versioned, so their
 *     public URL never changes (getFixedUploadUrl; currently used for
 *     the Android APK release asset, uploaded by film-frontend's
 *     build-apk.yml workflow).
 *  3. Uploading small in-memory content (the VTT captions file) right
 *     after Deepgram generates it.
 *
 * Downloading/processing the master file and uploading the resulting
 * thumbnail/preview lives entirely on the heavy backend (a separate
 * repo, its own R2 credentials) — this file deliberately doesn't do that,
 * to keep this backend from ever handling large file bytes.
 */

const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
// The custom domain connected to the bucket (R2 → bucket → Settings →
// Connect Domain), e.g. https://media.yourdomain.com — this is what makes
// uploaded files publicly playable without additional auth.
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 15 * 60; // 15 minutes

let client = null;

function getClient() {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "Missing R2 credentials in .env (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)"
    );
  }
  if (!client) {
    client = new S3Client({
      region: "auto", // required by the SDK, unused by R2
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

function requireBucket() {
  if (!R2_BUCKET) throw new Error("Missing R2_BUCKET in .env");
  return R2_BUCKET;
}

function getPublicUrl(key) {
  if (!R2_PUBLIC_BASE_URL) {
    throw new Error("Missing R2_PUBLIC_BASE_URL in .env");
  }
  return `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;
}

/**
 * Builds a collision-safe object key from a user-supplied filename —
 * strips anything that isn't a safe filename character and prefixes with
 * a random UUID so two uploads of "video.mp4" never collide.
 */
function buildKey(filename) {
  const safeName = String(filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `uploads/${crypto.randomUUID()}-${safeName}`;
}

/**
 * Shared presign logic. The only difference between getUploadUrl and
 * getFixedUploadUrl below is where `key` comes from — a freshly generated
 * random one, vs a caller-supplied fixed one.
 */
async function presignPut(key, contentType) {
  const bucket = requireBucket();
  const c = getClient();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || "application/octet-stream",
  });

  const uploadUrl = await getSignedUrl(c, command, {
    expiresIn: PRESIGNED_UPLOAD_EXPIRY_SECONDS,
  });

  return { uploadUrl, key, publicUrl: getPublicUrl(key) };
}

/**
 * Generates a presigned PUT URL the browser can upload directly to, under
 * a fresh random key. Returns the key so the caller can reference this
 * object later, and the eventual public URL for convenience.
 */
async function getUploadUrl(filename, contentType) {
  const key = buildKey(filename);
  return presignPut(key, contentType);
}

/**
 * Like getUploadUrl, but for a caller-supplied FIXED key instead of a
 * randomly generated one — used when the same object should always be
 * overwritten in place (e.g. the Android APK release asset), so its
 * public URL never changes between uploads/builds.
 */
async function getFixedUploadUrl(key, contentType) {
  return presignPut(key, contentType);
}

/**
 * Uploads content directly from memory (string or Buffer) — used for the
 * VTT captions file, which is small enough that writing a temp file first
 * would just be unnecessary overhead.
 */
async function uploadBuffer(key, body, contentType) {
  const bucket = requireBucket();
  const c = getClient();

  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return getPublicUrl(key);
}

module.exports = {
  getUploadUrl,
  getFixedUploadUrl,
  uploadBuffer,
  getPublicUrl,
  buildKey,
};
