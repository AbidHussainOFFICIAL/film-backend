// backend/controllers/logController.js

const Sentry = require("@sentry/node");
const IngestionLog = require("../models/IngestionLog");

// GET /api/admin/logs?limit=20
// Ingestion runs write a log entry on every run (see
// services/ingestionService.js's logIngestionRun) — this is the first
// place that data is actually surfaced anywhere in the admin panel.
async function listIngestionLogs(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const logs = await IngestionLog.find().sort({ runDate: -1 }).limit(limit);
    res.json(logs);
  } catch (err) {
    console.error("Error listing ingestion logs:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to list ingestion logs" });
  }
}

module.exports = { listIngestionLogs };