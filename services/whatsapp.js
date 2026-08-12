/**
 * backend/services/whatsapp.js
 *
 * Maintains a persistent, authenticated WhatsApp connection (via Baileys,
 * an unofficial library that automates a real WhatsApp account the same
 * way WhatsApp Web does) and posts approved films to a WhatsApp Channel.
 *
 * Unlike every other external integration in this app, this is NOT a
 * stateless HTTP client — it holds a live WebSocket connection open for
 * the lifetime of the process, established once at server startup (see
 * server.js), not per-request. Mostly idle, so this doesn't reintroduce
 * "heavy processing in the light backend" — closer to holding open the
 * MongoDB connection than running FFmpeg.
 *
 * Real risk worth restating: automating WhatsApp this way is outside
 * Meta's official Terms of Service and could get the paired number
 * banned. Use a dedicated number, never a personal one. This app's use
 * of it — one post per approval to a channel — deliberately avoids the
 * bulk-individual-messaging pattern that's the most common cause of
 * bans; it's not risk-free, but it's a much lower-risk usage shape than
 * looping through many subscribers would have been.
 */

const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");

const AUTH_DIR = path.join(__dirname, "..", ".baileys_auth");
const CHANNEL_JID = process.env.WHATSAPP_CHANNEL_JID;
const AUTO_REPLY_TEXT =
  process.env.WHATSAPP_AUTO_REPLY_TEXT ||
  "This number only posts to our channel and doesn't read replies here. Follow the channel for updates.";

// Above this, sendMessage's document type is used instead of video — same
// reasoning and threshold as the Telegram integration.
const VIDEO_SIZE_THRESHOLD_BYTES = 250 * 1024 * 1024; // 250MB

const logger = pino({ level: "silent" });

let sock = null;
let connectionReadyPromise = null;

/**
 * Establishes (or returns the existing) persistent connection. Call this
 * once at server startup — see server.js. Resolves once actually
 * connected; on the very first run (no saved session yet) it prints a QR
 * code to the terminal and waits for it to be scanned.
 */
function connectWhatsApp() {
  if (connectionReadyPromise) return connectionReadyPromise;

  connectionReadyPromise = new Promise((resolve, reject) => {
    (async () => {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false, // handled manually below, for reliability across versions
      });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log(
            "\nScan this QR code with the WhatsApp account you want posting to the channel:\n"
          );
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === "open") {
          console.log("WhatsApp connected.");
          resolve(sock);
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          console.warn("WhatsApp connection closed.", { statusCode, loggedOut });

          if (loggedOut) {
            const err = new Error(
              "WhatsApp session was logged out (likely unlinked from the phone). " +
                "Delete backend/.baileys_auth and re-pair by running the server (or scripts/whatsappSetup.js) again."
            );
            console.error(err.message);
            reject(err);
            return;
          }

          // Any other disconnect reason (network blip, WhatsApp-side
          // restart, etc.) — reconnect automatically.
          connectionReadyPromise = null;
          connectWhatsApp().catch((err) =>
            console.error("WhatsApp reconnect failed:", err.message)
          );
        }
      });

      // Best-effort auto-reply so anyone who messages this number
      // directly gets a clear explanation instead of silence — this
      // number's purpose is posting to the channel, not conversation.
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
          const remoteJid = msg.key.remoteJid || "";
          const isFromMe = msg.key.fromMe;
          const isChannel = remoteJid.endsWith("@newsletter");
          const isGroup = remoteJid.endsWith("@g.us");
          const isStatusBroadcast = remoteJid === "status@broadcast";

          if (isFromMe || isChannel || isGroup || isStatusBroadcast) continue;

          try {
            await sock.sendMessage(remoteJid, { text: AUTO_REPLY_TEXT });
          } catch (err) {
            console.error("Failed to send WhatsApp auto-reply:", err.message);
          }
        }
      });
    })().catch(reject);
  });

  return connectionReadyPromise;
}

/**
 * Resolves a channel's invite code (the part after whatsapp.com/channel/
 * in its invite link) to its JID. Used only by scripts/whatsappSetup.js
 * during one-time setup — the running app uses the already-resolved
 * WHATSAPP_CHANNEL_JID env var, not this function, so it doesn't need to
 * re-resolve on every post.
 */
async function resolveChannelJid(inviteCode) {
  const connectedSock = await connectWhatsApp();
  const metadata = await connectedSock.newsletterMetadata("invite", inviteCode);
  return metadata.id;
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

  const siteUrl = process.env.PUBLIC_SITE_URL;
  if (siteUrl) {
    lines.push(`${siteUrl.replace(/\/$/, "")}/film/${film._id}`);
  }

  return lines.join("\n\n");
}

/**
 * Posts a film to the configured WhatsApp Channel. Best-effort by
 * design — callers should catch and log/report rather than let this
 * block an approval, same pattern as the Telegram post.
 *
 * Unlike Telegram (where Telegram's own servers fetch the source URL),
 * Baileys streams the file through this process to upload it to
 * WhatsApp — WhatsApp has no "fetch this URL yourself" mechanism. It's
 * still stream-based (not buffered fully in memory), but it does mean
 * this takes real time/bandwidth on this server for large files, unlike
 * the Telegram/Deepgram integrations.
 */
async function postFilmToChannel(film) {
  if (!CHANNEL_JID) {
    console.warn("WHATSAPP_CHANNEL_JID not set in .env — skipping WhatsApp post.");
    return;
  }

  const sourceUrl = film.streamUrl;
  if (!sourceUrl) {
    throw new Error(`Film ${film._id} has no streamUrl to post to WhatsApp`);
  }

  const connectedSock = await connectWhatsApp();
  const caption = buildCaption(film);

  const isKnownLarge =
    typeof film.fileSizeBytes === "number" && film.fileSizeBytes > VIDEO_SIZE_THRESHOLD_BYTES;

  if (isKnownLarge) {
    await connectedSock.sendMessage(CHANNEL_JID, {
      document: { url: sourceUrl },
      mimetype: "video/mp4",
      fileName: `${film.title}.mp4`,
      caption,
    });
    return;
  }

  try {
    await connectedSock.sendMessage(CHANNEL_JID, {
      video: { url: sourceUrl },
      caption,
    });
  } catch (err) {
    console.warn(
      `sendMessage(video) failed for film ${film._id}, falling back to document:`,
      err.message
    );
    await connectedSock.sendMessage(CHANNEL_JID, {
      document: { url: sourceUrl },
      mimetype: "video/mp4",
      fileName: `${film.title}.mp4`,
      caption,
    });
  }
}

module.exports = { connectWhatsApp, resolveChannelJid, postFilmToChannel };
