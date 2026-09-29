// backend/controllers/filmController.js

const Sentry = require("@sentry/node");
const filmService = require("../services/filmService");
const { toPublicFilm, toPublicFilmSummaries } = require("../services/publicFilmView");

// GET /api/films — lean summaries for the browse grid and sitemap
async function listApprovedFilms(req, res) {
  try {
    const films = await filmService.getApprovedFilmSummaries();
    res.json(toPublicFilmSummaries(films));
  } catch (err) {
    console.error("Error fetching films:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to fetch films" });
  }
}

// GET /api/films/:id — the full public detail shape for one film.
// Deliberately NOT restricted to approved films: the admin queue's
// "Preview" link opens this same page for still-pending films, and the
// server-rendered page has no admin token to distinguish an admin from a
// visitor. What a visitor can see is limited by the field whitelist
// (services/publicFilmView.js), and ids are unguessable ObjectIds.
async function getFilm(req, res) {
  try {
    const film = await filmService.getFilmById(req.params.id);
    if (!film) {
      return res.status(404).json({ error: "Film not found" });
    }
    res.json(toPublicFilm(film));
  } catch (err) {
    console.error("Error fetching film:", err);
    Sentry.captureException(err);
    // Bad ObjectId format lands here too — respond 400 instead of a raw 500
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid film id" });
    }
    res.status(500).json({ error: "Failed to fetch film" });
  }
}

module.exports = {
  listApprovedFilms,
  getFilm,
};
