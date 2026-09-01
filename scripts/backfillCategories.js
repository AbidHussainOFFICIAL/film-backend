/**
 * backend/scripts/backfillCategories.js
 *
 * One-time migration for films that were ingested BEFORE the fixed
 * taxonomy existed — their `category` field may hold raw, unmapped
 * strings (whatever TMDb happened to return). This script:
 *   1. Re-maps every film's category array through categoryMapper
 *      (same function ingestion now uses going forward)
 *   2. Recomputes every Category's filmCount from scratch, by counting
 *      approved films — a full recount rather than incremental deltas,
 *      since this only ever runs once and a full count is the simplest
 *      way to guarantee correctness after a bulk remap.
 *
 * Safe to re-run — remapping an already-mapped film is a no-op (mapping
 * a valid taxonomy name onto itself), and the recount always reflects
 * current reality regardless of how many times this has run before.
 *
 * Run: node scripts/backfillCategories.js
 */

require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
const Film = require("../models/Film");
const Category = require("../models/Category");
const { mapToTaxonomy } = require("../services/categoryMapper");

const MONGO_URI = process.env.MONGO_URI;

async function run() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  // --- Step 1: remap every film's category array ---
  const films = await Film.find({}, { category: 1 });
  console.log(`Found ${films.length} film(s) to check.`);

  let remapped = 0;
  for (const film of films) {
    const mapped = mapToTaxonomy(film.category);
    const changed =
      mapped.length !== (film.category || []).length ||
      mapped.some((name, i) => name !== film.category[i]);

    if (changed) {
      film.category = mapped;
      await film.save();
      remapped += 1;
    }
  }
  console.log(`Remapped ${remapped} film(s).`);

  // --- Step 2: recompute filmCount from scratch ---
  const categories = await Category.find();
  for (const cat of categories) {
    const count = await Film.countDocuments({ status: "approved", category: cat.name });
    if (cat.filmCount !== count) {
      cat.filmCount = count;
      await cat.save();
    }
    console.log(`"${cat.name}": ${count} approved film(s)`);
  }

  console.log("Done.");
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Backfill failed:", err.message);
    mongoose.disconnect().finally(() => process.exit(1));
  });