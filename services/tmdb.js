/**
 * backend/services/tmdb.js
 *
 * Slice 18 — TMDb is the primary source for the movie-metadata
 * integration: search by title/year, then pull details + credits +
 * videos for one confirmed match in a single request via
 * append_to_response. Plain HTTP calls, same category as Deepgram/
 * embedding.js — no local compute, so this runs directly in the light
 * backend as an admin-triggered action, not a GitHub Actions job.
 */

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const FETCH_TIMEOUT_MS = 15000;
// How many credited cast members to keep — TMDb can list 50+; a film
// page only ever needs the principal cast, not the full call sheet.
const MAX_CAST_MEMBERS = 12;

async function tmdbGet(path, params = {}) {
  if (!TMDB_API_KEY) {
    throw new Error("Missing TMDB_API_KEY in .env");
  }
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TMDb request failed (HTTP ${res.status}): ${body}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search candidates for the admin's "Find metadata" match-confirm step.
 * Deliberately returns only what's needed to tell candidates apart at a
 * glance (poster, title, year, a short overview) — never auto-applies.
 */
async function searchMovies(query, year) {
  const data = await tmdbGet("/search/movie", { query, year, include_adult: false });
  return (data.results || []).slice(0, 8).map((m) => ({
    tmdbId: m.id,
    title: m.title,
    originalTitle: m.original_title !== m.title ? m.original_title : undefined,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) : undefined,
    overview: m.overview || undefined,
    posterUrl: m.poster_path ? `${IMAGE_BASE}/w342${m.poster_path}` : undefined,
  }));
}

function pickTrailer(videos) {
  const results = videos?.results || [];
  // Prefer an official YouTube trailer; fall back to any YouTube
  // trailer, then any YouTube teaser — in that order of preference.
  const bySite = (v) => v.site === "YouTube";
  const trailer =
    results.find((v) => bySite(v) && v.type === "Trailer" && v.official) ||
    results.find((v) => bySite(v) && v.type === "Trailer") ||
    results.find((v) => bySite(v) && v.type === "Teaser");
  return trailer ? trailer.key : null;
}

/**
 * Full details for ONE confirmed TMDb id — details + credits + videos
 * in a single request. imdb_id comes back directly on the details
 * object, so no separate /movie/{id}/external_ids call is needed.
 */
async function getMovieDetails(tmdbId) {
  const data = await tmdbGet(`/movie/${tmdbId}`, { append_to_response: "credits,videos" });

  const cast = (data.credits?.cast || []).slice(0, MAX_CAST_MEMBERS).map((c) => ({
    name: c.name,
    character: c.character || undefined,
    profileUrl: c.profile_path ? `${IMAGE_BASE}/w185${c.profile_path}` : undefined,
  }));

  const director = (data.credits?.crew || []).find((c) => c.job === "Director");

  return {
    tmdbId: data.id,
    imdbId: data.imdb_id || undefined,
    title: data.title,
    originalTitle: data.original_title !== data.title ? data.original_title : undefined,
    year: data.release_date ? Number(data.release_date.slice(0, 4)) : undefined,
    runtime: typeof data.runtime === "number" && data.runtime > 0 ? data.runtime : undefined,
    overview: data.overview || undefined,
    posterUrl: data.poster_path ? `${IMAGE_BASE}/w780${data.poster_path}` : undefined,
    backdropUrl: data.backdrop_path ? `${IMAGE_BASE}/w1280${data.backdrop_path}` : undefined,
    genres: (data.genres || []).map((g) => g.name),
    country: data.production_countries?.[0]?.iso_3166_1 || undefined,
    cast,
    director: director?.name,
    tmdbRating: typeof data.vote_average === "number" ? data.vote_average : undefined,
    trailerYoutubeKey: pickTrailer(data.videos),
  };
}

module.exports = { searchMovies, getMovieDetails };
