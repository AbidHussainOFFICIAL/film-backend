// backend/middleware/verifyFirebaseToken.js

const admin = require("../config/firebaseAdmin");

/**
 * Expects `Authorization: Bearer <Firebase ID token>`. Verifies the token
 * server-side with firebase-admin and attaches the decoded token to
 * req.user. Any route behind this middleware is admin-only.
 */
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  if (!admin.apps.length) {
    return res.status(500).json({
      error: "Firebase Admin is not configured on the server (check backend/.env)",
    });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Firebase token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = verifyFirebaseToken;
