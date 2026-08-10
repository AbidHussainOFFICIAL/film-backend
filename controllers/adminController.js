const filmService = require("../services/filmService");
const { getEmbedding, buildEmbeddingText } = require("../services/embedding");
const { upsertFilmEmbedding, deleteFilmEmbedding } = require("../services/qdrantService");

const VALID_STATUSES = ["pending", "approved", "rejected"];

// GET /api/admin/films?status=pending
async function listFilmsByStatus(req, res) {
  try {
    const status = req.query.status || "pending";
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }
    const films = await filmService.getFilmsByStatus(status);
    res.json(films);
  } catch (err) {
    console.error("Error listing films by status:", err);
    res.status(500).json({ error: "Failed to fetch films" });
  }
}

// POST /api/admin/films/:id/approve
async function approveFilm(req, res) {
  try {
    const film = await filmService.setFilmStatus(req.params.id, "approved", {
      verifiedBy: req.user?.email || req.user?.uid,
      verifiedDate: new Date(),
    });
    if (!film) return res.status(404).json({ error: "Film not found" });

    // Index into Qdrant for semantic search. Best-effort: the film is
    // already approved in Mongo at this point, so a failure here (missing
    // API key, Nomic/Qdrant hiccup) shouldn't roll that back — it just
    // means this title won't turn up in search until it's re-indexed.
    try {
      const text = buildEmbeddingText(film);
      const vector = await getEmbedding(text, { taskType: "document" });
      await upsertFilmEmbedding(film._id, vector, {
        title: film.title,
        year: film.year,
      });
    } catch (embedErr) {
      console.error(`Embedding/indexing failed for film ${film._id}:`, embedErr.message);
    }

    res.json(film);
  } catch (err) {
    console.error("Error approving film:", err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to approve film" });
  }
}

// POST /api/admin/films/:id/reject
async function rejectFilm(req, res) {
  try {
    const film = await filmService.setFilmStatus(req.params.id, "rejected", {
      verifiedBy: req.user?.email || req.user?.uid,
      verifiedDate: new Date(),
    });
    if (!film) return res.status(404).json({ error: "Film not found" });

    // Best-effort: if this film was previously approved and indexed, make
    // sure it stops showing up in search now that it's rejected.
    await deleteFilmEmbedding(film._id);

    res.json(film);
  } catch (err) {
    console.error("Error rejecting film:", err);
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid film id" });
    res.status(500).json({ error: "Failed to reject film" });
  }
}

module.exports = {
  listFilmsByStatus,
  approveFilm,
  rejectFilm,
};
