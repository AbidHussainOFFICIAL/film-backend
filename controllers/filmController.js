// backend/controllers/filmController.js

const Sentry = require("@sentry/node");
const filmService = require("../services/filmService");

// GET /api/films
async function listApprovedFilms(req, res) {
  try {
    const films = await filmService.getApprovedFilms();
    res.json(films);
  } catch (err) {
    console.error("Error fetching films:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to fetch films" });
  }
}

// GET /api/films/:id
async function getFilm(req, res) {
  try {
    const film = await filmService.getFilmById(req.params.id);
    if (!film) {
      return res.status(404).json({ error: "Film not found" });
    }
    res.json(film);
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
