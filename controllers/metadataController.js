// backend/controllers/metadataController.js

/**
 * Slice 18 — the admin-facing movie-metadata flow: search TMDb, let the
 * admin confirm a match (never auto-applied — common titles like "Home"
 * or "1917" could easily match the wrong entry and silently attach the
 * wrong cast/trailer/poster), then populate cast/trailer/poster/summary
 * in one write. Ratings (OMDb) are a deliberately separate action — see
 * fetchRatings below.
 */

const Sentry = require("@sentry/node");
const Film = require("../models/Film");
const { searchMovies, getMovieDetails } = require("../services/tmdb");
const { getRatings } = require("../services/omdb");
const { searchTrailer } = require("../services/youtube");
const { mapToTaxonomy } = require("../services/categoryMapper");

// GET /api/admin/films/:id/metadata/search?query=...&year=...
// Defaults query/year to the film's own title/year if not supplied, so
// the admin can just click "Find metadata" without retyping the title.
async function searchMetadata(req, res) {
  try {
    const film = await Film.findById(req.params.id, { title: 1, year: 1 });
    if (!film) return res.status(404).json({ error: "Film not found" });

    const query = (req.query.query || film.title || "").toString().trim();
    if (!query) {
      return res.status(400).json({ error: "No title to search with" });
    }
    const year = req.query.year || film.year;

    const candidates = await searchMovies(query, year);
    res.json(candidates);
  } catch (err) {
    console.error("Error searching TMDb metadata:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: err.message || "Failed to search TMDb" });
  }
}

// POST /api/admin/films/:id/metadata/apply
// Body: { tmdbId: number }
//
// The one place a match becomes real data on the film — only reachable
// after the admin has looked at candidate results (title/year/poster)
// from searchMetadata above and picked one. Overwrites description,
// poster/backdrop, cast, director, tmdbId/imdbId and trailer
// unconditionally (the admin just confirmed this exact match is
// correct, so these are meant to be replaced). year/country/
// originalTitle/runtime are filled in only if the film doesn't already
// have them — own-uploads in particular already have a REAL measured
// runtime from ffprobe, which TMDb's canonical runtime (theatrical cut,
// possibly different from this specific file) shouldn't silently
// overwrite. category is left untouched unless the film currently has
// no real category (empty, or only the "Uncategorized" fallback) — an
// admin's deliberate manual categorization is never clobbered by an
// enrichment action.
async function applyMetadata(req, res) {
  try {
    const { tmdbId } = req.body;
    if (!tmdbId) {
      return res.status(400).json({ error: "Missing required field: tmdbId" });
    }

    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: "Film not found" });

    const details = await getMovieDetails(tmdbId);

    // TMDb's own /videos didn't have a usable trailer — fall back to a
    // single YouTube search. Best-effort: a fallback failure (missing
    // key, quota, network) should not block the rest of the enrichment
    // from applying.
    let trailerYoutubeKey = details.trailerYoutubeKey;
    let trailerSource = trailerYoutubeKey ? "tmdb" : undefined;
    if (!trailerYoutubeKey) {
      try {
        const fallbackKey = await searchTrailer(details.title, details.year);
        if (fallbackKey) {
          trailerYoutubeKey = fallbackKey;
          trailerSource = "youtube";
        }
      } catch (trailerErr) {
        console.warn(`YouTube trailer fallback failed for film ${film._id}:`, trailerErr.message);
      }
    }

    film.tmdbId = details.tmdbId;
    film.imdbId = details.imdbId;
    film.description = details.overview || film.description;
    film.posterUrl = details.posterUrl || film.posterUrl;
    film.backdropUrl = details.backdropUrl || film.backdropUrl;
    if (details.cast.length > 0) film.cast = details.cast;
    if (details.director) film.director = details.director;
    film.trailerYoutubeKey = trailerYoutubeKey || undefined;
    film.trailerSource = trailerSource;
    film.metadataSource = "tmdb";
    film.metadataEnrichedAt = new Date();

    if (!film.year && details.year) film.year = details.year;
    if (!film.country && details.country) film.country = details.country;
    if (!film.originalTitle && details.originalTitle) film.originalTitle = details.originalTitle;
    if (!film.runtime && details.runtime) film.runtime = details.runtime;

    const hasRealCategory =
      Array.isArray(film.category) &&
      film.category.length > 0 &&
      !(film.category.length === 1 && film.category[0] === "Uncategorized");
    if (!hasRealCategory && details.genres.length > 0) {
      film.category = mapToTaxonomy(details.genres);
    }

    if (typeof details.tmdbRating === "number") {
      film.ratings = { ...(film.ratings || {}), tmdb: details.tmdbRating };
    }

    await film.save();
    res.json(film);
  } catch (err) {
    console.error("Error applying TMDb metadata:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: err.message || "Failed to apply metadata" });
  }
}

// POST /api/admin/films/:id/metadata/ratings
// Deliberately separate from applyMetadata — see this file's header
// comment and services/omdb.js for why (OMDb's 1,000 req/day free cap).
async function fetchRatings(req, res) {
  try {
    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: "Film not found" });
    if (!film.imdbId) {
      return res.status(400).json({ error: "This film has no imdbId yet — apply TMDb metadata first." });
    }

    const ratings = await getRatings(film.imdbId);
    film.ratings = { ...(film.ratings || {}), ...ratings, fetchedAt: new Date() };
    await film.save();

    res.json(film);
  } catch (err) {
    console.error("Error fetching OMDb ratings:", err);
    Sentry.captureException(err);
    res.status(502).json({ error: err.message || "Failed to fetch ratings" });
  }
}

module.exports = { searchMetadata, applyMetadata, fetchRatings };
