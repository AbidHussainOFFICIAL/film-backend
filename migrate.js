require("dotenv").config();
const mongoose = require("mongoose");
const dns = require("dns");

// Force IPv4 for DNS resolution to avoid common issues with SRV records and IPv6
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const Film = require("./models/Film");

async function migrate() {
  try {
    console.log("Connecting to MongoDB (using explicit hosts)...");
    const explicitUri = "mongodb://wowcartoon786a_db_user:56KKSfI3UzAv75A5@ac-2mljwc6-shard-00-00.hzgnx4n.mongodb.net:27017,ac-2mljwc6-shard-00-01.hzgnx4n.mongodb.net:27017,ac-2mljwc6-shard-00-02.hzgnx4n.mongodb.net:27017/film?ssl=true&authSource=admin&retryWrites=true&w=majority";
    await mongoose.connect(explicitUri);
    console.log("Connected.");

    // Drop the truly-dead fields left over from the old schema.
    console.log("Unsetting dead fields...");
    const unsetResult = await Film.updateMany({}, { $unset: {
      telegramPost: "", whatsappPost: "", ladderTier: "", ladderOverride: ""
    }});
    console.log(`Updated ${unsetResult.modifiedCount} documents (unset dead fields).`);

    // Convert any film still holding the OLD flat string[] cast into the
    // new [{name}] shape, so the admin cast display never chokes on a
    // string where it expects an object. Films with no cast, or already
    // in the new shape, are left untouched.
    console.log("Checking for string cast fields...");
    const films = await Film.find({ "cast.0": { $type: "string" } }, { cast: 1 });
    console.log(`Found ${films.length} film(s) to migrate cast.`);

    for (const f of films) {
      f.cast = f.cast.map((name) => ({ name }));
      await f.save();
    }
    
    console.log(`Migrated ${films.length} film(s) cast.`);
    console.log("Migration complete.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
}

migrate();
