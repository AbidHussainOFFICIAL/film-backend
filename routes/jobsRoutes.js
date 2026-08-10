const express = require("express");
const router = express.Router();
const verifyFirebaseToken = require("../middleware/verifyFirebaseToken");
const jobsController = require("../controllers/jobsController");

router.use(verifyFirebaseToken);

// GET /api/admin/jobs?type=ingest&limit=5
router.get("/", jobsController.listJobs);

// GET /api/admin/jobs/:id
router.get("/:id", jobsController.getJob);

// POST /api/admin/jobs/:jobType/trigger  (jobType: "ingest" | "qdrant-reindex")
router.post("/:jobType/trigger", jobsController.triggerJob);

module.exports = router;
