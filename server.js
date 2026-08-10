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

const filmRoutes = require("./routes/filmRoutes");
const adminRoutes = require("./routes/adminRoutes");
const searchRoutes = require("./routes/searchRoutes");
const jobsRoutes = require("./routes/jobsRoutes");
const serviceRoutes = require("./routes/serviceRoutes");

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("Film API is running");
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
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
