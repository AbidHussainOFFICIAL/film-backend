const express = require("express");
const router = express.Router();
const verifyMediaCallbackSecret = require("../middleware/verifyMediaCallbackSecret");
const { handleMediaCallback } = require("../controllers/mediaCallbackController");

// POST /api/media-callback/:id
// Called by the film-media-worker repo's GitHub Actions workflow when a
// thumbnail/preview job finishes — authenticated with a shared secret,
// not Firebase, since the caller is a CI job, not a browser user.
router.post("/:id", verifyMediaCallbackSecret, handleMediaCallback);

module.exports = router;
