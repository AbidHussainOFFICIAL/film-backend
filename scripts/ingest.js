/**
 * backend/scripts/ingest.js
 *
 * Pulls public-domain films from the Internet Archive, enriches them with
 * TMDb metadata (poster, overview, genres), dedupes against what's already
 * in MongoDB, and inserts new titles as `status: "pending"` for a human to
 * review later.
 *
 * Run manually:   node scripts/ingest.js
 * Run via npm:     npm run ingest   (from inside backend/)
 * Run in CI:       see .github/workflows/ingest.yml
 *
 * Requires Node 18+ (uses the built-in fetch API).
 */

require("dotenv").config();
const crypto = require("crypto");
const dns = require("dns");
const mongoose = require("mongoose");

const Film = require("../models/Film");
const IngestionLog = require("../models/IngestionLog");

// Some networks (corporate VPNs, certain ISPs/routers, some Windows setups)
// block or mishandle the DNS SRV lookups that `mongodb+srv://` connection
// strings require, causing `querySrv ECONNREFUSED ...` errors even though
// normal internet access works fine. Pointing Node's resolver at a public
// DNS server fixes it. Harmless to leave on for GitHub Actions runners too.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MONGO_URI = process.env.MONGO_URI;
const TMDB_API_KEY = process.env.TMDB_API_KEY; // optional — script degrades gracefully without it

// Which Archive.org collection to pull from, and how many items per run.
// Kept small on purpose so a daily cron run stays well within TMDb's free
// rate limits and doesn't flood the moderation queue in one go.
const ARCHIVE_COLLECTION = process.env.INGEST_COLLECTION || "prelinger";
const ARCHIVE_MEDIATYPE = "movies";
const ARCHIVE_ROWS = Number(process.env.INGEST_ROWS || 20);

const FETCH_TIMEOUT_MS = 15000;
const TMDB_REQUEST_DELAY_MS = 300; // stay well clear of TMDb's rate limit

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * fetch() with a hard timeout so a hung request in CI doesn't run forever,
 * plus one automatic retry for transient network blips (timeouts, resets) —
 * flaky Wi-Fi/VPN connections can abort an individual Archive.org request
 * without anything actually being wrong with that item.
 */
async function fetchJson(url, { label, retries = 1 } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`${label || url} responded with HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(500);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Internet Archive
// ---------------------------------------------------------------------------

/**
 * Searches Archive.org's Advanced Search API for candidate public-domain
 * films. No API key required.
 */
async function searchArchiveOrg() {
  const params = new URLSearchParams();
  params.set("q", `collection:${ARCHIVE_COLLECTION} AND mediatype:${ARCHIVE_MEDIATYPE}`);
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "year");
  params.append("fl[]", "description");
  params.set("rows", String(ARCHIVE_ROWS));
  params.set("page", "1");
  params.set("output", "json");

  const url = `https://archive.org/advancedsearch.php?${params.toString()}`;
  const data = await fetchJson(url, { label: "Archive.org advancedsearch" });

  const docs = data?.response?.docs || [];
  return docs
    .filter((doc) => doc.identifier && doc.title)
    .map((doc) => ({
      identifier: doc.identifier,
      title: doc.title,
      year: Array.isArray(doc.year) ? Number(doc.year[0]) : Number(doc.year) || undefined,
      description: Array.isArray(doc.description) ? doc.description[0] : doc.description,
    }));
}

/**
 * Fetches an item's file listing from Archive.org and picks the best mp4
 * to use as the direct stream URL. Every item's actual filename differs
 * from its identifier, so this can't be guessed — it has to be looked up.
 */
async function getBestStreamUrl(identifier) {
  const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
  const data = await fetchJson(url, { label: `Archive.org metadata for ${identifier}` });

  const files = Array.isArray(data.files) ? data.files : [];
  const mp4Files = files.filter(
    (f) => typeof f.name === "string" && f.name.toLowerCase().endsWith(".mp4")
  );

  if (mp4Files.length === 0) return null;

  // Prefer the largest mp4 (usually the highest-quality, non-thumbnail file).
  mp4Files.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  const best = mp4Files[0];

  return `https://archive.org/download/${identifier}/${best.name}`;
}

// ---------------------------------------------------------------------------
// TMDb
// ---------------------------------------------------------------------------

let tmdbGenreMap = null;

async function getTmdbGenreMap() {
  if (!TMDB_API_KEY) return new Map();
  if (tmdbGenreMap) return tmdbGenreMap;

  try {
    const url = `https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-US`;
    const data = await fetchJson(url, { label: "TMDb genre list" });
    tmdbGenreMap = new Map((data.genres || []).map((g) => [g.id, g.name]));
  } catch (err) {
    console.warn("Could not load TMDb genre list, continuing without genre names:", err.message);
    tmdbGenreMap = new Map();
  }

  return tmdbGenreMap;
}

