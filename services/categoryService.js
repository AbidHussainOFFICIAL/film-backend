// backend/services/categoryService.js

const Category = require("../models/Category");

/**
 * Increments filmCount for every category a newly-approved film belongs
 * to. Called from both approval paths (adminController.approveFilm and
 * serviceController's own-upload auto-approve) — see Category.js's
 * header comment for why this is increment-only, no decrement path.
 *
 * Best-effort by design, matching this project's existing pattern for
 * side effects that shouldn't block or undo the approval itself: a
 * transient DB hiccup here just means filmCount drifts slightly stale
 * until the next backfill, not that the approval fails.
 */
async function incrementCategoryCounts(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return;

  try {
    await Category.updateMany(
      { name: { $in: categories } },
      { $inc: { filmCount: 1 } }
    );
  } catch (err) {
    console.error("Failed to increment category counts:", err.message);
  }
}

module.exports = { incrementCategoryCounts };