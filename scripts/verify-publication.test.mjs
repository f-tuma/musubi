import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { QUALITY_JOB_NAMES, hashQualityProof } from "./quality-proof.mjs";
import { collectPublicationProof, PUBLICATION_JOB_NAMES, readArtifactJson,
  validatePublicationJobs } from "./verify-publication.mjs";

const sourceSha = "a".repeat(40);
const repoId = 123;
const runId = 8000;
const qualityId = 7000;
const iso = (time) => `2026-10-22T${time}:00Z`;
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const copy = (value) => structuredClone(value);

function zipEntries(entries) {
  const code = `import io,json,stat,sys,zipfile
result=io.BytesIO()
with zipfile.ZipFile(result,'w',zipfile.ZIP_DEFLATED) as archive:
 for entry in json.load(sys.stdin):
  item=zipfile.ZipInfo(entry['name'])
  item.external_attr=entry.get('mode',stat.S_IFREG|0o600)<<16
  archive.writestr(item,entry['body'])
sys.stdout.buffer.write(result.getvalue())
`;
  const result = spawnSync("python3", ["-c", code], {
    input: JSON.stringify(entries), maxBuffer: 3 * 1024 * 1024, timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return result.stdout;
}

function fixture() {
  const repo = { id: repoId, full_name: "f-tuma/musubi", fork: false, default_branch: "main" };
  const qualityWorkflow = { id: 222, name: "Quality", path: ".github/workflows/quality.yml", state: "active" };
  const workflow = { id: 333, name: "Publish Docker images", path: ".github/workflows/docker-publish.yml", state: "active" };
  const baseRun = { run_number: 12, run_attempt: 1, head_branch: "main", head_sha: sourceSha,
    repository: repo, head_repository: repo, status: "completed", conclusion: "success" };
  const run = { ...baseRun, id: runId, workflow_id: workflow.id, name: workflow.name, path: workflow.path,
    event: "workflow_dispatch", html_url: `https://github.com/f-tuma/musubi/actions/runs/${runId}`,
    created_at: iso("03:00"), run_started_at: iso("03:01"), updated_at: iso("10:00") };
  const qualityRun = { ...baseRun, id: qualityId, workflow_id: qualityWorkflow.id, name: "Quality",
    path: qualityWorkflow.path, event: "push", html_url: `https://github.com/f-tuma/musubi/actions/runs/${qualityId}`,
    created_at: iso("00:00"), run_started_at: iso("00:01"), updated_at: iso("02:00") };
  const nativeSteps = ["Build native APK and AAB with system bar verification", "Verify shipped DEX"]
    .map((name, index) => ({ name, number: index + 7, status: "completed", conclusion: "success",
      startedAt: iso("01:00"), completedAt: iso("01:30") }));
  const proof = { schemaVersion: 1, kind: "trusted-main-quality", repository: { id: repoId, name: repo.full_name },
    sourceSha, workflow: { id: qualityWorkflow.id, name: "Quality", path: qualityWorkflow.path },
    run: { id: qualityId, number: qualityRun.run_number, attempt: 1, url: qualityRun.html_url,
      event: "push", branch: "main", sourceSha, status: "completed", conclusion: "success",
      createdAt: qualityRun.created_at, startedAt: qualityRun.run_started_at, updatedAt: qualityRun.updated_at },
    jobs: QUALITY_JOB_NAMES.map((name, index) => ({ id: 2000 + index, name, runId: qualityId,
      runAttempt: 1, sourceSha, status: "completed", conclusion: "success", startedAt: iso("01:00"),
      completedAt: iso("02:00"), nativeSteps: name === "Android system bars" ? nativeSteps : [] })),
    publication: { runId, runAttempt: 1,
      workflowRef: "f-tuma/musubi/.github/workflows/docker-publish.yml@refs/heads/main",
      workflowSha: sourceSha, event: "workflow_dispatch", ref: "refs/heads/main", version: "0.2.12" } };
  const jobs = { total_count: 9, jobs: PUBLICATION_JOB_NAMES.map((name, index) => ({ id: 1000 + index,
    name, run_id: runId, run_attempt: 1, head_sha: sourceSha, status: "completed", conclusion: "success",
    started_at: name === "release" ? iso("09:00") : iso("03:01"), completed_at: iso("10:00") })) };
  const qualityJobs = { total_count: 21, jobs: proof.jobs.map((job) => ({ id: job.id, name: job.name,
    run_id: job.runId, run_attempt: job.runAttempt, head_sha: job.sourceSha, status: job.status,
    conclusion: job.conclusion, started_at: job.startedAt, completed_at: job.completedAt,
    steps: job.nativeSteps.map((step) => ({ name: step.name, number: step.number, status: step.status,
      conclusion: step.conclusion, started_at: step.startedAt, completed_at: step.completedAt })) })) };
  const recheck = { schemaVersion: 1, kind: "pre-deployment-tag-quality-revalidation",
    sampledAtUtc: iso("09:30"), sourceSha, publicationRunId: String(runId), publicationAttempt: "1",
    qualityRunId: String(qualityId), qualityAttempt: "1", proofSha256: hashQualityProof(proof), validated: true,
    limit: "Read-only final snapshot; cannot atomically lock a later GitHub rerun." };
  const archives = new Map();
  const artifacts = { total_count: 2, artifacts: [] };
  function setEvidence(index, value, filename = index === 0 ? "quality-proof.json" : "quality-recheck.json") {
    const id = 3000 + index;
    const zip = zipEntries([{ name: filename, body: json(value) }]);
    archives.set(id, zip);
    artifacts.artifacts[index] = { id, name: `${index === 0 ? "quality-proof" : "quality-recheck"}-${runId}-1`,
      expired: false, digest: digest(zip), size_in_bytes: zip.length,
      expires_at: "2026-10-23T00:00:00Z", workflow_run: { id: runId, repository_id: repoId,
        head_repository_id: repoId, head_branch: "main", head_sha: sourceSha } };
  }
  setEvidence(0, proof); setEvidence(1, recheck);
  const tag = { ref: "refs/tags/v0.2.12", object: { type: "commit", sha: sourceSha } };
  const release = { id: 444, tag_name: "v0.2.12", draft: false, prerelease: false,
    published_at: iso("10:00"), html_url: "https://github.com/f-tuma/musubi/releases/tag/v0.2.12" };
  const discoveryPath = `actions/workflows/${qualityWorkflow.id}/runs?head_sha=${sourceSha}&event=push&branch=main&per_page=100&page=1`;
  const values = new Map([["", repo], ["actions/workflows/docker-publish.yml", workflow],
    ["actions/workflows/quality.yml", qualityWorkflow], [`actions/runs/${runId}`, run],
    [`actions/runs/${runId}/attempts/1/jobs?per_page=100`, jobs],
    [`actions/runs/${runId}/artifacts?per_page=100&page=1`, artifacts],
    [`actions/runs/${qualityId}`, qualityRun],
    [`actions/runs/${qualityId}/attempts/1/jobs?per_page=100`, qualityJobs],
    [discoveryPath, { total_count: 1, workflow_runs: [qualityRun] }],
    ["git/ref/tags/v0.2.12", tag], ["releases/tags/v0.2.12", release]]);
  const calls = [];
  const options = { sourceSha, runId, version: "0.2.12", now: () => Date.parse(iso("12:00")),
    readJSON: async (path) => { calls.push(path); assert.ok(values.has(path), `Unexpected read: ${path}`); return copy(values.get(path)); },
    downloadArtifact: async (id) => { calls.push(`ZIP:${id}`); assert.ok(archives.has(id)); return archives.get(id); } };
  return { repo, workflow, qualityWorkflow, run, qualityRun, proof, jobs, qualityJobs, artifacts,
    recheck, archives, tag, release, discoveryPath, values, calls, options, setEvidence };
}

test("publication proof authenticates both real ZIPs and separates nine own jobs from21 actual main jobs", async () => {
  const f = fixture();
  const result = await collectPublicationProof(f.options);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.publication.ownJobCount, 9);
  assert.equal(result.linkedQuality.actualMainJobCount, 21);
  assert.equal(result.linkedQuality.proofSha256, hashQualityProof(f.proof));
  assert.equal(result.preTagRevalidation.validated, true);
  assert.equal(result.evidenceArtifacts.length, 2);
  assert.ok(result.evidenceArtifacts.every((item) => item.actualArchiveDownloadedAndHashed));
  assert.equal(result.release.directCommit, sourceSha);
  assert.equal(f.calls.filter((path) => path === `actions/runs/${runId}`).length, 2);
  assert.equal(f.calls.filter((path) => path === f.discoveryPath).length, 2);
  assert.ok(f.calls.every((path) => !/delete|rerun|dispatch/.test(path)));
});

test("invalid source/run/version input fails before any remote read", async () => {
  for (const patch of [{ sourceSha: "0".repeat(40) }, { sourceSha: "short" }, { sourceSha: `${sourceSha}\n` }, { runId: 0 },
    { runId: Number.MAX_SAFE_INTEGER + 1 }, { version: "v0.2.12" }, { version: "0.2.12\n" }]) {
    let calls = 0;
    await assert.rejects(collectPublicationProof({ sourceSha, runId, version: "0.2.12", ...patch,
      readJSON: () => { calls++; return {}; } }));
    assert.equal(calls, 0, "invalid input reached GitHub");
  }
});

test("legacy29, missing/extra/duplicate publication jobs and mixed attempts fail closed", () => {
  const f = fixture();
  for (const mutate of [
    (data) => { data.total_count = 29; }, (data) => { data.jobs.pop(); },
    (data) => { data.jobs.push(copy(data.jobs[0])); },
    (data) => { data.jobs[1].id = data.jobs[0].id; },
    (data) => { data.jobs[1].name = data.jobs[0].name; },
    (data) => { data.jobs[0].run_attempt = 2; },
    (data) => { data.jobs[0].head_sha = "b".repeat(40); },
    (data) => { data.jobs[0].conclusion = "skipped"; },
    (data) => { data.jobs[0].completed_at = iso("00:00"); },
  ]) {
    const data = copy(f.jobs); mutate(data);
    assert.throws(() => validatePublicationJobs(data, { sourceSha, runId, attempt: 1 }));
  }
});

test("wrong publication workflow/event/repository/head/branch/status are rejected", async () => {
  for (const patch of [{ event: "push" }, { path: ".github/workflows/quality.yml" },
    { workflow_id: 1234 }, { head_branch: "codex/untrusted" }, { head_sha: "b".repeat(40) },
    { head_repository: { id: repoId, full_name: "fork/musubi" } },
    { repository: { id: repoId + 1, full_name: "f-tuma/musubi" } },
    { status: "in_progress" }, { conclusion: "skipped" },
    { run_started_at: iso("02:00") }, { updated_at: iso("01:00") }]) {
    const f = fixture(); Object.assign(f.run, patch);
    await assert.rejects(collectPublicationProof(f.options), /Publication run/);
  }
});

test("artifact absence, ambiguity, expiration, wrong run/source/repository and missing digest are rejected", async () => {
  for (const mutate of [
    (f) => { f.artifacts.artifacts.shift(); f.artifacts.total_count = 1; },
    (f) => { f.artifacts.artifacts.push({ ...f.artifacts.artifacts[0], id: 9000 }); f.artifacts.total_count++; },
    (f) => { f.artifacts.artifacts[0].expired = true; },
    (f) => { f.artifacts.artifacts[0].expires_at = "2026-10-21T00:00:00Z"; },
    (f) => { delete f.artifacts.artifacts[0].digest; },
    (f) => { f.artifacts.artifacts[0].workflow_run.id++; },
    (f) => { f.artifacts.artifacts[0].workflow_run.repository_id++; },
    (f) => { f.artifacts.artifacts[0].workflow_run.head_sha = "b".repeat(40); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(collectPublicationProof(f.options), /artifact/i);
  }
});

test("digest metadata alone cannot substitute for the actual downloaded ZIP bytes", async () => {
  const f = fixture();
  f.archives.set(3000, zipEntries([{ name: "quality-proof.json", body: json({ fake: true }) }]));
  await assert.rejects(collectPublicationProof(f.options), /Actual evidence ZIP digest/);
});

test("proof content must be bound to the current consumer/source/attempt/version even with a valid ZIP digest", async () => {
  for (const patch of [{ runId: 8001 }, { runAttempt: 2 }, { version: "0.2.13" },
    { workflowSha: "b".repeat(40) }]) {
    const f = fixture(); Object.assign(f.proof.publication, patch); f.setEvidence(0, f.proof);
    await assert.rejects(collectPublicationProof(f.options), /proof|consumer/i);
  }
});

test("pre-tag receipt requires the exact proof hash, run/attempt, bounded sample and immutable schema", async () => {
  for (const patch of [{ proofSha256: "f".repeat(64) }, { publicationAttempt: "2" },
    { qualityAttempt: "2" }, { qualityRunId: "7001" }, { validated: false },
    { sampledAtUtc: iso("08:00") }, { sampledAtUtc: iso("11:00") }, { extra: true }]) {
    const f = fixture(); Object.assign(f.recheck, patch); f.setEvidence(1, f.recheck);
    await assert.rejects(collectPublicationProof(f.options), /Pre-tag/);
  }
});

test("current linked Quality must still be the same full successful attempt and native evidence", async () => {
  for (const mutate of [
    (f) => { f.qualityRun.run_attempt = 2; }, (f) => { f.qualityRun.conclusion = "failure"; },
    (f) => { f.qualityWorkflow.id++; }, (f) => { f.qualityJobs.total_count = 20; f.qualityJobs.jobs.pop(); },
    (f) => { f.qualityJobs.jobs[0].run_attempt = 2; },
    (f) => { f.qualityJobs.jobs[0].id++; },
    (f) => { f.qualityJobs.jobs.find((job) => job.name === "Android system bars").steps[1].conclusion = "skipped"; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(collectPublicationProof(f.options), /Quality/);
  }
});

test("main Quality must have completed before provenance acceptance and the pre-tag sample", async () => {
  const f = fixture();
  f.proof.run.updatedAt = iso("11:00");
  f.recheck.proofSha256 = hashQualityProof(f.proof);
  f.setEvidence(0, f.proof); f.setEvidence(1, f.recheck);
  await assert.rejects(collectPublicationProof(f.options), /Quality completion/);
});

test("new or ambiguous exact-SHA Quality candidates cannot reuse an older successful proof", async () => {
  const f = fixture();
  f.values.set(f.discoveryPath, { total_count: 2, workflow_runs: [f.qualityRun, { ...f.qualityRun, id: 7001 }] });
  await assert.rejects(collectPublicationProof(f.options), /ambiguous/);
});

test("publication rerun, Quality rerun and evidence replacement during collection are rejected", async () => {
  for (const target of ["publication", "quality", "artifact"]) {
    const f = fixture(); const read = f.options.readJSON; let count = 0;
    f.options.readJSON = async (path) => {
      const value = await read(path);
      const selected = target === "publication" ? `actions/runs/${runId}` : target === "quality"
        ? `actions/runs/${qualityId}` : `actions/runs/${runId}/artifacts?per_page=100&page=1`;
      if (path === selected && ++count === 2) {
        if (target === "artifact") value.artifacts[0].id++;
        else value.run_attempt++;
      }
      return value;
    };
    await assert.rejects(collectPublicationProof(f.options), /changed|Quality|artifact/i);
  }
});

test("only a direct commit tag and final release at the requested version are accepted", async () => {
  for (const mutate of [
    (f) => { f.tag.object.type = "tag"; }, (f) => { f.tag.object.sha = "b".repeat(40); },
    (f) => { f.release.draft = true; }, (f) => { f.release.prerelease = true; },
    (f) => { f.release.tag_name = "v0.2.13"; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(collectPublicationProof(f.options), /tag|release/i);
  }
});

test("incomplete or changing pagination never establishes artifact absence", async () => {
  const f = fixture(); f.artifacts.total_count = 3;
  await assert.rejects(collectPublicationProof(f.options), /pagination/);
});

test("transport failures do not expose raw command diagnostics or credentials", async () => {
  const f = fixture();
  const hidden = "secret-fixture-token-and-authenticated-url";
  for (const options of [
    { ...f.options, readJSON: () => { throw new Error(hidden); } },
    { ...f.options, downloadArtifact: () => { throw new Error(hidden); } },
  ]) {
    await assert.rejects(collectPublicationProof(options), (error) =>
      /Read-only/.test(error.message) && !error.message.includes(hidden));
  }
});

test("safe ZIP reader rejects paths, extra files, symlinks, malformed/duplicate JSON and oversized members", () => {
  const cases = [
    [{ name: "../quality-proof.json", body: "{}\n" }],
    [{ name: "quality-proof.json", body: "{}\n" }, { name: "extra", body: "extra" }],
    [{ name: "quality-proof.json", body: "{}\n", mode: 0o120777 }],
    [{ name: "quality-proof.json", body: "not JSON" }],
    [{ name: "quality-proof.json", body: '{"a":1,"a":2}' }],
    [{ name: "quality-proof.json", body: " ".repeat(1024 * 1024 + 1) }],
  ];
  for (const entries of cases) assert.throws(() => readArtifactJson(zipEntries(entries), "quality-proof.json"));
  assert.throws(() => readArtifactJson(Buffer.from("bad ZIP"), "quality-proof.json"));
  assert.throws(() => readArtifactJson(zipEntries([{ name: "quality-proof.json", body: "{}\n" }]), "untrusted.py"));
});

test("CLI rejects malformed inputs without exposing raw command diagnostics or attempting publication", () => {
  const script = fileURLToPath(new URL("./verify-publication.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--source", "bad", "--run-id", "8000",
    "--version", "0.2.12", "--output", "/dev/null"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Publication verification failed/);
  assert.doesNotMatch(result.stderr, /Bearer|GH_TOKEN|https:|stderr|Error:/);
});
