// backend/controllers/providerController.js

const Sentry = require("@sentry/node");
const Provider = require("../models/Provider");
const { ensureCollection, COLLECTION_NAME } = require("../services/qdrantService");

// ---------------------------------------------------------------------
// Providers — usage/limits/priority shown and edited at /admin/storage
// ---------------------------------------------------------------------

const EDITABLE_FIELDS = ["freeLimitBytes", "priority", "isActive"];

// GET /api/admin/providers
async function listProviders(req, res) {
  try {
    const providers = await Provider.find().sort({ priority: 1 });
    res.json(providers);
  } catch (err) {
    console.error("Error listing providers:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to list providers" });
  }
}

// PATCH /api/admin/providers/:id
// Body: any subset of { freeLimitBytes, priority, isActive }
//
// usedBytes is deliberately never accepted here — it's server-derived
// (incremented by storageRouter.reserveUploadSlot on each upload), not
// admin-editable.
async function updateProvider(req, res) {
  try {
    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: `No editable fields provided. Editable fields: ${EDITABLE_FIELDS.join(", ")}`,
      });
    }

    if (updates.freeLimitBytes !== undefined) {
      updates.freeLimitBytes = Number(updates.freeLimitBytes);
      if (!Number.isFinite(updates.freeLimitBytes) || updates.freeLimitBytes < 0) {
        return res.status(400).json({ error: "freeLimitBytes must be a non-negative number" });
      }
    }
    if (updates.priority !== undefined) {
      updates.priority = Number(updates.priority);
      if (!Number.isFinite(updates.priority)) {
        return res.status(400).json({ error: "priority must be a number" });
      }
    }
    if (updates.isActive !== undefined) {
      updates.isActive = Boolean(updates.isActive);
    }

    const provider = await Provider.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!provider) return res.status(404).json({ error: "Provider not found" });

    res.json(provider);
  } catch (err) {
    console.error("Error updating provider:", err);
    Sentry.captureException(err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid provider id" });
    res.status(500).json({ error: "Failed to update provider" });
  }
}

// ---------------------------------------------------------------------
// Search infrastructure — Qdrant collection setup, triggerable from the
// admin storage page instead of only via scripts/initQdrant.js locally
// ---------------------------------------------------------------------

// POST /api/admin/qdrant/init
// Thin synchronous wrapper around ensureCollection(). Safe to call any
// time — it's an existence check, not a destructive re-create.
async function initQdrantCollection(req, res) {
  try {
    await ensureCollection();
    res.json({ ok: true, collection: COLLECTION_NAME });
  } catch (err) {
    console.error("Error initializing Qdrant collection:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: "Failed to initialize Qdrant collection" });
  }
}

module.exports = { listProviders, updateProvider, initQdrantCollection };