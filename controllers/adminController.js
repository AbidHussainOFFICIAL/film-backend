const filmService = require("../services/filmService");

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
