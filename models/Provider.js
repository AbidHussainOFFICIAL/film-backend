// backend/models/Provider.js

const { Schema, model } = require("mongoose");

/**
 * Tracks per-provider usage/limits/priority for the multi-provider
 * storage router (see services/storageRouter.js). Deliberately holds NO
 * credentials — those stay in env vars, same as every other integration
 * in this project (R2/Qdrant/Telegram/WhatsApp all follow this rule).
 * This model is pure bookkeeping: which providers exist, how much free
 * capacity each has, and in what priority order to fill them.
 *
 * freeLimitBytes/priority/isActive are admin-editable via
 * /admin/storage (see routes/providerRoutes.js). usedBytes is NOT
 * editable through that route — it's server-derived, incremented by
 * storageRouter.reserveUploadSlot() each time a provider is chosen for
 * an upload.
 */
const providerSchema = new Schema(
  {
    name: { type: String, enum: ["r2", "b2", "storj"], required: true, unique: true },
    freeLimitBytes: { type: Number, required: true },
    usedBytes: { type: Number, default: 0 },
    priority: { type: Number, required: true }, // lower = tried first
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

providerSchema.index({ priority: 1 });

module.exports = model("Provider", providerSchema);