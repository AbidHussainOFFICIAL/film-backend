/**
 * backend/services/githubActions.js
 *
 * Dispatches workflows in the heavy backend repo (film-media-worker).
 * Generic by design: callers pass which workflow file to run and what
 * inputs it needs. This is fire-and-forget — it kicks a job off and
 * returns as soon as GitHub accepts the dispatch request, it does NOT
 * wait for the workflow to finish. Completion is reported back
 * asynchronously via the /api/service/* routes.
 */

const GITHUB_PAT = process.env.GITHUB_PAT;
const REPO_OWNER = process.env.GITHUB_HEAVY_REPO_OWNER;
const REPO_NAME = process.env.GITHUB_HEAVY_REPO_NAME;
const REPO_REF = process.env.GITHUB_HEAVY_REPO_REF || "main";

async function triggerWorkflow(workflowFile, inputs = {}) {
  if (!GITHUB_PAT || !REPO_OWNER || !REPO_NAME) {
    throw new Error(
      "Missing GITHUB_PAT / GITHUB_HEAVY_REPO_OWNER / GITHUB_HEAVY_REPO_NAME in .env"
    );
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: REPO_REF, inputs }),
  });

  // workflow_dispatch returns 204 No Content on success — no JSON body to parse.
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub workflow dispatch failed (HTTP ${res.status}): ${body}`);
  }
}

function triggerUploadProcessing(filmId, masterKey) {
  return triggerWorkflow("process-upload.yml", { film_id: String(filmId), master_key: masterKey });
}

function triggerIngest(jobRunId) {
  return triggerWorkflow("ingest.yml", { job_run_id: String(jobRunId) });
}

function triggerQdrantReindex(jobRunId) {
  return triggerWorkflow("qdrant-reindex.yml", { job_run_id: String(jobRunId) });
}

module.exports = {
  triggerWorkflow,
  triggerUploadProcessing,
  triggerIngest,
  triggerQdrantReindex,
};
