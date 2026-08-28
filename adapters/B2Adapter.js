/**
 * backend/adapters/B2Adapter.js
 *
 * Backblaze B2 adapter, via B2's S3-compatible API. Presign mechanics are
 * identical to R2/AWS S3 (same @aws-sdk/client-s3 + presigner) — B2 only
 * differs in its endpoint format, required region string, and how public
 * URLs are built.
 *
 * Unlike R2, B2 has no one-click "connect a custom domain": the public
 * URL is either B2's own native format
 * (https://f00X.backblazeb2.com/file/{bucket}/{key}) or a CDN
 * (Cloudflare/Fastly/Bunny) fronting the bucket if you want a branded
 * domain instead. Either way, set B2_PUBLIC_BASE_URL to whichever base
 * you're using — this adapter just concatenates the key onto it, the
 * same convention as R2_PUBLIC_BASE_URL.
 *
 * B2_REGION must match the region segment in B2_ENDPOINT (e.g.
 * "us-west-004" for an endpoint of https://s3.us-west-004.backblazeb2.com)
 * — required explicitly rather than parsed out of the endpoint string, to
 * avoid a fragile guess if Backblaze ever changes that hostname format.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const StorageAdapter = require("./StorageAdapter");

const PRESIGNED_UPLOAD_EXPIRY_SECONDS = 15 * 60; // 15 minutes

class B2Adapter extends StorageAdapter {
  constructor() {
    super();
    this.endpoint = process.env.B2_ENDPOINT; // e.g. https://s3.us-west-004.backblazeb2.com
    this.region = process.env.B2_REGION;
    this.accessKeyId = process.env.B2_ACCESS_KEY_ID;
    this.secretAccessKey = process.env.B2_SECRET_ACCESS_KEY;
    this.bucket = process.env.B2_BUCKET;
    this.publicBaseUrl = process.env.B2_PUBLIC_BASE_URL;
    this._client = null;
  }

  _getClient() {
    if (!this.endpoint || !this.region || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error(
        "Missing B2 credentials in .env (B2_ENDPOINT / B2_REGION / B2_ACCESS_KEY_ID / B2_SECRET_ACCESS_KEY)"
      );
    }
    if (!this._client) {
      this._client = new S3Client({
        region: this.region,
        endpoint: this.endpoint,
        credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
        // B2's S3-compatible API expects the bucket in the path, not as a
        // virtual-hosted subdomain of the endpoint.
        forcePathStyle: true,
        // See storage.js's identical comment — newer AWS SDK versions
        // default to auto-computing a request checksum that most
        // non-AWS S3-compatible providers don't reliably support.
        requestChecksumCalculation: "WHEN_REQUIRED",
      });
    }
    return this._client;
  }

  _requireBucket() {
    if (!this.bucket) throw new Error("Missing B2_BUCKET in .env");
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
    if (!this.publicBaseUrl) {
      throw new Error("Missing B2_PUBLIC_BASE_URL in .env");
    }
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  async delete(key) {
    const bucket = this._requireBucket();
    const client = this._getClient();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

module.exports = new B2Adapter();