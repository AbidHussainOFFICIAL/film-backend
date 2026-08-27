// backend/middleware/verifyServiceSecret.js

const crypto = require("crypto");

/**
 * Protects the /api/service/* namespace — endpoints the heavy backend
 * (GitHub Actions workflows) calls to report job results or fetch data
 * it needs. There's no Firebase user session on that side (it's a CI
 * job, not a browser), so this uses a plain shared secret instead,
 * compared in constant time to avoid timing attacks.
 */
function verifyServiceSecret(req, res, next) {
  const expected = process.env.SERVICE_API_SECRET;
  const provided = req.headers["x-service-secret"];

  if (!expected) {
    return res.status(500).json({ error: "SERVICE_API_SECRET is not configured on the server" });
  }
  if (!provided) {
    return res.status(401).json({ error: "Missing X-Service-Secret header" });
  }

  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expected));

  const isValid =
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!isValid) {
    return res.status(401).json({ error: "Invalid service secret" });
  }

  next();
}

module.exports = verifyServiceSecret;
