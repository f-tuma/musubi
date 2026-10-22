import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { recheckQualityProof } from "./quality-proof.mjs";

const shaPattern = /^[a-f0-9]{40}$/;
const httpTimeoutMs = 15_000;
const isSha = (value) => typeof value === "string" && value.length === 40 && shaPattern.test(value);

function checkedInputs(mode, env) {
  if (!["check", "tag", "release"].includes(mode)) {
    throw new Error("Use release-guard.mjs check, tag, or release");
  }
  const version = env.RELEASE_VERSION;
  const sourceSha = env.GITHUB_SHA;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || /\s/.test(version)) {
    throw new Error("RELEASE_VERSION must be X.Y.Z without a leading v");
  }
  if (!isSha(env.EXPECTED_SOURCE_SHA) || !isSha(sourceSha)) {
    throw new Error("Expected and captured source SHA must be full lowercase 40-character hashes");
  }
  if (env.EXPECTED_SOURCE_SHA !== sourceSha) {
    throw new Error("Captured source SHA does not match the approved release SHA");
  }
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Releases must run from refs/heads/main");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
      /\s/.test(env.GITHUB_REPOSITORY ?? "") || [".", ".."].includes(env.GITHUB_REPOSITORY?.split("/")[1])) {
    throw new Error("GITHUB_REPOSITORY must identify owner/repository");
  }
  if (typeof env.GH_TOKEN !== "string" || !env.GH_TOKEN || /\s/.test(env.GH_TOKEN)) {
    throw new Error("GH_TOKEN is required for the authenticated release check");
  }
  if (mode === "release" && env.OWNED_TAG_SOURCE_SHA !== sourceSha) {
    throw new Error("Release publication requires the source SHA from a successful owned tag step");
  }
  return { version, sourceSha, tag: `v${version}`, ref: `refs/tags/v${version}` };
}

export function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
}

function gitOutput(git, args, cwd, message) {
  let result;
  try {
    result = git(args, cwd);
  } catch {
    throw new Error(message);
  }
  if (result?.status !== 0 || result.error || typeof result.stdout !== "string") {
    // Git errors can contain authenticated remote URLs. Never relay raw output.
    throw new Error(message);
  }
  return result.stdout;
}

async function requestGitHub(env, path, fetchImpl, body) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env.GH_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(httpTimeoutMs),
      },
    );
  } catch {
    throw new Error("Cannot establish release references: GitHub request failed or timed out");
  }
  return response;
}

function hasJsonBody(response) {
  return !response?.redirected &&
    /^application\/json(?:\s*;|$)/i.test(response?.headers?.get("content-type") ?? "");
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Cannot establish release references: GitHub returned malformed JSON");
  }
}

async function requireMissingTag(env, tag, fetchImpl) {
  // A bare 404 can also hide an inaccessible repository. First prove this
  // authenticated token can read Git contents. Main may advance during a build;
  // only the captured workflow/checkout SHA is the approved publication source.
  const mainResponse = await requestGitHub(env, "git/ref/heads/main", fetchImpl);
  if (mainResponse?.status !== 200 || !hasJsonBody(mainResponse)) {
    throw new Error("Cannot establish authenticated Git contents access");
  }
  const main = await readJson(mainResponse);
  if (main?.ref !== "refs/heads/main" || main.object?.type !== "commit" ||
      !isSha(main.object.sha)) {
    throw new Error("Cannot establish authenticated Git contents access: unexpected main reference");
  }
  for (const [path, kind] of [[`git/ref/tags/${tag}`, "tag"], [`releases/tags/${tag}`, "release"]]) {
    await requireMissingRecord(await requestGitHub(env, path, fetchImpl), kind);
  }
  // getReleaseByTag can hide a draft. The contents-write tag job repeats this
  // check and lists drafts visible to its authenticated token before the signal.
  for (let page = 1; page <= 100; page++) {
    const response = await requestGitHub(env, `releases?per_page=100&page=${page}`, fetchImpl);
    if (response?.status !== 200 || !hasJsonBody(response)) {
      throw new Error("Cannot establish absence of an existing draft or published release");
    }
    const releases = await readJson(response);
    if (!Array.isArray(releases) || releases.length > 100 || releases.some((release) =>
      !release || typeof release.tag_name !== "string" || typeof release.draft !== "boolean")) {
      throw new Error("Cannot establish release absence: malformed release page");
    }
    if (releases.some((release) => release.tag_name === tag)) {
      throw new Error("A draft or published release already owns this version; publication is blocked");
    }
    if (releases.length < 100) return;
  }
  throw new Error("Cannot establish release absence: pagination limit reached");
}

function requireRemoteTag(git, cwd, release) {
  const remote = gitOutput(git,
    ["ls-remote", "--exit-code", "--refs", "origin", release.ref], cwd,
    "Cannot verify the published release tag").trim();
  if (remote !== `${release.sourceSha}\t${release.ref}`) {
    throw new Error("Published release tag does not match the approved source SHA");
  }
}

