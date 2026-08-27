// backend/config/firebaseAdmin.js

const admin = require("firebase-admin");

// Initialized once, from a Firebase service account's credentials — NOT the
// same as the frontend's Firebase config. Get these from:
// Firebase Console → Project settings → Service accounts → Generate new private key
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // .env files can't hold real newlines in a single value, so the private
  // key is stored with literal "\n" sequences and unescaped here.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
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
