import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repositoryName = "f-tuma/musubi";
const qualityPath = ".github/workflows/quality.yml";
const publicationRef = `${repositoryName}/.github/workflows/docker-publish.yml@refs/heads/main`;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) && value !== "0".repeat(40);
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const require = (condition, message) => { if (!condition) throw new Error(`Quality proof: ${message}`); };
const exactKeys = (object, keys) => object !== null && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join("\n") === [...keys].sort().join("\n");
const keys = (object, fields, message) => require(exactKeys(object, fields), message);

export const QUALITY_JOB_NAMES = Object.freeze([
  "API container boots and serves", "Android system bars", "Build API (arm64) image", "Build API image",
  "Build docs image", "Build web (arm64) image", "Build web image", "Client bundle secret scan",
  "Component interaction and accessibility", ...[1, 2, 3, 4].map((n) => `Database integration (${n}/4)`),
  "Observability", "Old client compatibility", "Typecheck, test, lint, docs, and migrations",
  ...[1, 2, 3, 4].map((n) => `Web end-to-end (${n}/4)`), "Web production container boots in Chromium",
].sort());
const nativeStepNames = Object.freeze([
  "Build native APK and AAB with system bar verification", "Verify shipped DEX",
]);

function validateNativeSteps(steps, android) {
  require(Array.isArray(steps) && steps.length === (android ? 2 : 0), "native step evidence is incomplete");
  if (!android) return;
  require(steps.every((step, index) => step?.name === nativeStepNames[index]), "native step identity mismatch");
  const numbers = new Set();
  for (const step of steps) {
    keys(step, ["name", "number", "status", "conclusion", "startedAt", "completedAt"], "unexpected native step schema");
    require(integer(step.number) && !numbers.has(step.number) && step.status === "completed" && step.conclusion === "success" &&
      timestamp(step.startedAt) && timestamp(step.completedAt) && Date.parse(step.completedAt) >= Date.parse(step.startedAt),
    "native APK/AAB build or DEX verification did not succeed");
    numbers.add(step.number);
  }
  require(steps[0].number < steps[1].number, "native verification step order mismatch");
}

/** Validate an immutable, sanitized receipt; this alone does not refresh GitHub. */
export function validateQualityProof(proof, { sourceSha, repository = repositoryName } = {}) {
  require(repository === repositoryName, "unexpected trusted repository");
  keys(proof, ["schemaVersion", "kind", "repository", "sourceSha", "workflow", "run", "jobs", "publication"], "unexpected receipt schema");
  require(proof.schemaVersion === 1 && proof.kind === "trusted-main-quality" && sha(proof.sourceSha) &&
    (sourceSha === undefined || proof.sourceSha === sourceSha), "receipt source or version mismatch");
  keys(proof.repository, ["id", "name"], "unexpected repository schema");
  require(integer(proof.repository.id) && proof.repository.name === repositoryName, "repository identity mismatch");
  keys(proof.workflow, ["id", "name", "path"], "unexpected workflow schema");
  require(integer(proof.workflow.id) && proof.workflow.name === "Quality" && proof.workflow.path === qualityPath, "workflow identity mismatch");
  const run = proof.run;
  keys(run, ["id", "number", "attempt", "url", "event", "branch", "sourceSha", "status", "conclusion", "createdAt", "startedAt", "updatedAt"], "unexpected run schema");
  require(integer(run.id) && integer(run.number) && integer(run.attempt) &&
    run.url === `https://github.com/${repositoryName}/actions/runs/${run.id}` &&
    run.event === "push" && run.branch === "main" && run.sourceSha === proof.sourceSha &&
    run.status === "completed" && run.conclusion === "success" && timestamp(run.createdAt) &&
    timestamp(run.startedAt) && timestamp(run.updatedAt) && Date.parse(run.startedAt) >= Date.parse(run.createdAt) &&
    Date.parse(run.updatedAt) >= Date.parse(run.startedAt), "run identity, status or timing mismatch");
  require(Array.isArray(proof.jobs) && proof.jobs.length === 21 && QUALITY_JOB_NAMES.length === 21, "expected all 21 Quality jobs");
  const ids = new Set();
  for (let index = 0; index < proof.jobs.length; index++) {
    const job = proof.jobs[index];
    keys(job, ["id", "name", "runId", "runAttempt", "sourceSha", "status", "conclusion", "startedAt", "completedAt", "nativeSteps"], "unexpected job schema");
    require(job.name === QUALITY_JOB_NAMES[index] && integer(job.id) && !ids.has(job.id) && job.runId === run.id &&
      job.runAttempt === run.attempt && job.sourceSha === proof.sourceSha && job.status === "completed" &&
      job.conclusion === "success" && timestamp(job.startedAt) && timestamp(job.completedAt) &&
      Date.parse(job.completedAt) >= Date.parse(job.startedAt), "missing, duplicate, unsuccessful or wrong-attempt Quality job");
    ids.add(job.id);
    validateNativeSteps(job.nativeSteps, job.name === "Android system bars");
  }
  const publication = proof.publication;
  keys(publication, ["runId", "runAttempt", "workflowRef", "workflowSha", "event", "ref", "version"], "unexpected publication schema");
  require(integer(publication.runId) && integer(publication.runAttempt) && publication.workflowRef === publicationRef &&
    publication.workflowSha === proof.sourceSha && publication.event === "workflow_dispatch" && publication.ref === "refs/heads/main" &&
    typeof publication.version === "string" && /^\d+\.\d+\.\d+$/.test(publication.version), "publication consumer binding mismatch");
  return proof;
}

