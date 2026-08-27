// backend/routes/searchRoutes.js

const express = require("express");
const router = express.Router();
const searchController = require("../controllers/searchController");

// GET /api/search?q=...
router.get("/", searchController.searchFilms);

module.exports = router;
