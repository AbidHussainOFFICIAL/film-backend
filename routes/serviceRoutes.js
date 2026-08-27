// backend/routes/serviceRoutes.js

const express = require("express");
const router = express.Router();
const verifyServiceSecret = require("../middleware/verifyServiceSecret");
const serviceController = require("../controllers/serviceController");

// Every route here is called by the heavy backend (GitHub Actions), never
// by a browser — authenticated with a shared secret, not Firebase.
router.use(verifyServiceSecret);

router.post("/films/check-existing", serviceController.checkExistingFilms);
router.post("/films/ingest-batch", serviceController.ingestBatch);
router.get("/films/for-embedding", serviceController.listFilmsForEmbedding);

router.post("/jobs/:id/start", serviceController.startJob);
router.post("/jobs/:id/complete", serviceController.completeJob);

router.post("/uploads/:id/callback", serviceController.handleUploadCallback);

module.exports = router;
