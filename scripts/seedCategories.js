/**
 * backend/scripts/seedCategories.js
 *
 * One-time seed of the Category collection from constants/categories.js.
 * Safe to re-run: it will create any category that doesn't exist yet,
 * and update the description/slug of ones that already do, but never
 * touches filmCount — re-running this after editing a description
 * won't reset anyone's counts.
 *
 * Run: node scripts/seedCategories.js
 */

require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
const Category = require("../models/Category");
const { CATEGORIES } = require("../constants/categories");

const MONGO_URI = process.env.MONGO_URI;

async function run() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  for (const cat of CATEGORIES) {
    const result = await Category.findOneAndUpdate(
      { name: cat.name },
      { $set: { slug: cat.slug, description: cat.description } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`Synced "${result.name}" (filmCount: ${result.filmCount})`);
  }

  console.log("Done.");
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Seeding failed:", err.message);
    mongoose.disconnect().finally(() => process.exit(1));
  });