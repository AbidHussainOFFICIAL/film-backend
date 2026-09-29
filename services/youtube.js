/**
 * backend/services/youtube.js
 *
 * Slice 18 — TRUE FALLBACK ONLY: called by metadataController.js only
 * when TMDb's own /movie/{id}/videos (see tmdb.js's pickTrailer) had no
 * usable YouTube trailer at all. Should rarely fire for anything with a
 * real TMDb page, keeping usage comfortably inside YouTube Data API's
 * free quota (10,000 units/day, 100 units per search.list call — so
 * ~100 fallback searches/day even with zero other YouTube usage).
 */

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const FETCH_TIMEOUT_MS = 15000;

/**
 * Returns a YouTube video id, or null if nothing usable was found.
 * Never throws for "no results" — only for a genuine request failure —
 * since an admin applying metadata shouldn't have the whole action fail
 * just because a trailer search came up empty.
 */
async function searchTrailer(title, year) {
  if (!YOUTUBE_API_KEY) {
    throw new Error("Missing YOUTUBE_API_KEY in .env");
  }

  const url = new URL(YOUTUBE_SEARCH_URL);
  url.searchParams.set("key", YOUTUBE_API_KEY);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("q", `${title} ${year || ""} official trailer`.trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`YouTube search failed (HTTP ${res.status}): ${body}`);
    }
    const data = await res.json();
    const first = (data.items || [])[0];
    return first?.id?.videoId || null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { searchTrailer };
