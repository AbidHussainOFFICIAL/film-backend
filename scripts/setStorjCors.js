/**
 * backend/scripts/setStorjCors.js
 *
 * One-time script: applies a CORS policy to the Storj bucket, via the
 * same standard S3 PutBucketCors API Storj's gateway.storjshare.io
 * supports. See scripts/setR2Cors.js's header comment for the full
 * reasoning on why this is a genuine Slice 15 prerequisite (hls.js's
 * fetch()/XHR-based requests enforce CORS, unlike a plain <video src>
 * tag) rather than optional hardening — Storj's CORS behavior was
 * unconfirmed before this slice, since nothing before Slice 15 needed
 * JS-level cross-origin fetches against Storj-hosted objects at all.
 *
 * Both requestChecksumCalculation AND responseChecksumValidation must
 * be set to "WHEN_REQUIRED" here — not just the request side. Newer AWS
 * SDK versions default to computing/validating checksums on both the
 * request AND the response, and Storj's gateway rejects requests
 * carrying that unsupported functionality with "A header you provided
 * implies functionality that is not implemented". This exact fix is
 * already documented and applied in film-media-worker's
 * abr-transcode.yml (and process-upload.yml) via the aws-cli
 * equivalents AWS_REQUEST_CHECKSUM_CALCULATION /
 * AWS_RESPONSE_CHECKSUM_VALIDATION — this script needs both settings
 * for the same reason, applied to the SDK client instead of aws-cli env
 * vars.
 *
 * Run once: node scripts/setStorjCors.js
 */

require("dotenv").config();
const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require("@aws-sdk/client-s3");

const accessKeyId = process.env.STORJ_ACCESS_KEY_ID;
const secretAccessKey = process.env.STORJ_SECRET_ACCESS_KEY;
const bucket = process.env.STORJ_BUCKET;
const region = process.env.STORJ_REGION || "us-east-1";
const STORJ_GATEWAY_ENDPOINT = "https://gateway.storjshare.io";

async function run() {
  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing one of STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY / STORJ_BUCKET in .env"
    );
  }

  const client = new S3Client({
    region,
    endpoint: STORJ_GATEWAY_ENDPOINT,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            // See scripts/setR2Cors.js's identical rule for why a
            // wildcard origin is safe here — this is public streaming
            // content, the same trust level as every direct-file URL
            // already served without any CORS restriction.
            AllowedOrigins: ["*"],
            AllowedMethods: ["GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag", "Content-Length", "Content-Range"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  );

  console.log(`CORS policy applied to Storj bucket "${bucket}".`);

  const check = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log("Current CORS rules:", JSON.stringify(check.CORSRules, null, 2));
}

run().catch((err) => {
  console.error("Failed to set Storj CORS policy:", err.message);
  process.exit(1);
});