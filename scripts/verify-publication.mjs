import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { hashQualityProof, validateQualityProof } from "./quality-proof.mjs";

const repository = "f-tuma/musubi";
const workflowPath = ".github/workflows/docker-publish.yml";
const shaPattern = /^(?!0{40}$)[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxArchiveBytes = 2 * 1024 * 1024;
const maxJsonBytes = 1024 * 1024;

export const PUBLICATION_JOB_NAMES = Object.freeze([
  "Quality provenance", "prepare", "Build api (amd64)", "Build api (arm64)",
  "Build web (amd64)", "Build web (arm64)", "Publish api manifest",
  "Publish web manifest", "release",
].sort());

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const timestamp = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  value.endsWith("Z") && Number.isFinite(Date.parse(value));

function inputs({ sourceSha, runId, version }) {
  requireThat(typeof sourceSha === "string" && sourceSha.length === 40 && shaPattern.test(sourceSha),
    "A full nonzero approved source SHA is required");
  requireThat(positive(runId), "A positive publication run ID is required");
  requireThat(typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) && !/\s/.test(version),
    "A release version X.Y.Z without a leading v is required");
}

function runGh(args, maxBuffer) {
  let result;
  try {
    result = spawnSync("gh", ["api", "--hostname", "github.com", "--method", "GET",
      "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", ...args], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
  } catch {
    throw new Error("Read-only GitHub request failed");
  }
  requireThat(result?.status === 0 && !result.error && Buffer.isBuffer(result.stdout),
    "Read-only GitHub request failed");
  return result.stdout;
}

// Endpoints are constructed locally. No response-provided URL or command is run.
export function readGitHubJson(path) {
  const bytes = runGh([`repos/${repository}${path ? `/${path}` : ""}`], maxJsonBytes);
  try { return JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("Read-only GitHub request returned malformed JSON");
  }
}

export function downloadGitHubArtifact(id) {
  requireThat(positive(id), "Invalid artifact ID");
  return runGh([`repos/${repository}/actions/artifacts/${id}/zip`], maxArchiveBytes);
}

export function readArtifactJson(bytes, filename) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maxArchiveBytes,
    "Artifact archive is empty or exceeds the size bound");
  requireThat(["quality-proof.json", "quality-recheck.json"].includes(filename),
    "Unexpected evidence filename");
  // zipfile reads one bounded regular file in memory; it never extracts paths or
  // executes archive contents. Its CRC/local-header checks remain enabled.
  const program = `import io,stat,sys,zipfile
data=sys.stdin.buffer.read(${maxArchiveBytes + 1})
if not data or len(data)>${maxArchiveBytes}: raise ValueError()
with zipfile.ZipFile(io.BytesIO(data)) as archive:
 entries=archive.infolist()
 if len(entries)!=1: raise ValueError()
 entry=entries[0]
 mode=entry.external_attr>>16
 if entry.filename!=sys.argv[1] or entry.is_dir() or entry.flag_bits&1: raise ValueError()
 if stat.S_IFMT(mode) not in (0,stat.S_IFREG): raise ValueError()
 if entry.file_size<1 or entry.file_size>${maxJsonBytes}: raise ValueError()
 if entry.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED): raise ValueError()
 value=archive.read(entry)
 if len(value)!=entry.file_size: raise ValueError()
 sys.stdout.buffer.write(value)
`;
  let result;
  try {
    result = spawnSync("python3", ["-c", program, filename], {
      input: bytes, stdio: ["pipe", "pipe", "pipe"], timeout: 5_000,
      maxBuffer: maxJsonBytes,
    });
  } catch { throw new Error("Artifact ZIP validation failed"); }
  requireThat(result?.status === 0 && !result.error && Buffer.isBuffer(result.stdout),
    "Artifact ZIP validation failed");
  let value;
  try { value = JSON.parse(result.stdout.toString("utf8")); } catch {
    throw new Error("Artifact evidence is malformed JSON");
  }
  requireThat(Buffer.from(canonical(value)).equals(result.stdout),
    "Artifact evidence is not canonical JSON");
  return { value, bytes: result.stdout, sha256: sha256(result.stdout) };
}

function trustedRepo(value, repoId) {
  return value?.full_name === repository && value.id === repoId;
}

