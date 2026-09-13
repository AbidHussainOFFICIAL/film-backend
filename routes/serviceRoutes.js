// backend/routes/serviceRoutes.js

const express = require("express");
const router = express.Router();
const verifyServiceSecret = require("../middleware/verifyServiceSecret");
const serviceController = require("../controllers/serviceController");

// Every route here is called by CI (the heavy backend's GitHub Actions
// workflows, or film-frontend's build-apk.yml), never by a browser —
// authenticated with a shared secret, not Firebase.
router.use(verifyServiceSecret);

router.post("/films/check-existing", serviceController.checkExistingFilms);
router.post("/films/ingest-batch", serviceController.ingestBatch);
router.get("/films/for-embedding", serviceController.listFilmsForEmbedding);

// GET /api/service/films/for-link-check + POST .../link-health-batch —
// used by film-media-worker's checkLinks.js (weekly link-health sweep).
router.get("/films/for-link-check", serviceController.listFilmsForLinkCheck);
router.post("/films/link-health-batch", serviceController.reportLinkHealthBatch);

router.post("/jobs/:id/start", serviceController.startJob);
router.post("/jobs/:id/complete", serviceController.completeJob);

router.post("/uploads/:id/callback", serviceController.handleUploadCallback);

// POST /api/service/transcodes/reconcile-stuck (Slice 14) — called every
// 30 minutes by film-media-worker's reconcile-transcodes.yml cron. Finds
// own-uploads stuck in transcodeStatus: "processing" past a timeout,
// retries once, then gives up and marks them failed.
router.post("/transcodes/reconcile-stuck", serviceController.reconcileStuckTranscodes);

// GET /api/service/apk/upload-url — called by film-frontend's
// build-apk.yml to get a presigned R2 upload URL for the built APK.
router.get("/apk/upload-url", serviceController.getApkUploadUrl);

module.exports = router;
