/**
 * backend/scripts/testArchiveBackup.js
 *
 * Standalone test for services/archiveBackup.js — isolates the
 * Archive.org (IAS3) integration from the rest of the upload/callback
 * flow, so you can confirm whether IA_ACCESS_KEY/IA_SECRET_KEY and IAS3's
 * auth scheme actually work, without needing a real upload + waiting on
 * GitHub Actions + digging through Sentry/Railway logs afterward.
 *
 * This calls the EXACT SAME production function used by
 * controllers/serviceController.js — nothing here is a simplified or
 * mocked version, so a success/failure here reflects reality.
 *
 * Run: node scripts/testArchiveBackup.js <filmId>
 * (any existing own-upload film's _id from your films collection — grab
 * one from Mongo Atlas or from a URL like /admin/queue. It needs a real
 * streamUrl, since that's the file this script actually fetches and
 * pushes to Archive.org.)
 */

require("dotenv").config();
const dns = require("dns");
// Same fix as ingest.js / server.js — some networks block the DNS SRV
// lookups mongodb+srv:// connection strings require.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
const Film = require("../models/Film");
const { backupFilmToArchiveOrg } = require("../services/archiveBackup");

const MONGO_URI = process.env.MONGO_URI;
const filmId = process.argv[2];

async function run() {
  if (!filmId) {
    console.error("Usage: node scripts/testArchiveBackup.js <filmId>");
    process.exit(1);
  }
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  // Confirms the keys are actually loaded into THIS process's env,
  // without printing the secret values themselves.
  console.log("IA_ACCESS_KEY set:", !!process.env.IA_ACCESS_KEY);
  console.log("IA_SECRET_KEY set:", !!process.env.IA_SECRET_KEY);

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const film = await Film.findById(filmId);
  if (!film) throw new Error(`Film ${filmId} not found`);

  console.log(`\nTesting Archive.org backup for "${film.title}" (${film._id})`);
  console.log("streamUrl:", film.streamUrl);
  console.log("Uploading — this can take a little while for a real video file...\n");

  const identifier = await backupFilmToArchiveOrg(film);

  console.log("✅ SUCCESS");
  console.log("Archive.org identifier:", identifier);
  console.log(`Check it at: https://archive.org/details/${identifier}`);
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("\n❌ FAILED");
    console.error("Error message:", err.message);
    console.error("\nFull error object (for anything the message alone doesn't show):");
    console.error(err);
    mongoose.disconnect().finally(() => process.exit(1));
  });