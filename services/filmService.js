// backend/services/filmService.js

const Film = require("../models/Film");

// Slice 18 — the browse grid and search results only render a poster
// card (title/year/runtime/genres/rating) plus the client-side
// title/director/cast/tag text filter. They never need the heavy
// renditions/audioTracks/subtitleTracks arrays, manifest/stream URLs,
// or admin-only status fields, so those are never even read from Mongo
// for list views. Kept next to the queries that use it so the two can't
// drift apart; the matching public whitelist lives in
// services/publicFilmView.js.
const SUMMARY_PROJECTION =
  "title year runtime category tags posterUrl director cast ratings avgRating ratingCount views addedDate";

// Slice 18 — the /admin/films list renders a card per film and never
// shows these heavy or unused fields, so they're excluded from that one
// list query. Any single-film action returns the full document.
const ADMIN_LIST_EXCLUDED_FIELDS = "-renditions -audioTracks -description -license -embeddingId -fileHash";

// Only approved films are ever shown on the public site. Lean summaries
// (plain objects, summary fields only) — see SUMMARY_PROJECTION.
async function getApprovedFilmSummaries() {
  return Film.find({ status: "approved" }).select(SUMMARY_PROJECTION).sort({ addedDate: -1 }).lean();
}

async function getFilmById(id) {
  return Film.findById(id);
}

// Used by the admin queue — any status, not just approved
async function getFilmsByStatus(status) {
  return Film.find({ status }).sort({ addedDate: -1 });
}

// Every film regardless of status (Slice 13) — backs /admin/films, the
// "manage everything" view. Unlike getFilmsByStatus, this applies no
// status filter at all; the frontend fetches once and filters
// client-side by title/status tab, the same pattern /browse's FilmGrid
// already uses at this catalog size. Slice 18 — lean projection, see
// ADMIN_LIST_EXCLUDED_FIELDS. Returns full (non-lean) documents minus
// those fields so callers still get normal Mongoose serialization.
async function getAllFilms() {
  return Film.find({}).select(ADMIN_LIST_EXCLUDED_FIELDS).sort({ addedDate: -1 });
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
// never leak pending/rejected titles even if something stale is in
// Qdrant. Lean summaries, same shape as the browse list.
async function getFilmSummariesByIds(ids) {
  return Film.find({ _id: { $in: ids }, status: "approved" }).select(SUMMARY_PROJECTION).lean();
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
  getApprovedFilmSummaries,
  getFilmById,
  getFilmsByStatus,
  getAllFilms,
  getUnhealthyFilms,
  setFilmStatus,
  getFilmSummariesByIds,
  getFilmsForEmbedding,
};
