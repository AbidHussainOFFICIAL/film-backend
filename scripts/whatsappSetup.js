/**
 * backend/scripts/whatsappSetup.js
 *
 * One-time setup: pairs this server with a WhatsApp account (scan the
 * QR code that prints to this terminal) and, if given a channel invite
 * code, resolves it to the JID needed for WHATSAPP_CHANNEL_JID in .env.
 *
 * Run: node scripts/whatsappSetup.js [channelInviteCode]
 *
 * The invite code is the part after whatsapp.com/channel/ in your
 * channel's invite link — not the full URL.
 */

require("dotenv").config();
const { connectWhatsApp, resolveChannelJid } = require("../services/whatsapp");

const inviteCode = process.argv[2];

async function run() {
  console.log("Connecting to WhatsApp... (scan the QR code below if this is the first run)\n");
  await connectWhatsApp();
  console.log(
    "\nConnected and paired. Session saved to backend/.baileys_auth — future runs won't need the QR code again.\n"
  );

  if (inviteCode) {
    console.log(`Resolving channel invite code "${inviteCode}"...`);
    const jid = await resolveChannelJid(inviteCode);
    console.log(`\nChannel JID: ${jid}`);
    console.log(`Add this to backend/.env as:\nWHATSAPP_CHANNEL_JID=${jid}\n`);
  } else {
    console.log(
      "No invite code given — pairing complete, but the channel JID wasn't resolved.\n" +
        "Run again with your channel's invite code to get it:\n" +
        "  node scripts/whatsappSetup.js YOUR_INVITE_CODE\n" +
        "(the part after whatsapp.com/channel/ in your channel's invite link)"
    );
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("WhatsApp setup failed:", err.message);
  process.exit(1);
});
