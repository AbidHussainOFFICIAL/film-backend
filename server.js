// backend/server.js

// Sentry must be initialized before any other module is required.
require("./instrument");
const Sentry = require("@sentry/node");

require("dotenv").config();
const dns = require("dns");
// Some networks block/mishandle the DNS SRV lookups that mongodb+srv://
// connection strings require, causing `querySrv ECONNREFUSED ...` errors
// even though normal internet access works fine. Pointing Node's resolver
// at a public DNS server fixes it. Harmless to leave on elsewhere too.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const path = require("path");

const filmRoutes = require("./routes/filmRoutes");
const adminRoutes = require("./routes/adminRoutes");
const searchRoutes = require("./routes/searchRoutes");
const jobsRoutes = require("./routes/jobsRoutes");
const serviceRoutes = require("./routes/serviceRoutes");
const { connectWhatsApp } = require("./services/whatsapp");

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("Film API is running");
});

// GET /health — used by UptimeRobot (or any uptime monitor). Reports 503
// instead of 200 if Mongo isn't actually connected, so a monitor pointed
// at this catches "server is up but broken" too, not just "server is down".
app.get("/health", (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;
  const status = mongoConnected ? "ok" : "degraded";

  res.status(mongoConnected ? 200 : 503).json({
    status,
    uptimeSeconds: Math.round(process.uptime()),
    mongo: mongoConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

// Manual test route to confirm Sentry is actually wired up correctly —
// hitting this should make an event show up in the Sentry dashboard
// within a few seconds. Safe to leave in; it does nothing but throw.
app.get("/api/debug-sentry", () => {
  throw new Error("Test error — confirms Sentry reporting is working");
});

app.use("/api/films", filmRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/admin/jobs", jobsRoutes);
app.use("/api/service", serviceRoutes);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry's error handler: catches anything thrown synchronously in a
// route/middleware (like /api/debug-sentry above) or passed to next(err).
// Most of this app's own routes catch their own errors and report to
// Sentry manually (see the controllers) since they respond directly
// rather than calling next(err) — this is a backstop for anything that
// isn't already handled that way.
Sentry.setupExpressErrorHandler(app);

// Final error handler — after Sentry's, so the client still gets a clean
// JSON response instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 5000;

if (!process.env.MONGO_URI) {
  console.error("Missing MONGO_URI in .env — copy .env.example to .env and fill it in.");
  process.exit(1);
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    console.log("Using database:", mongoose.connection.name);

    // Best-effort, non-blocking — a missing/broken WhatsApp pairing
    // shouldn't prevent the server from starting. First run without a
    // saved session prints a QR code to this terminal to scan.
    if (process.env.WHATSAPP_CHANNEL_JID) {
      connectWhatsApp().catch((err) => {
        console.error("WhatsApp connection failed to start:", err.message);
      });
    } else {
      console.warn(
        "WHATSAPP_CHANNEL_JID not set — skipping WhatsApp connection. Run scripts/whatsappSetup.js to pair and get a channel JID."
      );
    }

    // If backend/certs/localhost.pem + localhost-key.pem exist (generated
    // via mkcert — see README "Local HTTPS for testing against a deployed
    // frontend" section), serve HTTPS instead of plain HTTP. This lets a
    // deployed frontend (e.g. on Vercel, always HTTPS) reach this local
    // backend without hitting browsers' increasingly strict blocking of
    // HTTPS-page-to-HTTP-endpoint requests. Falls back to plain HTTP if
    // the certs aren't there — nothing breaks for anyone who hasn't set
    // mkcert up locally.
    const certPath = path.join(__dirname, "certs", "localhost.pem");
    const keyPath = path.join(__dirname, "certs", "localhost-key.pem");
    const hasLocalCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

    if (hasLocalCerts) {
      const httpsOptions = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
      https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`Server running on https://localhost:${PORT} (local HTTPS via mkcert)`);
      });
    } else {
      app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
      });
    }
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });