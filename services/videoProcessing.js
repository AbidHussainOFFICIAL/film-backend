/**
 * backend/services/videoProcessing.js
 *
 * NOTE: as of the Deepgram + GitHub Actions media-worker setup, this
 * local ffmpeg/whisper pipeline is no longer called from
 * uploadController.js — it's kept here only as a reference / fallback
 * for anyone who'd rather self-host processing later (e.g. once running
 * a server with ffmpeg installed makes sense). scripts/reprocessUpload.js
 * still uses this file directly if you want to invoke it manually.
 *
 * Runs after an own-upload's master file lands in R2:
 *  1. Download the master file locally (ffmpeg/whisper need local access)
 *  2. Probe it for duration/resolution
 *  3. Generate a thumbnail (ffmpeg)
 *  4. Generate a 30s preview clip (ffmpeg)
 *  5. Generate captions (whisper, via CLI)
 *  6. Upload all three outputs back to R2
 *  7. Update the Film document and clean up local temp files
 */

const path = require("path");
const os = require("os");
const crypto = require("crypto");
const fsp = require("fs/promises");
const { mkdirSync } = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const ffmpeg = require("fluent-ffmpeg");

const Film = require("../models/Film");
const storage = require("./storage");

const execFileAsync = promisify(execFile);

const WHISPER_COMMAND = process.env.WHISPER_COMMAND || "whisper";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const THUMBNAIL_SEEK_SECONDS = 5;
const PREVIEW_DURATION_SECONDS = 30;
const PREVIEW_WIDTH = 480;

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

// Uses seekInput (fast, seeks before decoding starts) rather than output
// seeking, since precise frame accuracy doesn't matter for a thumbnail and
// this is meaningfully faster on large files.
function generateThumbnail(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(THUMBNAIL_SEEK_SECONDS)
      .frames(1)
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function generatePreview(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .duration(PREVIEW_DURATION_SECONDS)
      .videoFilters(`scale=${PREVIEW_WIDTH}:-1`)
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

/**
 * Shells out to the Whisper CLI (pip install openai-whisper). Produces
 * <basename>.vtt in outDir. WHISPER_COMMAND lets you override how it's
 * invoked (e.g. "python -m whisper") if `whisper` isn't directly on PATH.
 */
async function generateCaptions(inputPath, outDir) {
  await execFileAsync(
    WHISPER_COMMAND,
    [inputPath, "--model", WHISPER_MODEL, "--output_format", "vtt", "--output_dir", outDir],
    { maxBuffer: 1024 * 1024 * 50 } // whisper logs progress to stdout; give it room
  );

  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(outDir, `${base}.vtt`);
}

async function processUpload(filmId) {
  const film = await Film.findById(filmId);
  if (!film) {
    throw new Error(`Film ${filmId} not found`);
  }
  if (!film.masterKey) {
    throw new Error(`Film ${filmId} has no masterKey to process`);
  }

  const workDir = path.join(os.tmpdir(), `film-upload-${filmId}-${crypto.randomUUID()}`);
  mkdirSync(workDir, { recursive: true });

  const ext = path.extname(film.masterKey) || ".mp4";
  const inputPath = path.join(workDir, `master${ext}`);
  const thumbPath = path.join(workDir, "thumb.jpg");
  const previewPath = path.join(workDir, "preview.mp4");

  try {
    film.transcodeStatus = "processing";
    await film.save();

    await storage.downloadFile(film.masterKey, inputPath);

    const probeData = await probe(inputPath);
    const videoStream = (probeData.streams || []).find((s) => s.codec_type === "video");
    const durationSeconds = Number(probeData.format?.duration || 0);

    await generateThumbnail(inputPath, thumbPath);
    await generatePreview(inputPath, previewPath);
    const vttPath = await generateCaptions(inputPath, workDir);

    // Derive sibling keys from the master's key so all of a film's assets
    // sit next to each other in the bucket.
    const baseKey = film.masterKey.replace(/\.[^/.]+$/, "");
    const thumbKey = `${baseKey}-thumb.jpg`;
    const previewKey = `${baseKey}-preview.mp4`;
    const captionsKey = `${baseKey}-captions.vtt`;

    const [posterUrl, previewUrl, captionsUrl] = await Promise.all([
      storage.uploadFile(thumbKey, thumbPath, "image/jpeg"),
      storage.uploadFile(previewKey, previewPath, "video/mp4"),
      storage.uploadFile(captionsKey, vttPath, "text/vtt"),
    ]);

    film.posterUrl = posterUrl;
    film.previewUrl = previewUrl;
    film.captionsUrl = captionsUrl;
    film.streamUrl = storage.getPublicUrl(film.masterKey);
    film.downloadUrl = film.streamUrl;
    film.sourceHeight = videoStream?.height || film.sourceHeight;
    film.runtime = durationSeconds ? Math.round(durationSeconds / 60) : film.runtime;
    film.transcodeStatus = "completed";
    // Own uploads skip the moderation queue — the admin already vetted this
    // by choosing to upload it in the first place.
    film.status = "approved";
    film.verifiedDate = new Date();

    await film.save();
    return film;
  } catch (err) {
    film.transcodeStatus = "failed";
    await film.save().catch(() => {});
    throw err;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { processUpload };
