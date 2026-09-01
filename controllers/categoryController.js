// backend/controllers/categoryController.js

const Sentry = require("@sentry/node");
const Category = require("../models/Category");

// GET /api/categories
// Public — no auth required. Used by the admin upload form's category
// picker (so own-uploads are constrained to the same taxonomy as
// ingested films), and could equally back a future public category
// browse view.
async function listCategories(req, res) {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res.json(categories);
  } catch (err) {
    console.error("Error listing categories:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to list categories" });
  }
}

module.exports = { listCategories };