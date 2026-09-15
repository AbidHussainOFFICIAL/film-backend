/**
 * backend/scripts/setR2Cors.js
 *
 * One-time script: applies a CORS policy to the R2 bucket via the
 * standard S3 PutBucketCors API. Slice 15 (adaptive-bitrate streaming)
 * needs this specifically — hls.js fetches the HLS manifest and every
 * segment file via JavaScript fetch()/XHR, which DOES enforce CORS,
 * unlike a plain <video src="..."> tag (this app's pre-Slice-15 direct-
 * file playback), which browsers allow cross-origin without any CORS
 * policy at all.
 *
 * R2's "Public Development URL" setting (already enabled — see
 * R2_PUBLIC_BASE_URL in .env) makes objects fetchable over HTTP, but is
 * NOT the same thing as an explicit CORS policy permitting cross-origin
 * JS fetches. Without this script having been run, hls.js's requests
 * fail with opaque cross-origin network errors despite every other part
 * of the pipeline (dispatch, ffmpeg, upload, callback) working
 * correctly — this is a real prerequisite, not an optional hardening
 * step, and should be run BEFORE testing playback of any film with a
 * completed ABR ladder.
 *
 * Mirrors scripts/setB2Cors.js exactly — see that file for the fuller
 * reasoning on using the real S3 API here rather than R2's dashboard UI.
 *
 * Run once: node scripts/setR2Cors.js
 */

require("dotenv").config();
const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require("@aws-sdk/client-s3");

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;

async function run() {
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing one of R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET in .env"
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            // Wildcard origin is safe here for the same reason
            // scripts/setB2Cors.js's identical policy is: HLS
            // manifests/segments are the public streaming content
            // itself (same trust level as the direct-file URLs already
            // served without any CORS restriction at all), not
            // privileged data — allowing any origin to fetch them
            // doesn't grant access to anything an attacker couldn't
            // already reach directly.
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

  console.log(`CORS policy applied to R2 bucket "${bucket}".`);

  // Read it back immediately so we can confirm exactly what's live,
  // rather than trusting the PUT call silently succeeded.
  const check = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log("Current CORS rules:", JSON.stringify(check.CORSRules, null, 2));
}

run().catch((err) => {
  console.error("Failed to set R2 CORS policy:", err.message);
  process.exit(1);
});
