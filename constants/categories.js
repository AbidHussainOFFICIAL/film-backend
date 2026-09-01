// backend/constants/categories.js

/**
 * The fixed, managed category taxonomy. Deliberately a superset of TMDb's
 * standard genre list (Action, Adventure, Animation, Comedy, Crime,
 * Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery,
 * Romance, Science Fiction, TV Movie, Thriller, War, Western) plus a few
 * PD-specific additions TMDb would never return (Short Film, Educational,
 * Silent Film), plus a catch-all fallback.
 *
 * Choosing names that already match TMDb's own genre strings verbatim
 * means services/categoryMapper.js can do a simple exact-match instead of
 * needing fuzzy/alias matching — one less thing to get subtly wrong.
 *
 * Edit this list to add/rename a category; run scripts/seedCategories.js
 * afterward to sync it into MongoDB (safe to re-run, it won't touch
 * filmCount on categories that already exist).
 */
const CATEGORIES = [
  { name: "Action", slug: "action", description: "High-energy, stunt- and conflict-driven films." },
  { name: "Adventure", slug: "adventure", description: "Journeys, quests, and exploration." },
  { name: "Animation", slug: "animation", description: "Animated films of any style or era." },
  { name: "Comedy", slug: "comedy", description: "Films made primarily to entertain and amuse." },
  { name: "Crime", slug: "crime", description: "Films centered on criminal acts or their investigation." },
  { name: "Documentary", slug: "documentary", description: "Non-fiction films documenting real subjects." },
  { name: "Drama", slug: "drama", description: "Character- and narrative-driven serious films." },
  { name: "Educational", slug: "educational", description: "Instructional or informational films, e.g. classroom or industrial films." },
  { name: "Family", slug: "family", description: "Films intended for a general, all-ages audience." },
  { name: "Fantasy", slug: "fantasy", description: "Films involving magic or imaginary worlds." },
  { name: "History", slug: "history", description: "Films set in or depicting past events." },
  { name: "Horror", slug: "horror", description: "Films intended to frighten or unsettle." },
  { name: "Music", slug: "music", description: "Films centered on music or musical performance." },
  { name: "Mystery", slug: "mystery", description: "Films built around solving a puzzle or secret." },
  { name: "Romance", slug: "romance", description: "Films centered on romantic relationships." },
  { name: "Science Fiction", slug: "science-fiction", description: "Films involving speculative science or technology." },
  { name: "Short Film", slug: "short-film", description: "Films of unusually brief runtime, regardless of genre." },
  { name: "Silent Film", slug: "silent-film", description: "Films made in the silent-film era, without synchronized dialogue." },
  { name: "Thriller", slug: "thriller", description: "Films built around suspense and tension." },
  { name: "TV Movie", slug: "tv-movie", description: "Films originally produced for television broadcast." },
  { name: "War", slug: "war", description: "Films centered on armed conflict." },
  { name: "Western", slug: "western", description: "Films set in the American Old West." },
  { name: "Uncategorized", slug: "uncategorized", description: "Fallback for content that doesn't map to any category above." },
];

module.exports = { CATEGORIES };