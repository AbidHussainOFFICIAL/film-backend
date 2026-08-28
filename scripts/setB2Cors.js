/**
 * backend/scripts/setB2Cors.js
 *
 * One-time script: applies a CORS policy to the B2 bucket via the
 * standard S3 PutBucketCors API — this is more reliable for presigned-PUT
 * browser uploads than B2's web dashboard, which maps its simplified
 * radio-button UI onto B2's own internal "allowedOperations" concept
 * rather than a plain S3-style AllowedMethods list, and doesn't always
 * translate into a rule that correctly matches a PUT preflight request.
 * See Backblaze's own docs:
 * https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules
 *
 * PutBucketCors REPLACES the bucket's entire CORS configuration (it does
 * not merge with whatever the dashboard set) — so running this once is
 * enough, no need to separately clear anything in the dashboard first.
 *
 * Run once: node scripts/setB2Cors.js
 */

require("dotenv").config();
const { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } = require("@aws-sdk/client-s3");

const endpoint = process.env.B2_ENDPOINT;
const region = process.env.B2_REGION;
const accessKeyId = process.env.B2_ACCESS_KEY_ID;
const secretAccessKey = process.env.B2_SECRET_ACCESS_KEY;
const bucket = process.env.B2_BUCKET;

async function run() {
  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing one of B2_ENDPOINT / B2_REGION / B2_ACCESS_KEY_ID / B2_SECRET_ACCESS_KEY / B2_BUCKET in .env"
    );
  }

  const client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            // Wildcard origin is safe here — presigned URLs carry their
            // own signature/auth in the URL itself (no cookies or
            // ambient credentials involved), so allowing any origin to
            // attempt the request doesn't grant access to anything an
            // attacker couldn't already do by holding a valid presigned
            // URL your own server issued.
            AllowedOrigins: ["*"],
            AllowedMethods: ["PUT", "GET", "HEAD"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    })
  );

  console.log(`CORS policy applied to B2 bucket "${bucket}".`);

  // Read it back immediately so we can confirm exactly what's live,
  // rather than trusting the PUT call silently succeeded.
  const check = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log("Current CORS rules:", JSON.stringify(check.CORSRules, null, 2));
}

run().catch((err) => {
  console.error("Failed to set B2 CORS policy:", err.message);
  process.exit(1);
});