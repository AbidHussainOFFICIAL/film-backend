// backend/routes/categoryRoutes.js

const express = require("express");
const router = express.Router();
const categoryController = require("../controllers/categoryController");

// GET /api/categories — public, no auth
router.get("/", categoryController.listCategories);

module.exports = router;