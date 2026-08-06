/**
 * backend/scripts/initQdrant.js
 *
 * Creates the Qdrant collection if it doesn't already exist. Safe to run
 * more than once — it's an existence check, not a destructive re-create.
 *
 * Run: node scripts/initQdrant.js
 */

require("dotenv").config();
const { ensureCollection, COLLECTION_NAME } = require("../services/qdrantService");

ensureCollection()
  .then(() => {
    console.log(`Qdrant collection "${COLLECTION_NAME}" is ready.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed to set up the Qdrant collection:", err.message);
    process.exit(1);
  });
