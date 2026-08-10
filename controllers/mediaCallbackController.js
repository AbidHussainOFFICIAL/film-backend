const Film = require("../models/Film");
const storage = require("../services/storage");

// POST /api/media-callback/:id
// Body on success: { status: "completed", thumbKey, previewKey, sourceHeight?, durationSeconds? }
// Body on failure: { status: "failed", error }
async function handleMediaCallback(req, res) {
  try {
    const { id } = req.params;
    const { status, thumbKey, previewKey, sourceHeight, durationSeconds, error } = req.body;

    const film = await Film.findById(id);
    if (!film) {
      return res.status(404).json({ error: "Film not found" });
    }

    if (status === "completed") {
      if (!thumbKey || !previewKey) {
        return res.status(400).json({ error: "Missing thumbKey/previewKey for a completed callback" });
      }

      film.posterUrl = storage.getPublicUrl(thumbKey);
      film.previewUrl = storage.getPublicUrl(previewKey);
      film.streamUrl = storage.getPublicUrl(film.masterKey);
      film.downloadUrl = film.streamUrl;

      if (sourceHeight) film.sourceHeight = Number(sourceHeight);
      if (durationSeconds) film.runtime = Math.round(Number(durationSeconds) / 60);

      film.transcodeStatus = "completed";
      // Own uploads skip the moderation queue — the admin already vetted
      // this by choosing to upload it in the first place.
      film.status = "approved";
      film.verifiedDate = new Date();
    } else {
      film.transcodeStatus = "failed";
      console.error(`Media processing reported failure for film ${id}:`, error || "(no error message provided)");
    }

    await film.save();
    res.json({ ok: true });
  } catch (err) {
    console.error("Error handling media callback:", err);
    res.status(500).json({ error: "Failed to process callback" });
  }
}

module.exports = { handleMediaCallback };
