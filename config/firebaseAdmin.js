// backend/config/firebaseAdmin.js

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  // Stitch split keys if present, otherwise fall back to single FIREBASE_PRIVATE_KEY
  const rawKey =
    (process.env.FIREBASE_PRIVATE_KEY_1 || "") +
    (process.env.FIREBASE_PRIVATE_KEY_2 || "") +
    (process.env.FIREBASE_PRIVATE_KEY_3 || "") ||
    process.env.FIREBASE_PRIVATE_KEY ||
    "";

  // Clean outer quotes and unescape newline characters
  const privateKey = rawKey
    ? rawKey
        .trim()
        .replace(/^"|"$/g, "")
        .replace(/\\n/g, "\n")
    : undefined;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      "Firebase Admin credentials are incomplete (FIREBASE_PROJECT_ID / " +
        "FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY). Admin-protected " +
        "routes will reject every request until these are set in .env."
    );
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  }
}

module.exports = admin;