const serialize = (proof) => `${JSON.stringify(proof, null, 2)}\n`;
export function hashQualityProof(proof) {
  validateQualityProof(proof);
  return createHash("sha256").update(serialize(proof)).digest("hex");
}

export function runGit(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 15_000, maxBuffer: 1024 * 1024 });
}

function input(env, cwd, git) {
  require(env.GITHUB_REPOSITORY === repositoryName && env.GITHUB_SERVER_URL === "https://github.com" &&
    env.GITHUB_API_URL === "https://api.github.com", "release must use the trusted GitHub repository");
  require(sha(env.GITHUB_SHA) && env.GITHUB_SHA === env.EXPECTED_SOURCE_SHA && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
    env.GITHUB_WORKFLOW_REF === publicationRef && env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch", "publication workflow or captured source mismatch");
  require(typeof env.GH_TOKEN === "string" && env.GH_TOKEN.length > 0 && !/\s/.test(env.GH_TOKEN), "authenticated read token is required");
  for (const field of ["GITHUB_REPOSITORY_ID", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    require(typeof env[field] === "string" && /^[1-9]\d*$/.test(env[field]) && integer(Number(env[field])), "invalid publication numeric identity");
  }
  require(typeof env.RELEASE_VERSION === "string" && /^\d+\.\d+\.\d+$/.test(env.RELEASE_VERSION), "invalid release version");
  let head;
  try { head = git(["rev-parse", "--verify", "HEAD^{commit}"], cwd); } catch { throw new Error("Quality proof: cannot verify checkout HEAD"); }
  require(head?.status === 0 && !head.error && typeof head.stdout === "string" && head.stdout.trim() === env.GITHUB_SHA,
    "checkout HEAD does not match the captured source");
  return {
    sourceSha: env.GITHUB_SHA, repositoryId: Number(env.GITHUB_REPOSITORY_ID),
    publication: { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), workflowRef: env.GITHUB_WORKFLOW_REF,
      workflowSha: env.GITHUB_WORKFLOW_SHA, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, version: env.RELEASE_VERSION },
  };
}

function githubReadEndpoint(path) {
  if (path === "") return "repository";
  if (path === "/git/ref/heads/main") return "main";
  if (path === "/actions/workflows/quality.yml") return "quality-workflow";
  if (/^\/actions\/workflows\/[1-9]\d*\/runs\?head_sha=[a-f0-9]{40}&event=push&branch=main&per_page=100&page=1$/.test(path)) return "quality-run-list";
  if (/^\/actions\/runs\/[1-9]\d*$/.test(path)) return "quality-run";
  if (/^\/actions\/runs\/[1-9]\d*\/attempts\/[1-9]\d*\/jobs\?per_page=100&page=1$/.test(path)) return "quality-jobs";
  return "unknown";
}

async function readGitHub(path, env, fetchImpl) {
  let response, body, status;
  let stage = "transport";
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repositoryName}${path}`, {
      method: "GET", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    stage = "http-status";
    const rawStatus = response?.status;
    if (Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599) status = rawStatus;
    require(rawStatus === 200, "GitHub read did not return a successful JSON response");
    stage = "redirect";
    require(!response.redirected, "GitHub read did not return a successful JSON response");
    stage = "content-type";
    require(/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(response.headers?.get("content-type") ?? ""), "GitHub read did not return a successful JSON response");
    stage = "pagination";
    require(!/rel="next"/.test(response.headers?.get("link") ?? ""), "incomplete or ambiguous paginated GitHub response");
    stage = "declared-size";
    require(Number(response.headers?.get("content-length") ?? 0) <= 2 * 1024 * 1024, "GitHub response exceeds the proof limit");
    stage = "body-read";
    body = await response.text();
    stage = "body-size";
    require(Buffer.byteLength(body) <= 2 * 1024 * 1024, "GitHub response exceeds the proof limit");
    stage = "json";
    return JSON.parse(body);
  } catch {
    // Transport, parser and remote errors may contain tokens or private URLs.
    // Only locally classified endpoint/stage names and bounded HTTP status escape.
    throw new Error("Quality proof: GitHub read failed, was incomplete, or returned malformed data " +
      `(endpoint=${githubReadEndpoint(path)}, stage=${stage}, status=${status ?? "unknown"})`);
  }
}

function workflowIdentity(workflow) {
  require(integer(workflow?.id) && workflow.name === "Quality" && workflow.path === qualityPath && workflow.state === "active",
    "unexpected active Quality workflow identity");
  return { id: workflow.id, name: workflow.name, path: workflow.path };
}

function runIdentity(run, context, workflow) {
  require(integer(run?.id) && integer(run.run_number) && integer(run.run_attempt) && run.workflow_id === workflow.id &&
    run.name === workflow.name && run.path === qualityPath && run.event === "push" && run.head_branch === "main" &&
    run.head_sha === context.sourceSha && run.repository?.id === context.repositoryId && run.repository.full_name === repositoryName &&
    run.head_repository?.id === context.repositoryId && run.head_repository.full_name === repositoryName &&
    run.status === "completed" && run.conclusion === "success" && run.html_url === `https://github.com/${repositoryName}/actions/runs/${run.id}`,
  "Quality must be a successful current trusted main push run for the exact source");
  return { id: run.id, number: run.run_number, attempt: run.run_attempt, url: run.html_url, event: run.event,
    branch: run.head_branch, sourceSha: run.head_sha, status: run.status, conclusion: run.conclusion,
    createdAt: run.created_at, startedAt: run.run_started_at, updatedAt: run.updated_at };
}

