/**
 * backend/services/publicFilmView.js
 *
 * The single place that decides what a visitor is allowed to see of a
 * film. The public film routes (GET /api/films, GET /api/films/:id,
 * GET /api/search) used to return the full raw Mongo document, which
 * leaked two real identity fields to every visitor's browser:
 *
 *   - verifiedBy: literally req.user?.email || req.user?.uid — the
 *     admin's own login email.
 *   - archiveBackup.archiveIdentifier: a direct pointer to the
 *     operator's own Archive.org account.
 *
 * Both are whitelisted OUT here. filmService's admin-facing lookups
 * (getFilmById etc.) are deliberately left returning full documents —
 * plenty of internal admin code needs them — the projection is applied
 * only at the edge, in the public-facing controllers.
 *
 * Two shapes:
 *   - toPublicFilm: the detail page. Everything a viewer needs to play,
 *     download and read about ONE film.
 *   - toPublicFilmSummary: list/search cards. Deliberately small — see
 *     filmService.SUMMARY_PROJECTION. `cast` is reduced to just the
 *     names (the grid's text filter matches on them; it never renders
 *     headshots), so the list payload doesn't carry every cast member's
 *     image URL.
 */

const DETAIL_FIELDS = [
  "_id",
  "title",
  "originalTitle",
  "year",
  "country",
  "runtime",
  "category",
  "tags",
  "description",
  "posterUrl",
  "backdropUrl",
  "cast",
  "director",
  "license",
  "streamUrl",
  "downloadUrl",
  "previewUrl",
  "captionsUrl",
  "sourceHeight",
  "fileSizeBytes",
  "manifestUrl",
  "renditions",
  "audioTracks",
  "subtitleTracks",
  "region",
  "imdbId",
  "trailerYoutubeKey",
  "ratings",
  "views",
  "avgRating",
  "ratingCount",
  "addedDate",
];

const SUMMARY_FIELDS = [
  "_id",
  "title",
  "year",
  "runtime",
  "category",
  "tags",
  "posterUrl",
  "director",
  "ratings",
  "avgRating",
  "ratingCount",
  "views",
  "addedDate",
];

function plain(filmDoc) {
  return typeof filmDoc.toObject === "function" ? filmDoc.toObject() : filmDoc;
}

function pick(obj, fields) {
  const out = {};
  for (const key of fields) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function toPublicFilm(filmDoc) {
  if (!filmDoc) return filmDoc;
  return pick(plain(filmDoc), DETAIL_FIELDS);
}

function toPublicFilmSummary(filmDoc) {
  if (!filmDoc) return filmDoc;
  const film = plain(filmDoc);
  const summary = pick(film, SUMMARY_FIELDS);
  if (Array.isArray(film.cast)) {
    summary.cast = film.cast.map((c) => ({ name: c.name }));
  }
  return summary;
}

function toPublicFilmSummaries(filmDocs) {
  return (filmDocs || []).map(toPublicFilmSummary);
}

module.exports = { toPublicFilm, toPublicFilmSummary, toPublicFilmSummaries };
