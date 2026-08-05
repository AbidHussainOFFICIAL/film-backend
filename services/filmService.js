const Film = require("../models/Film");

// Only approved films are ever shown on the public site
async function getApprovedFilms() {
  return Film.find({ status: "approved" }).sort({ addedDate: -1 });
}

async function getFilmById(id) {
  return Film.findById(id);
}

module.exports = {
  getApprovedFilms,
  getFilmById,
};
