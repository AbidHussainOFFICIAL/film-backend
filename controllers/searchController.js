// backend/controllers/searchController.js

const Sentry = require("@sentry/node");
const filmService = require("../services/filmService");
const { getEmbedding } = require("../services/embedding");
const { searchSimilarFilms } = require("../services/qdrantService");

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// GET /api/search?q=...&limit=20
async function searchFilms(req, res) {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) {
      return res.status(400).json({ error: "Missing required query parameter: q" });
    }

    const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

    const vector = await getEmbedding(q, { taskType: "query" });
    const results = await searchSimilarFilms(vector, limit);

    // Qdrant returns ranked results with each film's Mongo _id in its
    // payload. Fetch the real documents from Mongo (so we always return
    // current, approved data) but preserve Qdrant's relevance ordering.
    const orderedIds = results.map((r) => r.payload?.filmId).filter(Boolean);
    const films = await filmService.getFilmsByIds(orderedIds);
    const filmById = new Map(films.map((f) => [String(f._id), f]));

    const ordered = orderedIds.map((id) => filmById.get(id)).filter(Boolean);

    res.json(ordered);
  } catch (err) {
    console.error("Search error:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Search failed" });
  }
}

module.exports = { searchFilms };
