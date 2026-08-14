/**
 * backend/services/telegram.js
 *
 * Posts an approved film to the Telegram channel.
 *
 * Defaults to Telegram's standard api.telegram.org, which caps bot
 * uploads at 50MB regardless of whether it's sent as a video or a
 * document — self-hosting Telegram's own Bot API server removes that
 * cap (up to 2GB), but requires an API ID/hash from my.telegram.org.
 * That's optional (set TELEGRAM_API_ROOT to use it) — this works fine
 * without it, using each own-upload's existing 30s preview clip
 * (film.previewUrl, generated during processing regardless of Telegram)
 * as a fallback for anything too large for the 50MB cap, rather than
 * requiring extra infrastructure just to post the full file.
 *
 * Like Deepgram, this passes a URL rather than uploading file bytes —
 * Telegram's servers fetch the file themselves, so this is a lightweight
 * API call from here, not a heavy file-transfer operation.
 */

const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const API_ROOT = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
const USING_SELF_HOSTED_SERVER = API_ROOT !== "https://api.telegram.org";
// The site users actually watch films on — used to build the caption's
// link back to the film's detail page. Optional; the caption just omits
// the link if this isn't set.
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL;

// Telegram's own hard cap on the standard cloud Bot API — applies to
// both sendVideo and sendDocument alike, not just video.
const CLOUD_API_HARD_LIMIT_BYTES = 50 * 1024 * 1024; // 50MB

// Only relevant when self-hosting (TELEGRAM_API_ROOT set) — above this,
// sendDocument is used instead of sendVideo. UX choice, not a limit: very
// large files often don't preview cleanly as inline video even when
// technically under the self-hosted server's 2GB ceiling.
const SELF_HOSTED_VIDEO_THRESHOLD_BYTES = 250 * 1024 * 1024; // 250MB

// Telegram only needs to be handed a URL — its own servers do the actual
// fetching, so this should respond reasonably quickly regardless of file
// size. A generous but bounded timeout so a blocked/unreachable network
// fails fast instead of hanging the approval request indefinitely.
const TELEGRAM_TIMEOUT_MS = 30 * 1000; // 30s

// Error codes that mean "never got a response at all" — the fingerprint
// of a network-level block (e.g. an ISP/region blocking Telegram)
// rather than Telegram itself rejecting the request.
const NETWORK_UNREACHABLE_PATTERNS = [
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ECONNRESET",
  "timed out after",
];

let bot = null;

function getBot() {
  if (!BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  }
  if (!bot) {
    bot = new Telegraf(BOT_TOKEN, {
      telegram: { apiRoot: API_ROOT },
    });
  }
  return bot;
}

function isNetworkUnreachableError(err) {
  const msg = err?.message || String(err);
  return NETWORK_UNREACHABLE_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Wraps a friendly, actionable message around a raw network error instead
 * of surfacing Node's cryptic "connect ETIMEDOUT 149.154.x.x:443" text —
 * that specific pattern is the fingerprint of Telegram being blocked at
 * the network/ISP level (a known, common situation in some regions,
 * including Pakistan), not a bug in this code.
 */
function friendlyError(err) {
  if (isNetworkUnreachableError(err)) {
    return new Error(
      "Telegram appears to be blocked or unreachable from this network " +
        "(common in some regions — e.g. Pakistan). Connect a VPN and try again. " +
        `(underlying error: ${err.message})`
    );
  }
  return err;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildCaption(film, { isPreview = false } = {}) {
  const lines = [film.title];

  const metaParts = [film.year, film.country].filter(Boolean);
  if (metaParts.length) lines.push(metaParts.join(" · "));

  if (film.description) {
    const trimmed =
      film.description.length > 300 ? `${film.description.slice(0, 300)}…` : film.description;
    lines.push(trimmed);
  }

  if (isPreview) {
    lines.push("(30s preview — too large to post in full here)");
  }

  if (PUBLIC_SITE_URL) {
    lines.push(`Watch the full film: ${PUBLIC_SITE_URL.replace(/\/$/, "")}/film/${film._id}`);
  }

  return lines.join("\n\n");
}

async function sendVideoWithFallback(telegram, sourceUrl, caption) {
  try {
    await withTimeout(
      telegram.sendVideo(CHANNEL_ID, sourceUrl, { caption, supports_streaming: true }),
      TELEGRAM_TIMEOUT_MS,
      "Telegram sendVideo"
    );
  } catch (err) {
    if (isNetworkUnreachableError(err)) {
      // The network itself is unreachable — sendDocument would fail the
      // exact same way, no point trying it too.
      throw friendlyError(err);
    }
    console.warn("sendVideo rejected, falling back to sendDocument:", err.message);
    try {
      await withTimeout(
        telegram.sendDocument(CHANNEL_ID, sourceUrl, { caption }),
        TELEGRAM_TIMEOUT_MS,
        "Telegram sendDocument"
      );
    } catch (docErr) {
      throw friendlyError(docErr);
    }
  }
}

/**
 * Posts a film to the configured Telegram channel. Best-effort by design
 * — callers should catch and log/report rather than let this block an
 * approval, same pattern as the Qdrant embedding side-effect.
 */
async function postFilmToTelegram(film) {
  if (!BOT_TOKEN || !CHANNEL_ID) {
    console.warn(
      "Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID missing in .env) — skipping post."
    );
    return;
  }

  if (!film.streamUrl) {
    throw new Error(`Film ${film._id} has no streamUrl to post to Telegram`);
  }

  const telegram = getBot().telegram;
  const knownSize = typeof film.fileSizeBytes === "number" ? film.fileSizeBytes : undefined;

  if (USING_SELF_HOSTED_SERVER) {
    const isKnownLarge = knownSize !== undefined && knownSize > SELF_HOSTED_VIDEO_THRESHOLD_BYTES;
    const caption = buildCaption(film);

    if (isKnownLarge) {
      try {
        await withTimeout(
          telegram.sendDocument(CHANNEL_ID, film.streamUrl, { caption }),
          TELEGRAM_TIMEOUT_MS,
          "Telegram sendDocument"
        );
      } catch (err) {
        throw friendlyError(err);
      }
      return;
    }

    await sendVideoWithFallback(telegram, film.streamUrl, caption);
    return;
  }

  // Standard cloud API: hard 50MB cap on anything. If the full file is
  // known to exceed it, use the preview clip instead of trying (and
  // failing) to send the whole thing.
  const isTooLargeForCloudApi = knownSize !== undefined && knownSize > CLOUD_API_HARD_LIMIT_BYTES;

  if (isTooLargeForCloudApi) {
    if (!film.previewUrl) {
      console.warn(
        `Skipping Telegram post for film ${film._id}: file exceeds the 50MB cloud API limit and no preview clip is available (set TELEGRAM_API_ROOT to a self-hosted server to post full-size files instead).`
      );
      return;
    }

    const caption = buildCaption(film, { isPreview: true });
    await sendVideoWithFallback(telegram, film.previewUrl, caption);
    return;
  }

  // Under the limit, or size unknown (e.g. an older archive.org film
  // ingested before fileSizeBytes was tracked — these are almost always
  // small anyway).
  const caption = buildCaption(film);
  await sendVideoWithFallback(telegram, film.streamUrl, caption);
}

module.exports = { postFilmToTelegram };