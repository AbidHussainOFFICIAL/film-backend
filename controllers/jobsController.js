// backend/controllers/jobsController.js

const Sentry = require("@sentry/node");
const JobRun = require("../models/JobRun");
const { triggerIngest, triggerQdrantReindex } = require("../services/githubActions");

const TRIGGERABLE_TYPES = ["ingest", "qdrant-reindex"];

// POST /api/admin/jobs/:jobType/trigger
async function triggerJob(req, res) {
  try {
    const { jobType } = req.params;
    if (!TRIGGERABLE_TYPES.includes(jobType)) {
      return res.status(400).json({ error: `jobType must be one of: ${TRIGGERABLE_TYPES.join(", ")}` });
    }

    const job = await JobRun.create({
      type: jobType,
      status: "triggered",
      triggeredBy: req.user?.email || req.user?.uid,
    });

    try {
      if (jobType === "ingest") {
        await triggerIngest(job._id);
      } else {
        await triggerQdrantReindex(job._id);
      }
    } catch (dispatchErr) {
      console.error(`Failed to dispatch ${jobType} job ${job._id}:`, dispatchErr.message);
      Sentry.captureException(dispatchErr);
      job.status = "failed";
      job.error = dispatchErr.message;
      job.completedAt = new Date();
      await job.save();
    }

    res.status(201).json(job);
  } catch (err) {
    console.error("Error triggering job:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to trigger job" });
  }
}

// GET /api/admin/jobs/:id
async function getJob(req, res) {
  try {
    const job = await JobRun.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    console.error("Error fetching job:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid job id" });
    res.status(500).json({ error: "Failed to fetch job" });
  }
}

// GET /api/admin/jobs?type=ingest&limit=5
async function listJobs(req, res) {
  try {
    const { type, limit } = req.query;
    const query = type ? { type } : {};
    const jobs = await JobRun.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 10, 50));
    res.json(jobs);
  } catch (err) {
    console.error("Error listing jobs:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to list jobs" });
  }
}

module.exports = { triggerJob, getJob, listJobs };
