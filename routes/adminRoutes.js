// backend/routes/adminRoutes.js

const express = require("express");
const router = express.Router();
const verifyFirebaseToken = require("../middleware/verifyFirebaseToken");
const adminController = require("../controllers/adminController");
const filmManagementController = require("../controllers/filmManagementController");
const uploadController = require("../controllers/uploadController");
const providerController = require("../controllers/providerController");
const logController = require("../controllers/logController");

// Every route below requires a valid Firebase ID token
router.use(verifyFirebaseToken);

// GET /api/admin/films?status=pending|approved|rejected|all
// "all" (Slice 13) backs /admin/films — every film regardless of
// status, fetched once and filtered client-side (see
// services/filmService.js's getAllFilms).
router.get("/films", adminController.listFilmsByStatus);

// GET /api/admin/films/unhealthy — approved films with a failed
// link-health check (see scripts/checkLinks.js). Mounted before the
// :id-shaped routes below since "unhealthy" isn't a film id, but
// Express matches routes in declaration order regardless — kept up here
// for readability, next to the other films listing route.
router.get("/films/unhealthy", adminController.listUnhealthyFilms);

// POST /api/admin/films/:id/approve
router.post("/films/:id/approve", adminController.approveFilm);

// POST /api/admin/films/:id/reject — the pending-only /admin/queue's
// Reject action.
router.post("/films/:id/reject", adminController.rejectFilm);

// --- Slice 13: film management (remove / restore / delete), used by
// /admin/films ---
// "Remove" hits the same underlying logic as "Reject" above (see
// adminController.rejectOrRemoveFilm) but is kept as its own route since
// it's a distinct admin-facing concept, called from a different page.
router.post("/films/:id/remove", filmManagementController.removeFilm);
router.post("/films/:id/restore", filmManagementController.restoreFilm);
router.delete("/films/:id", filmManagementController.deleteFilm);

// GET /api/admin/upload-url?filename=...&contentType=...&fileSizeBytes=...&fingerprint=...
router.get("/upload-url", uploadController.getUploadUrl);

// POST /api/admin/uploads
router.post("/uploads", uploadController.createUpload);

// POST /api/admin/uploads/:id/retry-processing
router.post("/uploads/:id/retry-processing", uploadController.retryProcessing);

// POST /api/admin/uploads/:id/generate-abr (Slice 15) — manually
// (re)dispatches multi-quality streaming generation for a film.
router.post("/uploads/:id/generate-abr", uploadController.generateAbr);

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
