// backend/models/IngestionLog.js

const { Schema, model } = require("mongoose");

// Slice 18 — the /admin/logs page only ever shows the most recent runs,
// so older entries are pruned automatically by a MongoDB TTL index (see
// below) instead of accumulating forever.
const INGESTION_LOG_RETENTION_SECONDS = 180 * 24 * 60 * 60; // 180 days

const ingestionLogSchema = new Schema(
  {
    source: String, // "archive.org"
    runDate: { type: Date, default: Date.now },
    itemsFound: Number,
    itemsInserted: Number,
    itemsDuplicate: Number,
    itemsErrored: Number,
    errors: [String],
    status: { type: String, enum: ["success", "partial", "failed"] }
  },
  { suppressReservedKeysWarning: true } // `errors` is intentional here, not a mistake
);

ingestionLogSchema.index({ source: 1, runDate: -1 });
// TTL: MongoDB deletes each document once runDate is this old.
ingestionLogSchema.index({ runDate: 1 }, { expireAfterSeconds: INGESTION_LOG_RETENTION_SECONDS });

module.exports = model("IngestionLog", ingestionLogSchema);
