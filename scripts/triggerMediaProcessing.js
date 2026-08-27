/**
 * backend/scripts/triggerMediaProcessing.js
 *
 * Manually re-dispatches the film-media-worker's thumbnail/preview job for
 * a film — useful if the original dispatch failed, or the callback never
 * arrived (e.g. the callback secret was misconfigured, or the tunnel URL
 * used for local testing had already expired). Doesn't re-upload anything
 * — the master file is already sitting with its recorded storageProvider.
 *
 * Run: node scripts/triggerMediaProcessing.js <filmId>
 */

require("dotenv").config();
const dns = require("dns");
// Same fix as ingest.js / server.js — some networks block the DNS SRV
// lookups mongodb+srv:// connection strings require.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
const Film = require("../models/Film");
// NOTE: this used to import a function called `triggerMediaProcessing`,
// which doesn't exist in services/githubActions.js (only
// `triggerUploadProcessing` does) — a pre-existing bug that would have
// thrown at runtime the first time this script was actually run. Fixed
// here while adding storageProvider support.
const { triggerUploadProcessing } = require("../services/githubActions");

const MONGO_URI = process.env.MONGO_URI;
const filmId = process.argv[2];

async function run() {
  if (!filmId) {
    console.error("Usage: node scripts/triggerMediaProcessing.js <filmId>");
    process.exit(1);
  }
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const film = await Film.findById(filmId);
  if (!film) throw new Error(`Film ${filmId} not found`);
  if (!film.masterKey) throw new Error(`Film ${filmId} has no masterKey`);
  if (!film.storageProvider) throw new Error(`Film ${filmId} has no storageProvider recorded`);

  await triggerUploadProcessing(film._id, film.masterKey, film.storageProvider);
  film.transcodeStatus = "processing";
  await film.save();

  console.log(`Dispatched media processing for "${film.title}" (${film._id}) on ${film.storageProvider}.`);
  console.log(
    "Check the film-media-worker repo's Actions tab for the run, and MongoDB once the callback lands."
  );
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Failed to trigger media processing:", err.message);
    mongoose.disconnect().finally(() => process.exit(1));
  });
  