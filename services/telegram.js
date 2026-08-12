/**
 * backend/services/telegram.js
 *
 * Posts an approved film to the Telegram channel. This calls Telegraf
 * pointed at a self-hosted Bot API server (via apiRoot) instead of
 * Telegram's default api.telegram.org — the default server caps uploads
 * at 50MB, which most own-uploads would blow past; the self-hosted server
 * raises that to 2GB.
 *
 * Like Deepgram, this passes a URL rather than uploading file bytes —
 * Telegram's servers fetch the file themselves, so this is a lightweight
 * API call from here, not a heavy file-transfer operation.
 */

const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const API_ROOT = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
// The site users actually watch films on — used to build the caption's
// link back to the film's detail page. Optional; the caption just omits
// the link if this isn't set.
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL;

// Above this, sendDocument is used instead of sendVideo. This is a UX
// choice, not a hard limit imposed by the self-hosted server (which
// accepts up to 2GB either way) — very large files often don't preview
// cleanly as inline video in a channel even when they're technically
// under the server's ceiling.
const VIDEO_SIZE_THRESHOLD_BYTES = 250 * 1024 * 1024; // 250MB

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

function buildCaption(film) {
  const lines = [film.title];

  const metaParts = [film.year, film.country].filter(Boolean);
  if (metaParts.length) lines.push(metaParts.join(" · "));

  if (film.description) {
    const trimmed =
      film.description.length > 300 ? `${film.description.slice(0, 300)}…` : film.description;
    lines.push(trimmed);
  }

  if (PUBLIC_SITE_URL) {
    lines.push(`${PUBLIC_SITE_URL.replace(/\/$/, "")}/film/${film._id}`);
  }

  return lines.join("\n\n");
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

  const sourceUrl = film.streamUrl;
  if (!sourceUrl) {
    throw new Error(`Film ${film._id} has no streamUrl to post to Telegram`);
  }

  const telegram = getBot().telegram;
  const caption = buildCaption(film);

  const isKnownLarge =
    typeof film.fileSizeBytes === "number" && film.fileSizeBytes > VIDEO_SIZE_THRESHOLD_BYTES;

  if (isKnownLarge) {
    await telegram.sendDocument(CHANNEL_ID, sourceUrl, { caption });
    return;
  }

  // Size is either under the threshold or unknown (e.g. an older
  // archive.org film ingested before fileSizeBytes was tracked) — try
  // sendVideo first since that's the better experience in a channel, and
  // fall back to sendDocument if Telegram rejects it for any reason
  // (actual size, unsupported format, etc.) rather than losing the post.
  try {
    await telegram.sendVideo(CHANNEL_ID, sourceUrl, {
      caption,
      supports_streaming: true,
    });
  } catch (err) {
    console.warn(
      `sendVideo failed for film ${film._id}, falling back to sendDocument:`,
      err.message
    );
    await telegram.sendDocument(CHANNEL_ID, sourceUrl, { caption });
  }
}

module.exports = { postFilmToTelegram };
