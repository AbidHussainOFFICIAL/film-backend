/**
 * backend/services/embedding.js
 *
 * Generates vector embeddings via Nomic Atlas's embeddings API, using the
 * nomic-embed-text-v1.5 model. Used both when indexing an approved film
 * into Qdrant and when embedding a user's search query at request time.
 *
 * Nomic's free tier gives a one-time allowance of 1M tokens, which is far
 * more than this project needs — after that, a paid plan is required.
 */

const NOMIC_API_KEY = process.env.NOMIC_API_KEY;
const NOMIC_EMBEDDINGS_URL = "https://api-atlas.nomic.ai/v1/embedding/text";
const EMBEDDING_MODEL = "nomic-embed-text-v1.5";
const EMBEDDING_DIMENSIONS = 768; // must match the Qdrant collection's vector size

const FETCH_TIMEOUT_MS = 15000;

/**
 * Builds the text that gets embedded for a film: title, description, tags,
 * and category all folded together so semantic search can match on plot,
 * mood, or subject matter — not just the title.
 */
function buildEmbeddingText(film) {
  const parts = [
    film.title,
    film.description,
    ...(Array.isArray(film.tags) ? film.tags : []),
    ...(Array.isArray(film.category) ? film.category : []),
  ].filter(Boolean);

  return parts.join(". ");
}

/**
 * taskType: "document" for text you're indexing (films), "query" for text
 * a user is searching with. nomic-embed-text is trained on this asymmetry
 * specifically — using the wrong one measurably hurts retrieval quality.
 */
async function getEmbedding(text, { taskType = "document" } = {}) {
  if (!NOMIC_API_KEY) {
    throw new Error("Missing NOMIC_API_KEY in .env");
  }
  if (!text || !text.trim()) {
    throw new Error("Cannot embed empty text");
  }

  const nomicTaskType = taskType === "query" ? "search_query" : "search_document";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(NOMIC_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NOMIC_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        texts: [text],
        task_type: nomicTaskType,
        dimensionality: EMBEDDING_DIMENSIONS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Nomic embeddings request failed (HTTP ${res.status}): ${errBody}`);
    }

    const data = await res.json();
    const vector = data?.embeddings?.[0];

    if (!Array.isArray(vector)) {
      throw new Error("Nomic response did not contain an embedding vector");
    }

    return vector;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getEmbedding,
  buildEmbeddingText,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
