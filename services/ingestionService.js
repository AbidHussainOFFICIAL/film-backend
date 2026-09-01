// backend/services/ingestionService.js

const Film = require("../models/Film");
const IngestionLog = require("../models/IngestionLog");
const { mapToTaxonomy } = require("./categoryMapper");

/**
 * Given candidate identifiers/hashes the heavy backend found on
 * Archive.org, returns which ones already exist — so the heavy backend
 * can skip expensive TMDb lookups for films it would just discard anyway.
 */
async function checkExisting(identifiers = [], hashes = []) {
  const existing = await Film.find(
    { $or: [{ archiveIdentifier: { $in: identifiers } }, { fileHash: { $in: hashes } }] },
    { archiveIdentifier: 1, fileHash: 1 }
  );

  return {
    existingIdentifiers: existing.map((f) => f.archiveIdentifier).filter(Boolean),
    existingHashes: existing.map((f) => f.fileHash).filter(Boolean),
  };
}

/**
 * Inserts a finished batch of enriched film data from the heavy backend's
 * ingestion run. Idempotent — relies on Film's unique+sparse indexes on
 * archiveIdentifier/fileHash to catch any race-condition duplicates that
 * slipped past the heavy backend's own checkExisting call.
 *
 * category is mapped through the fixed taxonomy here — TMDb's raw genre
 * strings aren't guaranteed to match it exactly, and the heavy backend
 * doesn't have access to this mapping logic (it's a separate repo), so
 * this is the one place that guarantee actually gets enforced for
 * archive.org-sourced films.
 */
async function insertBatch(films = []) {
  let inserted = 0;
  let duplicate = 0;
  let errored = 0;
  const errors = [];

  for (const film of films) {
    try {
      await Film.create({
        ...film,
        category: mapToTaxonomy(film.category),
        status: "pending",
      });
      inserted += 1;
    } catch (err) {
      if (err?.code === 11000) {
        duplicate += 1;
      } else {
        errored += 1;
        errors.push(`${film.archiveIdentifier || film.title}: ${err.message}`);
      }
    }
  }

  return { inserted, duplicate, errored, errors };
}

async function logIngestionRun({ itemsFound, inserted, duplicate, errored, errors }) {
  const status = errored === 0 ? "success" : inserted > 0 || duplicate > 0 ? "partial" : "failed";

  return IngestionLog.create({
    source: "archive.org",
    itemsFound,
    itemsInserted: inserted,
    itemsDuplicate: duplicate,
    itemsErrored: errored,
    errors,
    status,
  });
}

module.exports = { checkExisting, insertBatch, logIngestionRun };
