// backend/routes/adminRoutes.js

const express = require("express");
const router = express.Router();
const verifyFirebaseToken = require("../middleware/verifyFirebaseToken");
const adminController = require("../controllers/adminController");
const uploadController = require("../controllers/uploadController");
const providerController = require("../controllers/providerController");
const logController = require("../controllers/logController");

// Every route below requires a valid Firebase ID token
router.use(verifyFirebaseToken);

// GET /api/admin/films?status=pending
router.get("/films", adminController.listFilmsByStatus);

// GET /api/admin/films/unhealthy — approved films with a failed
// link-health check (see scripts/checkLinks.js). Mounted before the
// :id-shaped approve/reject routes below since "unhealthy" isn't a film
// id, but Express matches routes in declaration order regardless — kept
// up here for readability, next to the other films listing route.
router.get("/films/unhealthy", adminController.listUnhealthyFilms);

// POST /api/admin/films/:id/approve
router.post("/films/:id/approve", adminController.approveFilm);

// POST /api/admin/films/:id/reject
router.post("/films/:id/reject", adminController.rejectFilm);

// GET /api/admin/upload-url?filename=...&contentType=...&fileSizeBytes=...&fingerprint=...
router.get("/upload-url", uploadController.getUploadUrl);

// POST /api/admin/uploads
router.post("/uploads", uploadController.createUpload);

// POST /api/admin/uploads/:id/retry-processing
router.post("/uploads/:id/retry-processing", uploadController.retryProcessing);

// POST /api/admin/qdrant/init — synchronous wrapper around
// services/qdrantService.ensureCollection(), so the admin storage page
// can (re)initialize the search collection without needing shell access
// to run scripts/initQdrant.js locally.
router.post("/qdrant/init", providerController.initQdrantCollection);

// GET /api/admin/logs?limit=20 — recent ingestion runs (see
// models/IngestionLog.js) — this data was already being written, just
// never surfaced anywhere until now.
router.get("/logs", logController.listIngestionLogs);

module.exports = router;