const reconcileMessage = "HOLD: tag creation may already have triggered deployment. " +
  "Operator reconciliation is required; do not retry, delete, recreate, or adopt the tag.";

async function createRelease(env, cwd, release, git, fetchImpl) {
  try {
    requireRemoteTag(git, cwd, release);
    const notesPath = join(cwd, "docs", "releases", `${release.version}-notes.md`);
    const body = {
      tag_name: release.tag,
      target_commitish: release.sourceSha,
      name: `Musubi ${release.tag}`,
      draft: false,
      generate_release_notes: true,
      ...(existsSync(notesPath) ? { body: readFileSync(notesPath, "utf8") } : {}),
    };
    // Strict create has no existing-release update path and is never retried.
    const response = await requestGitHub(env, "releases", fetchImpl, body);
    if (response?.status !== 201 || !hasJsonBody(response)) throw new Error("Release was not created");
    const created = await readJson(response);
    if (created?.tag_name !== release.tag || created.draft !== false) {
      throw new Error("Created release cannot be verified");
    }
    // target_commitish is ignored by GitHub for an existing tag; the actual
    // remote ref, not the echoed release field, is our source authority.
    requireRemoteTag(git, cwd, release);
    return release;
  } catch {
    throw new Error(reconcileMessage);
  }
}

async function requireMissingRecord(response, kind) {
  if (response?.status === 200) {
    throw new Error(`GitHub ${kind} already exists; it cannot be adopted or overwritten`);
  }
  if (response?.status !== 404 || !hasJsonBody(response)) {
    throw new Error("Cannot establish tag absence: only a valid GitHub 404 is accepted");
  }
  const body = await readJson(response);
  if (!body || Array.isArray(body) || body.message !== "Not Found") {
    throw new Error("Cannot establish tag absence: GitHub returned an unexpected 404 body");
  }
}

export async function runReleaseGuard({
  mode,
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  git = runGit,
  qualityCheck = recheckQualityProof,
}) {
  const release = checkedInputs(mode, env);
  const head = gitOutput(git, ["rev-parse", "--verify", "HEAD^{commit}"], cwd,
    "Cannot establish the checked-out source SHA").trim();
  if (head !== release.sourceSha) {
    throw new Error("Checkout HEAD does not match the captured and approved source SHA");
  }
  if (mode === "release") return createRelease(env, cwd, release, git, fetchImpl);
  await requireMissingTag(env, release.tag, fetchImpl);
  // The proof's externally pinned bytes and the latest exact main attempt must
  // still agree after all absence checks, immediately before the deployment
  // signal. Never adopt a newer attempt or retarget a moving main branch.
  await qualityCheck({ env, cwd, fetchImpl, git });
  if (mode === "check") return release;

  if (env.QUALITY_RECHECK_PATH !== undefined) {
    try {
      writeFileSync(env.QUALITY_RECHECK_PATH, JSON.stringify({
        schemaVersion: 1,
        kind: "pre-deployment-tag-quality-revalidation",
        sampledAtUtc: new Date().toISOString(),
        sourceSha: release.sourceSha,
        publicationRunId: env.GITHUB_RUN_ID,
        publicationAttempt: env.GITHUB_RUN_ATTEMPT,
        qualityRunId: env.QUALITY_RUN_ID,
        qualityAttempt: env.QUALITY_RUN_ATTEMPT,
        proofSha256: env.QUALITY_PROOF_SHA256,
        validated: true,
        limit: "Read-only final snapshot; cannot atomically lock a later GitHub rerun.",
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      throw new Error("Cannot retain the final Quality revalidation; deployment tag was not attempted");
    }
  }

  // This is the deployment signal, not preparation. No retry, force, deletion,
  // or adoption of another publisher's tag is safe after a push is attempted.
  try {
    const output = gitOutput(git,
      ["push", "--porcelain", "origin", `${release.sourceSha}:${release.ref}`], cwd,
      "Tag push did not complete successfully");
    const statuses = output.split(/\r?\n/).filter((line) => line.includes("\t"));
    const freshStatus = `*\t${release.sourceSha}:${release.ref}\t[new tag]`;
    if (statuses.length !== 1 || statuses[0] !== freshStatus) {
      throw new Error("Tag push did not prove a freshly created release tag");
    }
    requireRemoteTag(git, cwd, release);
  } catch {
    throw new Error(reconcileMessage);
  }
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const release = await runReleaseGuard({ mode: process.argv[2] });
    console.log(process.argv[2] === "tag"
      ? `Created ${release.tag} at ${release.sourceSha}; deployment may now be running`
      : process.argv[2] === "release"
        ? `Published ${release.tag} at ${release.sourceSha}; verify the running deployments separately`
        : `Release source and tag absence verified: ${release.tag} at ${release.sourceSha}`);
  } catch (error) {
    console.error(`Release guard: ${error.message}`);
    process.exitCode = 1;
  }
}