function validateRun(run, { sourceSha, runId, repoId, workflow, quality = false }) {
  const name = quality ? "Quality" : "Publish Docker images";
  const path = quality ? ".github/workflows/quality.yml" : workflowPath;
  requireThat(run?.id === runId && positive(run.id) && positive(run.run_attempt) &&
    positive(run.run_number) && run.name === name && run.workflow_id === workflow.id &&
    run.path === path && run.event === (quality ? "push" : "workflow_dispatch") &&
    run.head_branch === "main" && run.head_sha === sourceSha &&
    trustedRepo(run.repository, repoId) && trustedRepo(run.head_repository, repoId) &&
    run.status === "completed" && run.conclusion === "success" &&
    run.html_url === `https://github.com/${repository}/actions/runs/${runId}` &&
    timestamp(run.created_at) && timestamp(run.run_started_at) && timestamp(run.updated_at) &&
    Date.parse(run.created_at) <= Date.parse(run.run_started_at) &&
    Date.parse(run.run_started_at) <= Date.parse(run.updated_at),
  quality ? "Linked Quality run provenance or state is invalid" :
    "Publication run provenance or state is invalid");
}

function runIdentity(run) {
  return JSON.stringify([run.id, run.run_number, run.run_attempt, run.workflow_id,
    run.name, run.path, run.event, run.head_branch, run.head_sha, run.status,
    run.conclusion, run.created_at, run.run_started_at, run.updated_at,
    run.repository?.id, run.head_repository?.id]);
}

function validateWorkflow(workflow, quality = false) {
  requireThat(positive(workflow?.id) && workflow.name === (quality ? "Quality" : "Publish Docker images") &&
    workflow.path === (quality ? ".github/workflows/quality.yml" : workflowPath) &&
    workflow.state === "active", "Unexpected workflow identity or state");
}

export function validatePublicationJobs(data, { sourceSha, runId, attempt }) {
  const jobs = data?.jobs;
  requireThat(data?.total_count === 9 && Array.isArray(jobs) && jobs.length === 9 &&
    new Set(jobs.map((job) => job?.id)).size === 9 &&
    new Set(jobs.map((job) => job?.name)).size === 9 &&
    JSON.stringify(jobs.map((job) => job?.name).sort()) === JSON.stringify(PUBLICATION_JOB_NAMES),
  "Expected exactly nine unique publication jobs; legacy29 is a different contract");
  requireThat(jobs.every((job) => positive(job.id) && job.run_id === runId &&
    job.run_attempt === attempt && job.head_sha === sourceSha &&
    job.status === "completed" && job.conclusion === "success" &&
    timestamp(job.started_at) && timestamp(job.completed_at) &&
    Date.parse(job.started_at) <= Date.parse(job.completed_at)),
  "A publication job has invalid source, attempt or completion");
  return [...jobs].sort((a, b) => a.name.localeCompare(b.name));
}

