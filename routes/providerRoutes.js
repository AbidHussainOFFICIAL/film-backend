// backend/routes/providerRoutes.js

const express = require("express");
const router = express.Router();
const verifyFirebaseToken = require("../middleware/verifyFirebaseToken");
const providerController = require("../controllers/providerController");

router.use(verifyFirebaseToken);

// GET /api/admin/providers
router.get("/", providerController.listProviders);

// PATCH /api/admin/providers/:id
router.patch("/:id", providerController.updateProvider);

module.exports = router;