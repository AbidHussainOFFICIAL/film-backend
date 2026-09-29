/**
 * backend/services/omdb.js
 *
 * Slice 18 — OMDb supplies IMDb / Rotten Tomatoes / Metacritic ratings,
 * looked up by imdbId (which only exists on a film once TMDb metadata
 * has been applied — see metadataController.js). Kept as its own
 * explicit admin action ("Fetch ratings"), never bundled into the TMDb
 * apply call: OMDb's free tier caps at 1,000 requests/day, real enough
 * to matter at this catalog's scale, so it shouldn't be burned on every
 * enrichment whether or not the admin cares about ratings for that film.
 */

const OMDB_API_KEY = process.env.OMDB_API_KEY;
const OMDB_BASE = "https://www.omdbapi.com/";
const FETCH_TIMEOUT_MS = 15000;

function parseRottenTomatoes(ratings) {
  const rt = (ratings || []).find((r) => r.Source === "Rotten Tomatoes");
  if (!rt) return undefined;
  const match = /^(\d+)%$/.exec(rt.Value || "");
  return match ? Number(match[1]) : undefined;
}

function parseMetascore(value) {
  if (!value || value === "N/A") return undefined;
  const match = /^(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function parseImdbRating(value) {
  if (!value || value === "N/A") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Returns { imdb, rottenTomatoes, metascore } — any of the three may be
 * undefined if OMDb didn't have that particular rating for this title.
 * Throws only on a genuine request failure (bad key, network, OMDb
 * reporting the title wasn't found) — an admin action, so the caller
 * surfaces the error directly rather than swallowing it.
 */
async function getRatings(imdbId) {
  if (!OMDB_API_KEY) {
    throw new Error("Missing OMDB_API_KEY in .env");
  }
  if (!imdbId) {
    throw new Error("No imdbId to look up — apply TMDb metadata first.");
  }

  const url = new URL(OMDB_BASE);
  url.searchParams.set("apikey", OMDB_API_KEY);
  url.searchParams.set("i", imdbId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`OMDb request failed (HTTP ${res.status})`);
    }
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  if (data.Response === "False") {
    throw new Error(`OMDb: ${data.Error || "title not found"}`);
  }

  return {
    imdb: parseImdbRating(data.imdbRating),
    rottenTomatoes: parseRottenTomatoes(data.Ratings),
    metascore: parseMetascore(data.Metascore),
  };
}

module.exports = { getRatings };