async function readArtifacts(readJSON, runId) {
  const artifacts = [];
  let expected;
  for (let page = 1; page <= 20; page++) {
    const data = await readJSON(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    requireThat(Number.isSafeInteger(data?.total_count) && data.total_count >= 0 &&
      data.total_count <= 2000 && Array.isArray(data.artifacts) && data.artifacts.length <= 100 &&
      (expected === undefined || expected === data.total_count), "Malformed or changing artifact pagination");
    expected = data.total_count;
    artifacts.push(...data.artifacts);
    requireThat(artifacts.length <= expected, "Malformed artifact pagination");
    if (artifacts.length === expected) {
      requireThat(new Set(artifacts.map((item) => item?.id)).size === artifacts.length,
        "Duplicate artifact identities");
      return artifacts;
    }
    requireThat(data.artifacts.length === 100, "Incomplete artifact pagination");
  }
  throw new Error("Artifact pagination exceeded its bound");
}

function selectArtifact(artifacts, { name, runId, repoId, sourceSha, now }) {
  const selected = artifacts.filter((artifact) => artifact?.name === name);
  requireThat(selected.length === 1, "Evidence artifact is missing or ambiguous");
  const artifact = selected[0];
  requireThat(positive(artifact.id) && artifact.expired === false &&
    digestPattern.test(artifact.digest ?? "") &&
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= maxArchiveBytes && timestamp(artifact.expires_at) &&
    Date.parse(artifact.expires_at) > now && artifact.workflow_run?.id === runId &&
    artifact.workflow_run.repository_id === repoId &&
    artifact.workflow_run.head_repository_id === repoId &&
    artifact.workflow_run.head_branch === "main" &&
    artifact.workflow_run.head_sha === sourceSha,
  "Evidence artifact provenance, digest or availability is invalid");
  return artifact;
}

function artifactIdentity(artifact) {
  return JSON.stringify([artifact.id, artifact.name, artifact.digest,
    artifact.expired, artifact.size_in_bytes, artifact.expires_at, artifact.workflow_run]);
}

function proofBinding(proof, { sourceSha, runId, attempt, version, repoId }) {
  validateQualityProof(proof, { sourceSha, repository });
  requireThat(proof.repository.id === repoId && proof.publication?.runId === runId &&
    proof.publication.runAttempt === attempt && proof.publication.version === version &&
    proof.publication.workflowSha === sourceSha &&
    proof.publication.workflowRef === `${repository}/${workflowPath}@refs/heads/main` &&
    proof.publication.event === "workflow_dispatch" && proof.publication.ref === "refs/heads/main",
  "Quality proof belongs to another publication source, run, attempt or version");
}

function validateRecheck(recheck, { sourceSha, runId, attempt, proof, proofHash, releaseJob }) {
  const keys = ["schemaVersion", "kind", "sampledAtUtc", "sourceSha", "publicationRunId",
    "publicationAttempt", "qualityRunId", "qualityAttempt", "proofSha256", "validated", "limit"];
  requireThat(recheck && JSON.stringify(Object.keys(recheck).sort()) === JSON.stringify(keys.sort()) &&
    recheck.schemaVersion === 1 && recheck.kind === "pre-deployment-tag-quality-revalidation" &&
    recheck.sourceSha === sourceSha && recheck.publicationRunId === String(runId) &&
    recheck.publicationAttempt === String(attempt) && recheck.qualityRunId === String(proof.run.id) &&
    recheck.qualityAttempt === String(proof.run.attempt) && recheck.proofSha256 === proofHash &&
    recheck.validated === true && timestamp(recheck.sampledAtUtc) &&
    Date.parse(recheck.sampledAtUtc) >= Date.parse(releaseJob.started_at) &&
    Date.parse(recheck.sampledAtUtc) <= Date.parse(releaseJob.completed_at) &&
    recheck.limit === "Read-only final snapshot; cannot atomically lock a later GitHub rerun.",
  "Pre-tag Quality revalidation receipt is invalid or not bound to this publication");
}

function validateLinkedQuality(run, jobs, proof, context) {
  validateRun(run, { ...context, runId: proof.run.id, quality: true });
  requireThat(run.run_attempt === proof.run.attempt && run.run_number === proof.run.number &&
    run.html_url === proof.run.url && run.created_at === proof.run.createdAt &&
    run.run_started_at === proof.run.startedAt && run.updated_at === proof.run.updatedAt,
  "Linked Quality run changed after the frozen proof");
  requireThat(jobs?.total_count === 21 && Array.isArray(jobs.jobs) && jobs.jobs.length === 21 &&
    new Set(jobs.jobs.map((job) => job?.id)).size === 21,
  "Linked Quality attempt does not contain all21 jobs");
  const actual = [...jobs.jobs].sort((a, b) => a.name?.localeCompare(b.name));
  const expected = [...proof.jobs].sort((a, b) => a.name.localeCompare(b.name));
  requireThat(actual.every((job, index) => {
    const accepted = expected[index];
    return positive(job.id) && job.id === accepted.id && job.name === accepted.name &&
      job.run_id === proof.run.id && job.run_attempt === proof.run.attempt &&
      job.head_sha === context.sourceSha && job.status === "completed" &&
      job.conclusion === "success" && job.started_at === accepted.startedAt &&
      job.completed_at === accepted.completedAt &&
      accepted.nativeSteps.every((step) => Array.isArray(job.steps) &&
        job.steps.filter((actualStep) => actualStep.name === step.name &&
          actualStep.number === step.number && actualStep.started_at === step.startedAt &&
          actualStep.completed_at === step.completedAt && actualStep.status === "completed" &&
          actualStep.conclusion === "success").length === 1);
  }), "Linked Quality jobs differ from the actual frozen21-job proof");
}

export async function collectPublicationProof({
  sourceSha, runId, version,
  readJSON: read = readGitHubJson,
  downloadArtifact = downloadGitHubArtifact,
  extractJSON = readArtifactJson,
  now = Date.now,
}) {
  inputs({ sourceSha, runId, version });
  const readJSON = async (path) => {
    try { return await read(path); } catch {
      throw new Error("Read-only publication metadata request failed");
    }
  };
  const repo = await readJSON("");
  requireThat(repo?.full_name === repository && positive(repo.id) && repo.fork === false &&
    repo.default_branch === "main", "Unexpected publication repository");
  const workflow = await readJSON("actions/workflows/docker-publish.yml");
  validateWorkflow(workflow);
  const run = await readJSON(`actions/runs/${runId}`);
  const context = { sourceSha, runId, repoId: repo.id, workflow };
  validateRun(run, context);
  const jobs = validatePublicationJobs(await readJSON(
    `actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`),
  { sourceSha, runId, attempt: run.run_attempt });
  const allArtifacts = await readArtifacts(readJSON, runId);
  const selected = [];
  const extracted = [];
  for (const [prefix, filename] of [["quality-proof", "quality-proof.json"],
    ["quality-recheck", "quality-recheck.json"]]) {
    const artifact = selectArtifact(allArtifacts, { ...context,
      name: `${prefix}-${runId}-${run.run_attempt}`, now: now() });
    let archive;
    try { archive = await downloadArtifact(artifact.id); } catch {
      throw new Error("Read-only evidence artifact download failed");
    }
    requireThat(Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= maxArchiveBytes &&
      `sha256:${sha256(archive)}` === artifact.digest, "Actual evidence ZIP digest does not match GitHub");
    selected.push(artifact);
    extracted.push(await extractJSON(archive, filename));
  }
  const [quality, recheck] = extracted;
  proofBinding(quality.value, { ...context, attempt: run.run_attempt, version });
  requireThat(quality.sha256 === hashQualityProof(quality.value), "Quality proof JSON digest is inconsistent");
  validateRecheck(recheck.value, { ...context, attempt: run.run_attempt,
    proof: quality.value, proofHash: quality.sha256, releaseJob: jobs.find((job) => job.name === "release") });
  const provenanceJob = jobs.find((job) => job.name === "Quality provenance");
  requireThat(Date.parse(quality.value.run.updatedAt) <= Date.parse(provenanceJob.completed_at) &&
    Date.parse(quality.value.run.updatedAt) <= Date.parse(recheck.value.sampledAtUtc) &&
    quality.value.jobs.every((job) => Date.parse(job.completedAt) <= Date.parse(recheck.value.sampledAtUtc)),
  "Quality completion must precede provenance acceptance and the pre-tag sample");
  const qualityWorkflow = await readJSON("actions/workflows/quality.yml");
  validateWorkflow(qualityWorkflow, true);
  requireThat(qualityWorkflow.id === quality.value.workflow.id,
    "Linked Quality workflow differs from the frozen proof");
  const discoveryPath = `actions/workflows/${qualityWorkflow.id}/runs?head_sha=${sourceSha}&event=push&branch=main&per_page=100&page=1`;
  const checkDiscovery = async () => {
    const found = await readJSON(discoveryPath);
    requireThat(found?.total_count === 1 && Array.isArray(found.workflow_runs) &&
      found.workflow_runs.length === 1 && found.workflow_runs[0]?.id === quality.value.run.id &&
      found.workflow_runs[0].run_attempt === quality.value.run.attempt,
    "Current exact-source Quality run is missing, ambiguous or changed");
    return found.workflow_runs[0];
  };
  const selectedQualityRun = await checkDiscovery();
  const qualityRun = await readJSON(`actions/runs/${quality.value.run.id}`);
  const qualityJobs = await readJSON(`actions/runs/${quality.value.run.id}/attempts/${quality.value.run.attempt}/jobs?per_page=100`);
  validateLinkedQuality(qualityRun, qualityJobs, quality.value, { ...context, workflow: qualityWorkflow });
  requireThat(runIdentity(selectedQualityRun) === runIdentity(qualityRun),
    "Linked Quality changed before job enumeration");
  const tag = await readJSON(`git/ref/tags/v${version}`);
  requireThat(tag?.ref === `refs/tags/v${version}` && tag.object?.type === "commit" &&
    tag.object.sha === sourceSha, "Release tag is not a direct ref to the approved source");
  const release = await readJSON(`releases/tags/v${version}`);
  requireThat(positive(release?.id) && release.tag_name === `v${version}` && release.draft === false &&
    release.prerelease === false && timestamp(release.published_at) &&
    release.html_url === `https://github.com/${repository}/releases/tag/v${version}`,
  "Final published GitHub release is invalid");
  const freshQualityRun = await readJSON(`actions/runs/${quality.value.run.id}`);
  validateLinkedQuality(freshQualityRun, qualityJobs, quality.value,
    { ...context, workflow: qualityWorkflow });
  requireThat(runIdentity(await checkDiscovery()) === runIdentity(freshQualityRun),
    "Current exact-source Quality changed during verification");
  const freshRun = await readJSON(`actions/runs/${runId}`);
  validateRun(freshRun, context);
  requireThat(runIdentity(freshRun) === runIdentity(run), "Publication run changed during verification");
  const freshArtifacts = await readArtifacts(readJSON, runId);
  selected.forEach((artifact) => {
    const fresh = selectArtifact(freshArtifacts, { ...context, name: artifact.name, now: now() });
    requireThat(artifactIdentity(fresh) === artifactIdentity(artifact), "Evidence artifact changed during verification");
  });
  const freshTag = await readJSON(`git/ref/tags/v${version}`);
  requireThat(freshTag?.ref === tag.ref && freshTag.object?.type === "commit" &&
    freshTag.object.sha === sourceSha, "Release tag changed during verification");
  return {
    schemaVersion: 2, kind: "publication-with-linked-main-quality", collectedAtUtc: new Date(now()).toISOString(),
    repository: { id: repo.id, name: repository }, sourceSha, version,
    publication: { runId, attempt: run.run_attempt, url: run.html_url, ownJobCount: 9,
      jobs: jobs.map((job) => ({ id: job.id, name: job.name, runAttempt: job.run_attempt,
        sourceSha: job.head_sha, status: job.status, conclusion: job.conclusion })) },
    linkedQuality: { runId: quality.value.run.id, attempt: quality.value.run.attempt,
      url: quality.value.run.url, actualMainJobCount: 21, proofSha256: quality.sha256,
      proof: quality.value, currentRunAndAttemptRechecked: true },
    evidenceArtifacts: selected.map((artifact, index) => ({ id: artifact.id, name: artifact.name,
      archiveSha256: artifact.digest.slice(7), fileSha256: extracted[index].sha256,
      actualArchiveDownloadedAndHashed: true })),
    preTagRevalidation: recheck.value,
    release: { id: release.id, url: release.html_url, tag: tag.ref, directCommit: sourceSha,
      publishedAt: release.published_at },
    limits: [
      "Nine publication jobs and21 linked main jobs are distinct executions; no new29-job run is claimed.",
      "GitHub artifact ZIP digest, contained JSON digest and OCI image/index digests are different values.",
      "Read-only snapshots cannot atomically lock later Quality reruns, artifact deletion or tag mutation.",
      "This proof does not verify OCI images, four image digest artifacts, descriptor unions, running revisions, backup/restore or maintenance. Verify those separately.",
    ],
  };
}

function argumentsFrom(argv) {
  const allowed = new Set(["--source", "--run-id", "--version", "--output"]);
  const options = {};
  requireThat(argv.length === 8, "Use --source SHA --run-id ID --version X.Y.Z --output fresh.json");
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    requireThat(allowed.has(flag) && !Object.hasOwn(options, flag) &&
      typeof argv[index + 1] === "string" && argv[index + 1].length > 0,
    "Invalid or duplicate publication verifier argument");
    options[flag] = argv[index + 1];
  }
  requireThat(/^[1-9]\d*$/.test(options["--run-id"] ?? "") && !/\s/.test(options["--run-id"]),
    "Invalid publication run ID");
  return { sourceSha: options["--source"], runId: Number(options["--run-id"]),
    version: options["--version"], output: options["--output"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { output, ...options } = argumentsFrom(process.argv.slice(2));
    const proof = await collectPublicationProof(options);
    writeFileSync(output, canonical(proof), { flag: "wx", mode: 0o600 });
    console.log(`Publication verified:9 own jobs plus21 linked main jobs; source ${proof.sourceSha}`);
  } catch {
    // Response bodies, authenticated URLs, stderr and tokens are never relayed.
    console.error("Publication verification failed; no evidence was overwritten or publication action attempted");
    process.exitCode = 1;
  }
}
