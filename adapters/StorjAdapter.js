/**
 * backend/adapters/StorjAdapter.js
 *
 * Storj adapter, via Storj's hosted S3-compatible gateway
 * (gateway.storjshare.io). Upload mechanics (presigned PUT) work the same
 * way as R2/B2/AWS S3 — Storj's gateway supports standard presigned URLs.
 *
 * Public URLs are NOT a plain base+key like R2/B2, though — Storj has no
 * "public bucket" concept at all. Instead, a ONE-TIME-registered,
 * read-only Linksharing Access Grant produces a stable share-link base
 * URL (e.g. https://link.us1.storjshare.io/s/<token>/<bucket>) that then
 * behaves like a static prefix for every object under that bucket from
 * then on. Generate that once (see
 * https://storj.dev/learn/concepts/linksharing-service) and set the
 * WHOLE prefix as STORJ_LINKSHARE_BASE_URL — this adapter just appends
 * the key, the same convention as the other adapters' *_PUBLIC_BASE_URL.
 *
 * STORJ_REGION is an arbitrary-but-consistent string, not a real AWS
 * region — Storj's gateway doesn't have region-specific endpoints the
 * way AWS does, but the SDK's SigV4 signer still needs *some* stable
 * region value to sign against.
 *
 * Both requestChecksumCalculation AND responseChecksumValidation are set
 * to "WHEN_REQUIRED" below — not just the request side. Newer AWS SDK
 * versions default to computing/validating checksums on both the
 * request AND the response, and Storj's gateway rejects requests
 * carrying that unsupported functionality outright with "A header you
 * provided implies functionality that is not implemented" (confirmed in
 * practice running scripts/setStorjCors.js against a real bucket — see
 * that script's header comment for the fuller story). Every other S3
 * client in this codebase (storage.js/B2Adapter) only needed the
 * request-side setting; Storj specifically needs both, matching the
 * aws-cli equivalent (AWS_REQUEST_CHECKSUM_CALCULATION +
 * AWS_RESPONSE_CHECKSUM_VALIDATION) already used against Storj in
 * film-media-worker's process-upload.yml and abr-transcode.yml.
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const StorageAdapter = require("./StorageAdapter");

const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 15 * 60; // 15 minutes
const STORJ_GATEWAY_ENDPOINT = "https://gateway.storjshare.io";

class StorjAdapter extends StorageAdapter {
  constructor() {
    super();
    this.accessKeyId = process.env.STORJ_ACCESS_KEY_ID;
    this.secretAccessKey = process.env.STORJ_SECRET_ACCESS_KEY;
    this.bucket = process.env.STORJ_BUCKET;
    this.region = process.env.STORJ_REGION || "us-east-1";
    this.linkshareBaseUrl = process.env.STORJ_LINKSHARE_BASE_URL;
    this._client = null;
  }

  _getClient() {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        "Missing Storj credentials in .env (STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY)"
      );
    }
    if (!this._client) {
      this._client = new S3Client({
        region: this.region,
        endpoint: STORJ_GATEWAY_ENDPOINT,
        credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
        // Storj's gateway expects the bucket in the path, not as a
        // virtual-hosted subdomain of the endpoint.
        forcePathStyle: true,
        // See this file's header comment — Storj specifically needs
        // BOTH the request and response checksum settings relaxed,
        // unlike R2/B2 which only needed the request side.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    }
    return this._client;
  }

  _requireBucket() {
    if (!this.bucket) throw new Error("Missing STORJ_BUCKET in .env");
    return this.bucket;
  }

  async getUploadUrl(key, contentType) {
    const bucket = this._requireBucket();
    const client = this._getClient();

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: PRESIGNED_UPLOAD_EXPIRY_SECONDS,
    });

    return { uploadUrl, key, publicUrl: this.getPublicUrl(key) };
  }

  getPublicUrl(key) {
    if (!this.linkshareBaseUrl) {
      throw new Error(
        "Missing STORJ_LINKSHARE_BASE_URL in .env (a persistent read-only " +
          "Linksharing base URL — see this file's header comment for how to generate one)"
      );
    }
    return `${this.linkshareBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  async delete(key) {
    const bucket = this._requireBucket();
    const client = this._getClient();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * Slice 15 — see StorageAdapter.deletePrefix() for why this exists.
   * Self-contained, same as B2Adapter's equivalent.
   */
  async deletePrefix(prefix) {
    const bucket = this._requireBucket();
    const client = this._getClient();

    let continuationToken;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const objects = (listed.Contents || []).map((obj) => ({ Key: obj.Key }));
      if (objects.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

module.exports = new StorjAdapter();