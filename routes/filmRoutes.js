// backend/routes/filmRoutes.js

const express = require("express");
const router = express.Router();
const filmController = require("../controllers/filmController");

// GET /api/films - all approved films
router.get("/", filmController.listApprovedFilms);

// GET /api/films/:id - a single film by its Mongo _id
router.get("/:id", filmController.getFilm);

module.exports = router;
