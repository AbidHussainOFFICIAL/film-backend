// backend/services/categoryService.js

const Category = require("../models/Category");

/**
 * Increments filmCount for every category a newly-approved film belongs
 * to. Called from every path that makes a film newly-approved: manual
 * admin approval (adminController.approveFilm), own-upload
 * auto-approval (serviceController's post-processing callback), and
 * restoring a previously-rejected film back to approved
 * (filmManagementController.restoreFilm).
 *
 * Best-effort by design, matching this project's existing pattern for
 * side effects that shouldn't block or undo the approval itself: a
 * transient DB hiccup here just means filmCount drifts slightly stale
 * until the next backfill (scripts/backfillCategories.js), not that the
 * approval fails.
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

/**
 * Symmetric with incrementCategoryCounts above — added in Slice 13, when
 * an approved film can leave that state for the first time (Remove →
 * rejected, or Delete → gone entirely). Before this, filmCount was
 * genuinely increment-only, on the stated assumption that "an approved
 * film never actually gets rejected through the real UI" (see the
 * header comment on models/Category.js) — Slice 13 makes that assumption
 * false, so a real decrement path is required now.
 *
 * Callers are responsible for only calling this when the film was
 * ACTUALLY approved before the transition that's removing it — a
 * still-pending film was never counted in the first place, so
 * rejecting/deleting one must never decrement anything (see
 * adminController.rejectOrRemoveFilm and
 * services/filmDeletionService.js for where that guard lives).
 *
 * Best-effort, same as incrementCategoryCounts — a transient DB hiccup
 * here just means filmCount drifts slightly stale until the next
 * backfill, not that the calling action fails.
 */
async function decrementCategoryCounts(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return;

  try {
    await Category.updateMany(
      { name: { $in: categories } },
      { $inc: { filmCount: -1 } }
    );
  } catch (err) {
    console.error("Failed to decrement category counts:", err.message);
  }
}

module.exports = { incrementCategoryCounts, decrementCategoryCounts };
