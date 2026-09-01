// backend/models/Category.js

const { Schema, model } = require("mongoose");

/**
 * The managed category taxonomy. Deliberately minimal — no
 * parentCategory or displayOrder fields, since there's no current need
 * for subcategories or manual ordering; add them later if a real need
 * shows up rather than speculatively now.
 *
 * filmCount is denormalized — incremented when a film is approved (see
 * services/categoryService.js), recomputed from scratch by
 * scripts/backfillCategories.js. It is NOT decremented when a film is
 * rejected: in practice, the admin queue only ever offers Reject on
 * still-pending films, so approved films are never actually rejected
 * through the real UI — tracking that transition would be defensive
 * complexity for a path that doesn't occur.
 */
const categorySchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true },
  description: String,
  filmCount: { type: Number, default: 0 },
});

module.exports = model("Category", categorySchema);