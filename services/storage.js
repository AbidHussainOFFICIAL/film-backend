/**
 * backend/services/storage.js
 *
 * Cloudflare R2 helper functions used OUTSIDE the multi-provider storage
 * router: uploading the small VTT captions file, and presigning the
 * Android APK's fixed-key release asset (see
 * controllers/serviceController.js's getApkUploadUrl). Own-upload film
 * masters no longer call this file directly — see services/storageRouter.js
 * + adapters/R2Adapter.js, which wraps getFixedUploadUrl() / getPublicUrl()
 * / deleteObject() below to satisfy the shared StorageAdapter interface
 * alongside B2Adapter/StorjAdapter.
 *
 * (The old random-key getUploadUrl()/buildKey() functions that used to
 * live here were removed — storageRouter.js now owns key generation for
 * routed uploads, and nothing else called them.)
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
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
 * Generates a presigned PUT URL for a caller-supplied FIXED key — used
 * when the same object should always be overwritten in place: the
 * Android APK release asset, and (via R2Adapter) every own-upload film
 * master routed to R2, so its public URL never changes between uploads.
 */
async function getFixedUploadUrl(key, contentType) {
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
 * Uploads content directly from memory (string or Buffer) — used for the
 * VTT captions file, which is small enough that writing a temp file first
 * would just be unnecessary overhead. Captions always live on R2
 * regardless of which provider a film's master landed on — they're tiny
 * text files, not worth routing, and keeping them in one place simplifies
 * lookup.
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

/**
 * Deletes an object from R2 — used by R2Adapter.delete() to satisfy the
 * shared StorageAdapter interface.
 */
async function deleteObject(key) {
  const bucket = requireBucket();
  const c = getClient();
  await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = {
  getFixedUploadUrl,
  uploadBuffer,
  getPublicUrl,
  deleteObject,
};
