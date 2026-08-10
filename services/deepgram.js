/**
 * backend/services/deepgram.js
 *
 * Generates WebVTT captions via Deepgram's pre-recorded transcription API.
 * Deepgram fetches the media URL itself (your R2 public URL) — the file
 * never passes through this server, and there's no local ffmpeg/whisper
 * compute involved. This is a plain HTTP call plus an idle wait for
 * Deepgram's response, not local heavy processing.
 */

const { createClient } = require("@deepgram/sdk");
const { webvtt } = require("@deepgram/captions");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

let client = null;

function getClient() {
  if (!DEEPGRAM_API_KEY) {
    throw new Error("Missing DEEPGRAM_API_KEY in .env");
  }
  if (!client) {
    client = createClient(DEEPGRAM_API_KEY);
  }
  return client;
}

/**
 * Transcribes a publicly reachable media URL and returns a ready-to-use
 * WebVTT string, using Deepgram's own official conversion library so the
 * timestamp/cue formatting is correct rather than hand-rolled.
 */
async function transcribeToVtt(mediaUrl) {
  const dg = getClient();

  const { result, error } = await dg.listen.prerecorded.transcribeUrl(
    { url: mediaUrl },
    { model: "nova-3", smart_format: true, utterances: true }
  );

  if (error) {
    throw new Error(`Deepgram transcription failed: ${error.message || error}`);
  }

  return webvtt(result);
}

module.exports = { transcribeToVtt };
