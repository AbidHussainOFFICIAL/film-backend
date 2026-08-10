const crypto = require("crypto");

/**
 * The media-worker repo's workflow calls this endpoint when it finishes —
 * it has no Firebase user session, so it authenticates with a plain shared
 * secret (X-Media-Callback-Secret header) instead of a Firebase ID token.
 * Compared with a constant-time check to avoid timing attacks.
 */
function verifyMediaCallbackSecret(req, res, next) {
  const expected = process.env.MEDIA_CALLBACK_SECRET;
  const provided = req.headers["x-media-callback-secret"];

  if (!expected) {
    return res.status(500).json({ error: "MEDIA_CALLBACK_SECRET is not configured on the server" });
  }
  if (!provided) {
    return res.status(401).json({ error: "Missing X-Media-Callback-Secret header" });
  }

  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expected));

  const isValid =
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!isValid) {
    return res.status(401).json({ error: "Invalid callback secret" });
  }

  next();
}

module.exports = verifyMediaCallbackSecret;
