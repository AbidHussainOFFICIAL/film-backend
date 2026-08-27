// backend/models/IngestionLog.js

const { Schema, model } = require("mongoose");

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

module.exports = model("IngestionLog", ingestionLogSchema);