/**
 * Best-effort TMDb lookup. Returns null (never throws) if the key is
 * missing, the title isn't found, or the request fails — ingestion should
 * never fail just because enrichment didn't work.
 */
async function searchTmdb(title, year, genreMap) {
  if (!TMDB_API_KEY) return null;

  try {
    const params = new URLSearchParams({
      api_key: TMDB_API_KEY,
      query: title,
    });
    if (year) params.set("year", String(year));

    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const data = await fetchJson(url, { label: `TMDb search for "${title}"` });

    const match = (data.results || [])[0];
    if (!match) return null;

    return {
      posterUrl: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : undefined,
      overview: match.overview || undefined,
      genres: (match.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean),
    };
  } catch (err) {
    console.warn(`TMDb lookup failed for "${title}":`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main ingestion run
// ---------------------------------------------------------------------------

async function run() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in .env");
  }
  if (!TMDB_API_KEY) {
    console.warn(
      "TMDB_API_KEY not set — continuing without poster/genre/overview enrichment from TMDb."
    );
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const stats = {
    itemsFound: 0,
    itemsInserted: 0,
    itemsDuplicate: 0,
    itemsErrored: 0,
    errors: [],
  };

  try {
    const candidates = await searchArchiveOrg();
    stats.itemsFound = candidates.length;
    console.log(`Archive.org returned ${candidates.length} candidate item(s).`);

    const genreMap = await getTmdbGenreMap();

    for (const candidate of candidates) {
      const { identifier, title, year, description } = candidate;
      const fileHash = sha256(identifier);

      try {
        // Cheap dedup check first — skip everything else if we already have it.
        const alreadyExists = await Film.exists({
          $or: [{ archiveIdentifier: identifier }, { fileHash }],
        });

        if (alreadyExists) {
          stats.itemsDuplicate += 1;
          console.log(`Skipping duplicate: ${identifier}`);
          continue;
        }

        const streamUrl = await getBestStreamUrl(identifier);
        if (!streamUrl) {
          stats.itemsErrored += 1;
          stats.errors.push(`${identifier}: no .mp4 file found in Archive.org metadata`);
          continue;
        }

        const tmdbInfo = await searchTmdb(title, year, genreMap);
        await sleep(TMDB_REQUEST_DELAY_MS);

        const filmDoc = {
          title,
          year,
          description: tmdbInfo?.overview || description || undefined,
          posterUrl: tmdbInfo?.posterUrl || `https://archive.org/services/img/${identifier}`,
          category: tmdbInfo?.genres?.length ? tmdbInfo.genres : ["Uncategorized"],
          streamUrl,
          downloadUrl: streamUrl,
          license: {
            source: "archive.org",
            type: "public-domain",
            attributionRequired: false,
          },
          source: "archive.org",
          archiveIdentifier: identifier,
          fileHash,
          status: "pending",
          region: "US",
        };

        await Film.create(filmDoc);
        stats.itemsInserted += 1;
        console.log(`Inserted (pending): ${title} [${identifier}]`);
      } catch (err) {
        // Duplicate key races (two runs overlapping, or fileHash collision
        // on a re-run) land here as a Mongo E11000 error — treat as a
        // duplicate rather than a hard failure.
        if (err?.code === 11000) {
          stats.itemsDuplicate += 1;
          console.log(`Skipping duplicate (insert race): ${identifier}`);
        } else {
          stats.itemsErrored += 1;
          stats.errors.push(`${identifier}: ${err.message}`);
          console.error(`Error processing ${identifier}:`, err.message);
        }
      }
    }

    const status =
      stats.itemsErrored === 0
        ? "success"
        : stats.itemsInserted > 0 || stats.itemsDuplicate > 0
        ? "partial"
        : "failed";

    await IngestionLog.create({
      source: "archive.org",
      itemsFound: stats.itemsFound,
      itemsInserted: stats.itemsInserted,
      itemsDuplicate: stats.itemsDuplicate,
      itemsErrored: stats.itemsErrored,
      errors: stats.errors,
      status,
    });

    console.log("--- Ingestion summary ---");
    console.log(stats);
    console.log("Status:", status);

    return status;
  } catch (err) {
    // A failure here means the run itself blew up (e.g. Archive.org search
    // unreachable) rather than an individual item failing.
    console.error("Ingestion run failed:", err.message);

    await IngestionLog.create({
      source: "archive.org",
      itemsFound: stats.itemsFound,
      itemsInserted: stats.itemsInserted,
      itemsDuplicate: stats.itemsDuplicate,
      itemsErrored: stats.itemsErrored + 1,
      errors: [...stats.errors, `Fatal: ${err.message}`],
      status: "failed",
    });

    throw err;
  }
}

run()
  .then((status) => {
    mongoose.disconnect();
    process.exit(status === "failed" ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    mongoose.disconnect().finally(() => process.exit(1));
  });
