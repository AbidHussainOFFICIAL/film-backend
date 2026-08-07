/**
 * backend/services/qdrantService.js
 *
 * Thin wrapper around the Qdrant Node client. Handles collection creation,
 * upserting a film's embedding, deleting one, and vector search.
 *
 * Qdrant point IDs must be either an unsigned integer or a UUID string —
 * Mongo's 24-char hex ObjectId is neither, so objectIdToUuid() deterministically
 * maps a Mongo _id to a UUID-shaped string (by zero-padding to 32 hex chars
 * and inserting dashes). It's not a random UUID, but Qdrant only validates
 * the shape, and it lets us recompute the same point ID from a film's _id
 * whenever we need to update or delete it, with no separate mapping to store.
 */

const { QdrantClient } = require("@qdrant/js-client-rest");
const { EMBEDDING_DIMENSIONS } = require("./embedding");

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || "films";

let client = null;

function getClient() {
  if (!QDRANT_URL) {
    throw new Error("Missing QDRANT_URL in .env");
  }
  if (!client) {
    client = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });
  }
  return client;
}

function objectIdToUuid(objectId) {
  const hex = String(objectId).padStart(24, "0").slice(0, 24);
  const padded = hex + "00000000"; // 24 + 8 = 32 hex chars total
  return [
    padded.slice(0, 8),
    padded.slice(8, 12),
    padded.slice(12, 16),
    padded.slice(16, 20),
    padded.slice(20, 32),
  ].join("-");
}

/**
 * Creates the collection if it doesn't already exist. Safe to call on
 * every request — it's a cheap existence check, not a re-create.
 */
async function ensureCollection() {
  const c = getClient();
  const { collections } = await c.getCollections();
  const exists = collections.some((col) => col.name === COLLECTION_NAME);

  if (!exists) {
    await c.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
    });
    console.log(`Created Qdrant collection "${COLLECTION_NAME}"`);
  }

  return c;
}

async function upsertFilmEmbedding(filmId, vector, payload = {}) {
  const c = await ensureCollection();
  const pointId = objectIdToUuid(filmId);

  await c.upsert(COLLECTION_NAME, {
    points: [
      {
        id: pointId,
        vector,
        payload: { filmId: String(filmId), ...payload },
      },
    ],
  });

  return pointId;
}

async function deleteFilmEmbedding(filmId) {
  try {
    const c = getClient();
    const pointId = objectIdToUuid(filmId);
    await c.delete(COLLECTION_NAME, { points: [pointId] });
  } catch (err) {
    // Best-effort cleanup — a missing point or unreachable Qdrant here
    // shouldn't block a reject action from succeeding in Mongo.
    console.warn(`Could not delete Qdrant point for film ${filmId}:`, err.message);
  }
}

// Cosine similarity below this is treated as "not actually relevant" rather
// than included just because it's the nearest available point. With a small
// film collection, vector search will always return *something* for any
// query — this threshold is what keeps unrelated queries returning empty
// instead of the 5 least-irrelevant films. Tune via SEARCH_SCORE_THRESHOLD
// in .env if results feel too strict or too loose.
const DEFAULT_SCORE_THRESHOLD = Number(process.env.SEARCH_SCORE_THRESHOLD || 0.45);

async function searchSimilarFilms(vector, limit = 20, scoreThreshold = DEFAULT_SCORE_THRESHOLD) {
  const c = await ensureCollection();
  const result = await c.query(COLLECTION_NAME, {
    query: vector,
    limit,
    with_payload: true,
    score_threshold: scoreThreshold,
  });
  // Newer client versions wrap results in { points: [...] } instead of
  // returning a plain array directly.
  return result?.points || [];
}

module.exports = {
  getClient,
  ensureCollection,
  upsertFilmEmbedding,
  deleteFilmEmbedding,
  searchSimilarFilms,
  objectIdToUuid,
  COLLECTION_NAME,
};
