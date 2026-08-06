/**
 * backend/scripts/reindexApproved.js
 *
 * Embeds and indexes every currently-approved film into Qdrant. Needed
 * once when semantic search is first set up, since films approved before
 * this existed (e.g. during Slice 3 testing) never went through the
 * embedding step in adminController.approveFilm. Safe to re-run any time —
 * upserts overwrite the same point ID for a given film.
 *
 * Run: node scripts/reindexApproved.js
 */

require("dotenv").config();
const dns = require("dns");
// Some networks block/mishandle the DNS SRV lookups that mongodb+srv://
// connection strings require (see the same fix in ingest.js / server.js).
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");

const Film = require("../models/Film");
const { getEmbedding, buildEmbeddingText } = require("../services/embedding");
const { ensureCollection, upsertFilmEmbedding } = require("../services/qdrantService");

const MONGO_URI = process.env.MONGO_URI;
const REQUEST_DELAY_MS = 200; // stay comfortably under OpenAI's rate limits

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  await ensureCollection();

  const films = await Film.find({ status: "approved" });
  console.log(`Found ${films.length} approved film(s) to index.`);

  let indexed = 0;
  let failed = 0;

  for (const film of films) {
    try {
      const text = buildEmbeddingText(film);
      const vector = await getEmbedding(text, { taskType: "document" });
      await upsertFilmEmbedding(film._id, vector, {
        title: film.title,
        year: film.year,
      });
      indexed += 1;
      console.log(`Indexed: ${film.title}`);
    } catch (err) {
      failed += 1;
      console.error(`Failed to index "${film.title}":`, err.message);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`Done. Indexed ${indexed}, failed ${failed}.`);
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Reindex run failed:", err.message);
    mongoose.disconnect().finally(() => process.exit(1));
  });