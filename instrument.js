/**
 * backend/instrument.js
 *
 * Sentry must be initialized before any other module is required, so this
 * file is required as the very first line of server.js — nothing else.
 *
 * dotenv is loaded here too (rather than assuming server.js already did
 * it) specifically so SENTRY_DSN is available before Sentry.init() reads
 * it — this file runs first, before server.js's own dotenv call.
 */

require("dotenv").config();
const Sentry = require("@sentry/node");

const SENTRY_DSN = process.env.SENTRY_DSN;

if (!SENTRY_DSN) {
  console.warn(
    "SENTRY_DSN not set in .env — errors will only be logged to the console, not reported to Sentry."
  );
} else {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    // Tags every event so it's obvious in the Sentry dashboard whether an
    // error came from this backend or one of the heavy backend's scripts,
    // since both report to the same Sentry project.
    initialScope: {
      tags: { service: "light-backend" },
    },
  });
}

module.exports = Sentry;