async function discover(read, context, workflow) {
  const result = await read(`/actions/workflows/${workflow.id}/runs?head_sha=${context.sourceSha}&event=push&branch=main&per_page=100&page=1`);
  require(result?.total_count === 1 && Array.isArray(result.workflow_runs) && result.workflow_runs.length === 1,
    "expected one unambiguous main push Quality run; no fallback to an older run");
  return runIdentity(result.workflow_runs[0], context, workflow);
}

function sanitizeJobs(data) {
  require(data?.total_count === 21 && Array.isArray(data.jobs) && data.jobs.length === 21, "expected all 21 current-attempt jobs");
  return data.jobs.map((job) => {
    require(job && typeof job.name === "string", "malformed job identity");
    let nativeSteps = [];
    if (job.name === "Android system bars") {
      require(Array.isArray(job.steps), "missing native build and DEX evidence");
      nativeSteps = nativeStepNames.map((name) => {
        const found = job.steps.filter((step) => step?.name === name);
        require(found.length === 1, "missing or duplicate native verification step");
        const step = found[0];
        return { name, number: step.number, status: step.status, conclusion: step.conclusion,
          startedAt: step.started_at, completedAt: step.completed_at };
      });
    }
    return { id: job.id, name: job.name, runId: job.run_id, runAttempt: job.run_attempt, sourceSha: job.head_sha,
      status: job.status, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at, nativeSteps };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

/** Collect one stable snapshot; it is not an atomic lock against a later rerun. */
export async function collectQualityProof({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, git = runGit, pinnedProof } = {}) {
  const context = input(env, cwd, git);
  if (pinnedProof !== undefined) {
    validateQualityProof(pinnedProof, { sourceSha: context.sourceSha });
    require(JSON.stringify(pinnedProof.publication) === JSON.stringify(context.publication), "receipt belongs to another publication run or attempt");
  }
  const read = (path) => readGitHub(path, env, fetchImpl);
  const repository = await read("");
  require(repository?.id === context.repositoryId && repository.full_name === repositoryName && repository.fork === false &&
    repository.default_branch === "main", "authenticated repository identity mismatch");
  const main = await read("/git/ref/heads/main");
  require(main?.ref === "refs/heads/main" && main.object?.type === "commit" && sha(main.object.sha), "invalid trusted main reference");
  // Main can advance; the release remains pinned to its approved captured SHA.
  const workflow = workflowIdentity(await read("/actions/workflows/quality.yml"));
  const selected = await discover(read, context, workflow);
  if (pinnedProof !== undefined) require(selected.id === pinnedProof.run.id && selected.attempt === pinnedProof.run.attempt,
    "selected Quality run or attempt changed since preparation");
  const before = runIdentity(await read(`/actions/runs/${selected.id}`), context, workflow);
  require(JSON.stringify(before) === JSON.stringify(selected), "Quality changed before job enumeration");
  const jobs = sanitizeJobs(await read(`/actions/runs/${selected.id}/attempts/${selected.attempt}/jobs?per_page=100&page=1`));
  const after = runIdentity(await read(`/actions/runs/${selected.id}`), context, workflow);
  const freshSelected = await discover(read, context, workflow);
  const freshWorkflow = workflowIdentity(await read("/actions/workflows/quality.yml"));
  require(JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(after) === JSON.stringify(freshSelected) &&
    JSON.stringify(workflow) === JSON.stringify(freshWorkflow), "Quality run, attempt or workflow changed during verification");
  const proof = { schemaVersion: 1, kind: "trusted-main-quality", repository: { id: repository.id, name: repositoryName },
    sourceSha: context.sourceSha, workflow, run: after, jobs, publication: context.publication };
  validateQualityProof(proof, { sourceSha: context.sourceSha });
  if (pinnedProof !== undefined) require(serialize(proof) === serialize(pinnedProof), "Quality evidence changed since preparation");
  return proof;
}

/** Revalidate the exact downloaded receipt and current GitHub state; never adopt a new attempt. */
export async function recheckQualityProof({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, git = runGit,
  proofPath = env.QUALITY_PROOF_PATH, expectedHash = env.QUALITY_PROOF_SHA256,
  expectedRunId = env.QUALITY_RUN_ID, expectedAttempt = env.QUALITY_RUN_ATTEMPT } = {}) {
  require(typeof proofPath === "string" && proofPath.length > 0 && typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash),
    "downloaded receipt path and externally pinned SHA256 are required");
  require(typeof expectedRunId === "string" && /^[1-9]\d*$/.test(expectedRunId) && integer(Number(expectedRunId)) &&
    typeof expectedAttempt === "string" && /^[1-9]\d*$/.test(expectedAttempt) && integer(Number(expectedAttempt)), "externally pinned run and attempt are required");
  let bytes, proof;
  try { bytes = readFileSync(proofPath); require(bytes.length <= 1024 * 1024, "receipt too large"); proof = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Quality proof: cannot read the downloaded receipt"); }
  require(createHash("sha256").update(bytes).digest("hex") === expectedHash, "downloaded receipt SHA256 mismatch");
  validateQualityProof(proof, { sourceSha: env.EXPECTED_SOURCE_SHA });
  require(bytes.toString("utf8") === serialize(proof) && proof.run.id === Number(expectedRunId) && proof.run.attempt === Number(expectedAttempt),
    "downloaded receipt does not match the pinned run or canonical encoding");
  return collectQualityProof({ env, cwd, fetchImpl, git, pinnedProof: proof });
}

export async function runQualityProof({ mode, env = process.env, cwd = process.cwd(), fetchImpl = fetch, git = runGit } = {}) {
  require(["record", "recheck"].includes(mode), "use quality-proof.mjs record or recheck");
  if (mode === "recheck") return recheckQualityProof({ env, cwd, fetchImpl, git });
  require(typeof env.QUALITY_PROOF_PATH === "string" && env.QUALITY_PROOF_PATH.length > 0, "a fresh receipt path is required");
  const proof = await collectQualityProof({ env, cwd, fetchImpl, git });
  try { writeFileSync(env.QUALITY_PROOF_PATH, serialize(proof), { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("Quality proof: cannot exclusively create the receipt"); }
  const digest = hashQualityProof(proof);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run_id=${proof.run.id}\nrun_attempt=${proof.run.attempt}\nproof_sha256=${digest}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
    `## Reused main Quality\n\n[Run ${proof.run.id}, attempt ${proof.run.attempt}](${proof.run.url}): all 21 exact-source jobs succeeded.\n\nSource: \`${proof.sourceSha}\`; receipt SHA256: \`${digest}\`. These jobs ran on main, not again in this publication.\n`);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const proof = await runQualityProof({ mode: process.argv[2] });
    console.log(`Quality proof verified: main run ${proof.run.id}, attempt ${proof.run.attempt}, 21 jobs at ${proof.sourceSha}`);
  } catch {
    console.error("Quality proof verification failed; no release authorization was established");
    process.exitCode = 1;
  }
}
