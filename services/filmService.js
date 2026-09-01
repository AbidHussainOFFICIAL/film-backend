// backend/services/filmService.js

const Film = require("../models/Film");

// Only approved films are ever shown on the public site
async function getApprovedFilms() {
  return Film.find({ status: "approved" }).sort({ addedDate: -1 });
}

async function getFilmById(id) {
  return Film.findById(id);
}

// Used by the admin queue — any status, not just approved
async function getFilmsByStatus(status) {
  return Film.find({ status }).sort({ addedDate: -1 });
}

// Approved films whose last link-health check came back unhealthy — see
// scripts/checkLinks.js (runs weekly via film-media-worker). Only ever
// meaningful for approved films: pending/rejected films are never
// stream-checked in the first place.
async function getUnhealthyFilms() {
  return Film.find({ status: "approved", "linkHealth.isHealthy": false }).sort({
    "linkHealth.lastChecked": -1,
  });
}

async function setFilmStatus(id, status, extra = {}) {
  return Film.findByIdAndUpdate(
    id,
    { status, updatedDate: new Date(), ...extra },
    { new: true }
  );
}

// Only approved films are ever returned here — search results should
// never leak pending/rejected titles even if something stale is in Qdrant.
async function getFilmsByIds(ids) {
  return Film.find({ _id: { $in: ids }, status: "approved" });
}

// Minimal fields needed to build an embedding — used by the heavy
// backend's Qdrant reindex job via the /api/service endpoint, not
// exposed publicly.
async function getFilmsForEmbedding() {
  return Film.find(
    { status: "approved" },
    { title: 1, description: 1, tags: 1, category: 1, year: 1 }
  );
}

module.exports = {
  getApprovedFilms,
  getFilmById,
  getFilmsByStatus,
  getUnhealthyFilms,
  setFilmStatus,
  getFilmsByIds,
  getFilmsForEmbedding,
};
