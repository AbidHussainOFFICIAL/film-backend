const express = require("express");
const router = express.Router();
const verifyFirebaseToken = require("../middleware/verifyFirebaseToken");
const adminController = require("../controllers/adminController");

// Every route below requires a valid Firebase ID token
router.use(verifyFirebaseToken);

// GET /api/admin/films?status=pending
router.get("/films", adminController.listFilmsByStatus);

// POST /api/admin/films/:id/approve
router.post("/films/:id/approve", adminController.approveFilm);

// POST /api/admin/films/:id/reject
router.post("/films/:id/reject", adminController.rejectFilm);

module.exports = router;
