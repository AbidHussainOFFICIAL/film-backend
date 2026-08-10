const express = require("express");
const router = express.Router();
const verifyFirebaseToken = require("../middleware/verifyFirebaseToken");
const adminController = require("../controllers/adminController");
const uploadController = require("../controllers/uploadController");

// Every route below requires a valid Firebase ID token
router.use(verifyFirebaseToken);

// GET /api/admin/films?status=pending
router.get("/films", adminController.listFilmsByStatus);

// POST /api/admin/films/:id/approve
router.post("/films/:id/approve", adminController.approveFilm);

// POST /api/admin/films/:id/reject
router.post("/films/:id/reject", adminController.rejectFilm);

// GET /api/admin/upload-url?filename=...&contentType=...
router.get("/upload-url", uploadController.getUploadUrl);

// POST /api/admin/uploads
router.post("/uploads", uploadController.createUpload);

// POST /api/admin/uploads/:id/retry-processing
router.post("/uploads/:id/retry-processing", uploadController.retryProcessing);

module.exports = router;
