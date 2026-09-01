// backend/services/categoryMapper.js

const { CATEGORIES } = require("../constants/categories");

const KNOWN_NAMES = new Set(CATEGORIES.map((c) => c.name));

/**
 * Maps an array of raw category strings (from TMDb's genre list, or
 * free-typed by an admin on an own-upload) onto the fixed taxonomy.
 * Exact, case-sensitive match against CATEGORIES — deliberately not
 * fuzzy, since CATEGORIES was chosen to already mirror TMDb's genre
 * strings verbatim. Anything that doesn't match is dropped; if nothing
 * in the input matches at all, falls back to ["Uncategorized"] so a film
 * is never left with an empty category array.
 *
 * Called from both the ingestion path (services/ingestionService.js) and
 * the own-upload path (controllers/uploadController.js) — every entry
 * point that can set Film.category runs through this, so the invariant
 * "Film.category only ever contains valid taxonomy names" always holds,
 * regardless of how the film got there.
 */
function mapToTaxonomy(rawCategories) {
  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    return ["Uncategorized"];
  }

  const mapped = rawCategories
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => KNOWN_NAMES.has(name));

  // Dedupe while preserving order, in case the input had repeats.
  const deduped = [...new Set(mapped)];

  return deduped.length > 0 ? deduped : ["Uncategorized"];
}

module.exports = { mapToTaxonomy };