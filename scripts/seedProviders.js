/**
 * backend/scripts/seedProviders.js
 *
 * One-time seed of the three Provider documents (R2, B2, Storj) that
 * services/storageRouter.js selects between. Safe to re-run — it will
 * NOT overwrite a provider that already exists (so re-running this never
 * clobbers usedBytes, or any limits/priority you've since edited from
 * /admin/storage). To change limits/priority/active state after the
 * first run, use the admin UI, not this script.
 *
 * Run: node scripts/seedProviders.js
 */

require("dotenv").config();
const dns = require("dns");
// Same fix as ingest.js / server.js — some networks block the DNS SRV
// lookups mongodb+srv:// connection strings require.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
const Provider = require("../models/Provider");

const MONGO_URI = process.env.MONGO_URI;
const GB = 1024 * 1024 * 1024;

const SEED_PROVIDERS = [
  { name: "r2", freeLimitBytes: 10 * GB, priority: 1 },
  { name: "b2", freeLimitBytes: 10 * GB, priority: 2 },
  { name: "storj", freeLimitBytes: 25 * GB, priority: 3 },
];

async function run() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  for (const seed of SEED_PROVIDERS) {
    const existing = await Provider.findOne({ name: seed.name });
    if (existing) {
      console.log(`Provider "${seed.name}" already exists — leaving it untouched.`);
      continue;
    }

    await Provider.create({ ...seed, usedBytes: 0, isActive: true });
    console.log(
      `Seeded provider "${seed.name}" (priority ${seed.priority}, limit ${(seed.freeLimitBytes / GB).toFixed(0)}GB)`
    );
  }

  console.log("Done.");
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Seeding failed:", err.message);
    mongoose.disconnect().finally(() => process.exit(1));
  });