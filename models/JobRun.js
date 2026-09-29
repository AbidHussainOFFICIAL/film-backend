// backend/models/JobRun.js

const { Schema, model } = require("mongoose");

// Slice 18 — finished runs older than this are pruned automatically by a
// MongoDB TTL index (see below). The /admin/tools page only ever shows
// the 5 most recent runs per job type, so anything older is just
// accumulating weight in the free-tier database for no reader.
const JOB_RUN_RETENTION_SECONDS = 90 * 24 * 60 * 60; // 90 days

/**
 * Tracks admin-triggered jobs that run on the heavy backend (ingestion,
 * Qdrant reindex). This is the light backend's own bookkeeping — the
 * heavy backend never reads or writes MongoDB directly; it only reports
 * status back through the /api/service/jobs/:id endpoints, which update
 * these records.
 *
 * Not used for upload processing — that's tracked on the Film document's
 * own transcodeStatus field instead, since it's naturally tied to one
 * film rather than being a standalone run.
 */
const jobRunSchema = new Schema({
  type: { type: String, enum: ["ingest", "qdrant-reindex"], required: true },
  status: {
    type: String,
    enum: ["triggered", "running", "completed", "failed"],
    default: "triggered",
  },
  triggeredBy: String, // admin's email/uid
  result: Schema.Types.Mixed, // shape depends on type — counts, summaries
  error: String,
  startedAt: Date,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now },
});

jobRunSchema.index({ type: 1, createdAt: -1 });
// TTL: MongoDB deletes each document once createdAt is this old.
jobRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: JOB_RUN_RETENTION_SECONDS });

module.exports = model("JobRun", jobRunSchema);
