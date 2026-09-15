/**
 * backend/services/storage.js
 *
 * Cloudflare R2 helper functions used OUTSIDE the multi-provider storage
 * router: uploading the small VTT captions file, presigning the
 * Android APK's fixed-key release asset (see
 * controllers/serviceController.js's getApkUploadUrl), and (Slice 15)
 * deleting an entire HLS output folder by prefix. Own-upload film
 * masters no longer call this file directly — see services/storageRouter.js
 * + adapters/R2Adapter.js, which wraps getFixedUploadUrl() / getPublicUrl()
 * / deleteObject() / deletePrefix() below to satisfy the shared
 * StorageAdapter interface alongside B2Adapter/StorjAdapter.
 *
 * (The old random-key getUploadUrl()/buildKey() functions that used to
 * live here were removed — storageRouter.js now owns key generation for
 * routed uploads, and nothing else called them.)
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
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
      // Newer @aws-sdk/client-s3 versions default to always computing a
      // request checksum, which gets embedded as extra query params
      // (x-amz-checksum-crc32 etc.) on presigned URLs. R2 (and most
      // non-AWS S3-compatible providers) doesn't reliably support this —
      // it can cause a SignatureDoesNotMatch failure on the actual PUT
      // even after CORS is configured correctly. "WHEN_REQUIRED" matches
      // the SDK's older, safer default behavior.
      requestChecksumCalculation: "WHEN_REQUIRED",
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
 * Deletes a single object from R2 — used by R2Adapter.delete() to
 * satisfy the shared StorageAdapter interface.
 */
async function deleteObject(key) {
  const bucket = requireBucket();
  const c = getClient();
  await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Slice 15 — deletes every object under a given key prefix, e.g.
 * "uploads/{filmId}/hls/". An ABR-generated HLS ladder is a whole folder
 * of files (master playlist, per-rendition playlists, every segment,
 * audio-group playlists), not a single known key, so this lists the
 * prefix and bulk-deletes everything found under it. Paginates via
 * ListObjectsV2's ContinuationToken in case a folder ever exceeds 1000
 * objects (S3's per-request listing limit) — unlikely for a single
 * film's ladder, but correct to handle rather than silently truncate
 * and leave the rest orphaned. A no-op (nothing to list) is not an
 * error — used by R2Adapter.deletePrefix() to satisfy the shared
 * StorageAdapter interface.
 */
async function deletePrefix(prefix) {
  const bucket = requireBucket();
  const c = getClient();

  let continuationToken;
  do {
    const listed = await c.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (listed.Contents || []).map((obj) => ({ Key: obj.Key }));
    if (objects.length > 0) {
      await c.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

module.exports = {
  getFixedUploadUrl,
  uploadBuffer,
  getPublicUrl,
  deleteObject,
  deletePrefix,
};
