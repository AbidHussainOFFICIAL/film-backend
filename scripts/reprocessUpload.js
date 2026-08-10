/**
 * backend/scripts/reprocessUpload.js
 *
 * Retries the ffmpeg/whisper processing pipeline for a film whose
 * transcodeStatus is "failed" (e.g. ffmpeg wasn't installed at the time,
 * or a transient R2 error) — without needing to re-upload the master
 * file, since it's already sitting in R2 under the film's masterKey.
 *
 * Run: node scripts/reprocessUpload.js <filmId>
 */

require("dotenv").config();
const dns = require("dns");
// See the same fix in ingest.js / server.js — some networks block the DNS
// SRV lookups mongodb+srv:// connection strings require.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
const { processUpload } = require("../services/videoProcessing");

const MONGO_URI = process.env.MONGO_URI;
const filmId = process.argv[2];

async function run() {
  if (!filmId) {
    console.error("Usage: node scripts/reprocessUpload.js <filmId>");
    process.exit(1);
  }
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");
  console.log(`Reprocessing film ${filmId}...`);

  await processUpload(filmId);
  console.log("Done — transcodeStatus is now completed, status is now approved.");
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Reprocess failed:", err.message);
    mongoose.disconnect().finally(() => process.exit(1));
  });
