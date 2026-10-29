import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectQualityProof, hashQualityProof, QUALITY_JOB_NAMES, recheckQualityProof, runQualityProof, validateQualityProof } from "./quality-proof.mjs";

const source = "a".repeat(40);
const repo = { id: 1227188125, full_name: "f-tuma/musubi", fork: false, default_branch: "main" };
const workflow = { id: 318873480, name: "Quality", path: ".github/workflows/quality.yml", state: "active" };
const time = "2026-10-22T10:00:00Z";
const completed = "2026-10-22T10:10:00Z";
const env = {
  GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: String(repo.id), GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.github.com", GITHUB_SHA: source, EXPECTED_SOURCE_SHA: source,
  GITHUB_WORKFLOW_SHA: source, GITHUB_WORKFLOW_REF: `${repo.full_name}/.github/workflows/docker-publish.yml@refs/heads/main`,
  GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "40000000001",
  GITHUB_RUN_ATTEMPT: "1", GH_TOKEN: "fixture-private-token", RELEASE_VERSION: "0.2.12",
};
const nativeNames = ["Build native APK and AAB with system bar verification", "Verify shipped DEX"];
const response = (data, options) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" }, ...options });
const clone = (value) => structuredClone(value);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "musubi-quality-proof-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const run = { id: 39587300635, run_number: 123, run_attempt: 1, workflow_id: workflow.id,
    name: "Quality", path: workflow.path, event: "push", head_branch: "main", head_sha: source,
    repository: clone(repo), head_repository: clone(repo), status: "completed", conclusion: "success",
    html_url: `https://github.com/${repo.full_name}/actions/runs/39587300635`,
    created_at: time, run_started_at: time, updated_at: completed };
  const jobs = QUALITY_JOB_NAMES.map((name, index) => ({ id: 1000 + index, name, run_id: run.id, run_attempt: run.run_attempt,
    head_sha: source, status: "completed", conclusion: "success", started_at: time, completed_at: completed,
    steps: name === "Android system bars" ? nativeNames.map((step, n) => ({ name: step, number: 7 + n,
      status: "completed", conclusion: "success", started_at: time, completed_at: completed })) : [] }));
  const data = { repository: clone(repo), main: { ref: "refs/heads/main", object: { type: "commit", sha: "b".repeat(40) } },
    workflow: clone(workflow), run, listing: { total_count: 1, workflow_runs: [run] }, jobs: { total_count: 21, jobs } };
  const calls = [];
  const readCounts = {};
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-private-token");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.startsWith(`https://api.github.com/repos/${repo.full_name}`));
    const path = url.slice(`https://api.github.com/repos/${repo.full_name}`.length);
    calls.push(path);
    const key = path === "" ? "repository" : path === "/git/ref/heads/main" ? "main" :
      path === "/actions/workflows/quality.yml" ? "workflow" :
      path.startsWith(`/actions/workflows/${workflow.id}/runs?`) ? "listing" :
      path === `/actions/runs/${run.id}` ? "run" :
      path === `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=1` ? "jobs" : undefined;
    assert.ok(key, `unexpected readonly fixture endpoint ${path}`);
    readCounts[key] = (readCounts[key] ?? 0) + 1;
    return f.respond ? f.respond(key, readCounts[key], data[key], { url, options }) : response(data[key]);
  };
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args);
    assert.deepEqual(args, ["rev-parse", "--verify", "HEAD^{commit}"]);
    return { status: 0, stdout: `${source}\n` };
  };
  const f = { directory, data, calls, gitCalls, readCounts, fetchImpl, git,
    env: { ...env, QUALITY_PROOF_PATH: join(directory, "quality-proof.json") },
    collect: (options = {}) => collectQualityProof({ env: f.env, cwd: directory, fetchImpl: f.fetchImpl, git: f.git, ...options }),
    record: (options = {}) => runQualityProof({ mode: "record", env: f.env, cwd: directory, fetchImpl: f.fetchImpl, git: f.git, ...options }),
    recheck: (options = {}) => recheckQualityProof({ env: f.env, cwd: directory, fetchImpl: f.fetchImpl, git: f.git, ...options }),
  };
  return f;
}

test("exact main proof contains 21 actual jobs, native build/DEX steps and bound publication context", async (t) => {
  const f = fixture(t);
  const proof = await f.collect();
  assert.equal(validateQualityProof(proof), proof);
  assert.equal(proof.jobs.length, 21);
  assert.deepEqual(proof.jobs.map((j) => j.name), QUALITY_JOB_NAMES);
  assert.deepEqual(proof.jobs.find((j) => j.name === "Android system bars").nativeSteps.map((s) => s.name), nativeNames);
  assert.equal(proof.publication.runId, Number(env.GITHUB_RUN_ID));
  assert.equal(proof.publication.version, env.RELEASE_VERSION);
  assert.equal(proof.sourceSha, source);
  assert.equal(f.readCounts.run, 2);
  assert.equal(f.readCounts.listing, 2);
  assert.equal(f.readCounts.workflow, 2);
  assert.ok(f.calls.some((path) => path.includes(`/attempts/1/jobs?per_page=100&page=1`)));
  assert.equal(f.gitCalls.length, 1);
  assert.ok(!JSON.stringify(proof).includes("fixture-private-token"));
  assert.ok(!JSON.stringify(proof).includes("actor"));
});

test("main advancement does not retarget the exact frozen candidate", async (t) => {
  const f = fixture(t);
  f.data.main.object.sha = "c".repeat(40);
  const proof = await f.collect();
  assert.equal(proof.sourceSha, source);
  assert.ok(f.calls.every((path) => !path.includes("c".repeat(40))));
});

test("full rerun attempt can qualify, but all 21 jobs must belong to that current attempt", async (t) => {
  const f = fixture(t);
  f.data.run.run_attempt = 2;
  for (const job of f.data.jobs.jobs) job.run_attempt = 2;
  assert.equal((await f.collect()).run.attempt, 2);
  f.data.jobs.jobs[0].run_attempt = 1;
  await assert.rejects(f.collect(), /wrong-attempt/);
});

test("partial rerun does not reuse successful jobs from an earlier attempt", async (t) => {
  const f = fixture(t);
  f.data.run.run_attempt = 2;
  f.data.jobs.jobs = [{ ...f.data.jobs.jobs[0], run_attempt: 2 }];
  f.data.jobs.total_count = 1;
  await assert.rejects(f.collect(), /21 current-attempt/);
});

test("invalid publication context or captured source fails before any network access", async (t) => {
  const f = fixture(t);
  const cases = {
    GITHUB_REPOSITORY: "foreign/musubi", GITHUB_REPOSITORY_ID: "0", GITHUB_SERVER_URL: "https://github.example.test",
    GITHUB_API_URL: "https://api.example.test", GITHUB_SHA: "short", EXPECTED_SOURCE_SHA: "b".repeat(40),
    GITHUB_WORKFLOW_SHA: "b".repeat(40), GITHUB_WORKFLOW_REF: `${repo.full_name}/.github/workflows/quality.yml@refs/heads/main`,
    GITHUB_REF: "refs/heads/feature", GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ID: "1\n", GITHUB_RUN_ATTEMPT: "1.5",
    GH_TOKEN: "fixture private token", RELEASE_VERSION: "v0.2.12",
  };
  for (const [key, value] of Object.entries(cases)) {
    await assert.rejects(f.collect({ env: { ...f.env, [key]: value }, fetchImpl: () => assert.fail("invalid context reached network") }));
  }
  await assert.rejects(f.collect({ git: () => ({ status: 0, stdout: "b".repeat(40) }) }), /checkout HEAD/);
  assert.equal(f.calls.length, 0);
});

test("authenticated repository identity and main reference must be established", async (t) => {
  for (const change of [
    (d) => { d.repository.id++; }, (d) => { d.repository.full_name = "foreign/musubi"; },
    (d) => { d.repository.fork = true; }, (d) => { d.repository.default_branch = "trunk"; },
    (d) => { d.main.object.type = "tag"; }, (d) => { d.main.object.sha = "0".repeat(40); },
    (d) => { d.main.ref = "refs/heads/other"; },
  ]) {
    const f = fixture(t); change(f.data); await assert.rejects(f.collect());
  }
});

test("Quality metadata must identify the active expected workflow and path", async (t) => {
  for (const patch of [{ id: 0 }, { name: "Other" }, { path: ".github/workflows/other.yml" }, { state: "disabled_manually" }]) {
    const f = fixture(t); Object.assign(f.data.workflow, patch); await assert.rejects(f.collect(), /workflow/);
  }
});

test("fork, PR, foreign workflow, wrong source or unsuccessful run cannot qualify", async (t) => {
  const patches = [{ repository: { ...repo, id: repo.id + 1 } }, { head_repository: { ...repo, id: repo.id + 1 } },
    { head_repository: { ...repo, full_name: "foreign/musubi" } }, { event: "pull_request" }, { event: "workflow_dispatch" },
    { head_branch: "feature" }, { head_sha: "b".repeat(40) }, { workflow_id: workflow.id + 1 }, { path: "other.yml" },
    { name: "Other" }, { status: "in_progress" }, { conclusion: "failure" }, { conclusion: "skipped" },
    { run_attempt: 0 }, { html_url: "https://example.test/private" }, { run_number: 0 }, { created_at: "invalid" }];
  for (const patch of patches) {
    const f = fixture(t); Object.assign(f.data.run, patch); await assert.rejects(f.collect());
  }
});

test("missing or ambiguous current source run fails without adopting an older green run", async (t) => {
  for (const listing of [{ total_count: 0, workflow_runs: [] }, { total_count: 2, workflow_runs: [{}, {}] },
    { total_count: 1, workflow_runs: [] }, { total_count: 2, workflow_runs: [{}] }]) {
    const f = fixture(t); f.data.listing = listing; await assert.rejects(f.collect(), /unambiguous/);
  }
});

test("rerun between discovery and run read blocks before job enumeration", async (t) => {
  const f = fixture(t);
  f.respond = (key, _n, data) => response(key === "run" ? { ...data, run_attempt: 2 } : data);
  await assert.rejects(f.collect(), /changed before/);
  assert.equal(f.readCounts.jobs, undefined);
});

test("rerun during enumeration, new run selection or workflow replacement blocks the snapshot", async (t) => {
  for (const mutate of [
    (key, n, d) => key === "run" && n === 2 ? { ...d, run_attempt: 2 } : d,
    (key, n, d) => key === "listing" && n === 2 ? { total_count: 2, workflow_runs: [d.workflow_runs[0], d.workflow_runs[0]] } : d,
    (key, n, d) => key === "workflow" && n === 2 ? { ...d, id: d.id + 1 } : d,
    (key, n, d) => key === "run" && n === 2 ? { ...d, updated_at: "2026-10-22T10:11:00Z" } : d,
  ]) {
    const f = fixture(t); f.respond = (key, n, d) => response(mutate(key, n, d)); await assert.rejects(f.collect());
  }
});

test("21 unique names and IDs are required, with exact current source and successful job status", async (t) => {
  const changes = [
    (d) => { d.jobs.jobs.pop(); d.jobs.total_count--; }, (d) => { d.jobs.jobs.push(d.jobs.jobs[0]); d.jobs.total_count++; },
    (d) => { d.jobs.jobs[0].name = "Unexpected"; }, (d) => { d.jobs.jobs[0].name = d.jobs.jobs[1].name; },
    (d) => { d.jobs.jobs[0].id = d.jobs.jobs[1].id; }, (d) => { d.jobs.jobs[0].id = 0; },
    (d) => { d.jobs.jobs[0].head_sha = "b".repeat(40); }, (d) => { d.jobs.jobs[0].run_id++; },
    (d) => { d.jobs.jobs[0].run_attempt++; }, (d) => { d.jobs.jobs[0].conclusion = "skipped"; },
    (d) => { d.jobs.jobs[0].status = "queued"; }, (d) => { d.jobs.jobs[0].completed_at = "bad"; },
    (d) => { d.jobs.jobs[0].completed_at = "2026-10-21T10:00:00Z"; },
  ];
  for (const change of changes) { const f = fixture(t); change(f.data); await assert.rejects(f.collect()); }
});

test("successful job summary cannot substitute for actual successful native build and DEX steps", async (t) => {
  for (const change of [
    (j) => { delete j.steps; }, (j) => { j.steps.pop(); }, (j) => { j.steps.push(j.steps[0]); },
    (j) => { j.steps[0].conclusion = "skipped"; }, (j) => { j.steps[1].conclusion = "failure"; },
    (j) => { j.steps[1].status = "queued"; }, (j) => { j.steps[1].number = j.steps[0].number; },
  ]) {
    const f = fixture(t); change(f.data.jobs.jobs.find((j) => j.name === "Android system bars")); await assert.rejects(f.collect());
  }
});

test("transport, HTTP, redirects, malformed JSON and paginated replies fail closed without leaking bodies", async (t) => {
  for (const fetchImpl of [
    () => { throw new Error("fixture-private-token secret URL"); },
    () => response({ secret: "fixture-private-token" }, { status: 403 }),
    () => new Response("fixture-private-token", { headers: { "content-type": "text/html" } }),
    () => new Response("fixture-private-token", { headers: { "content-type": "application/json" } }),
    () => response({}, { headers: { "content-type": "application/json", link: '<https://example.test/private>; rel="next"' } }),
    () => response({}, { headers: { "content-type": "application/json", "content-length": "99999999" } }),
    () => ({ status: 200, redirected: true, headers: new Headers({ "content-type": "application/json" }) }),
  ]) {
    const f = fixture(t);
    await assert.rejects(f.collect({ fetchImpl }), (error) => error.message.startsWith("Quality proof:") && !/fixture-private-token|secret URL|example\.test/.test(error.message));
  }
});

test("read diagnostics identify the actual failing endpoint without retrying or exposing its URL", async (t) => {
  for (const [key, endpoint] of [
    ["repository", "repository"], ["main", "main"], ["workflow", "quality-workflow"],
    ["listing", "quality-run-list"], ["run", "quality-run"], ["jobs", "quality-jobs"],
  ]) {
    const f = fixture(t);
    f.respond = (readKey, _n, data) => readKey === key
      ? response({ private: "fixture-private-token https://private.invalid/body" }, { status: 403 })
      : response(data);
    await assert.rejects(f.collect(), (error) => {
      assert.equal(error.message, "Quality proof: GitHub read failed, was incomplete, or returned malformed data " +
        `(endpoint=${endpoint}, stage=http-status, status=403)`);
      assert.doesNotMatch(error.stack, /fixture-private-token|private\.invalid|Bearer|https?:\/\//);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.readCounts[key], 1, "failed reads are not retried");
    assert.equal(f.calls.length, ["repository", "main", "workflow", "listing", "run", "jobs"].indexOf(key) + 1);
  }
});

test("later job-read failures expose only static stage and safe numeric status", async (t) => {
  const secret = "fixture-private-token https://private.invalid/secret-body";
  const headers = { "content-type": "application/json" };
  const cases = [
    { stage: "transport", status: "unknown", respond: () => { throw new Error(secret); } },
    { stage: "http-status", status: 403, respond: () => response({ private: secret }, { status: 403 }) },
    { stage: "http-status", status: 403, respond: () => {
      let reads = 0;
      return { get status() { return ++reads === 4 ? secret : 403; } };
    } },
    { stage: "http-status", status: "unknown", respond: () => ({ status: secret }) },
    { stage: "redirect", status: 200, respond: () => ({ status: 200, redirected: true, headers: new Headers(headers) }) },
    { stage: "content-type", status: 200, respond: () => new Response(secret, { headers: { "content-type": "text/html" } }) },
    { stage: "pagination", status: 200, respond: () => response({ private: secret }, { headers: { ...headers, link: '<https://private.invalid/next>; rel="next"' } }) },
    { stage: "declared-size", status: 200, respond: () => response({ private: secret }, { headers: { ...headers, "content-length": "2097153" } }) },
    { stage: "body-read", status: 200, respond: () => ({ status: 200, redirected: false, headers: new Headers(headers), text: async () => { throw new Error(secret); } }) },
    { stage: "body-size", status: 200, respond: () => new Response(secret + " ".repeat(2 * 1024 * 1024), { headers }) },
    { stage: "json", status: 200, respond: () => new Response(secret, { headers }) },
  ];
  for (const { stage, status, respond } of cases) {
    const f = fixture(t);
    f.respond = (key, _n, data) => key === "jobs" ? respond() : response(data);
    await assert.rejects(f.collect(), (error) => {
      assert.equal(error.message, "Quality proof: GitHub read failed, was incomplete, or returned malformed data " +
        `(endpoint=quality-jobs, stage=${stage}, status=${status})`);
      assert.doesNotMatch(error.stack, /fixture-private-token|private\.invalid|Bearer|https?:\/\//);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.readCounts.jobs, 1);
    assert.equal(f.readCounts.run, 1, "failed snapshot never reaches the final run recheck");
    assert.equal(f.calls.length, 6);
  }
});

test("proof serialization and externally pinned hash preserve all sanitized fields", async (t) => {
  const f = fixture(t); const proof = await f.collect();
  const bytes = `${JSON.stringify(proof, null, 2)}\n`;
  assert.equal(hashQualityProof(proof), createHash("sha256").update(bytes).digest("hex"));
  const invalid = clone(proof); invalid.token = "fixture-private-token";
  assert.throws(() => validateQualityProof(invalid), /schema/);
  const foreign = clone(proof); foreign.publication.workflowSha = "b".repeat(40);
  assert.throws(() => validateQualityProof(foreign), /binding/);
  assert.throws(() => validateQualityProof(proof, { sourceSha: "b".repeat(40) }), /source/);
});

test("record exclusively creates a receipt and emits only safe pinned run/hash outputs", async (t) => {
  const f = fixture(t);
  f.env.GITHUB_OUTPUT = join(f.directory, "outputs");
  f.env.GITHUB_STEP_SUMMARY = join(f.directory, "summary");
  const proof = await f.record();
  assert.equal(readFileSync(f.env.QUALITY_PROOF_PATH, "utf8"), `${JSON.stringify(proof, null, 2)}\n`);
  assert.equal(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), `run_id=${proof.run.id}\nrun_attempt=1\nproof_sha256=${hashQualityProof(proof)}\n`);
  assert.ok(!readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8").includes("fixture-private-token"));
  await assert.rejects(f.record(), /exclusively/);
  assert.equal(readFileSync(f.env.GITHUB_OUTPUT, "utf8").split("run_id=").length, 2);
});

test("unchanged downloaded receipt is revalidated against current GitHub and its bound publication", async (t) => {
  const f = fixture(t); const proof = await f.record();
  Object.assign(f.env, { QUALITY_PROOF_SHA256: hashQualityProof(proof), QUALITY_RUN_ID: String(proof.run.id), QUALITY_RUN_ATTEMPT: "1" });
  assert.deepEqual(await f.recheck(), proof);
  f.env.GITHUB_RUN_ATTEMPT = "2";
  await assert.rejects(f.recheck(), /another publication/);
});

test("missing, wrong hash, wrong run/attempt or modified receipt blocks before refreshed GitHub reads", async (t) => {
  const f = fixture(t); const proof = await f.record();
  Object.assign(f.env, { QUALITY_PROOF_SHA256: hashQualityProof(proof), QUALITY_RUN_ID: String(proof.run.id), QUALITY_RUN_ATTEMPT: "1" });
  for (const patch of [{ QUALITY_PROOF_SHA256: "b".repeat(64) }, { QUALITY_PROOF_SHA256: undefined },
    { QUALITY_RUN_ID: "123" }, { QUALITY_RUN_ATTEMPT: "2" }, { QUALITY_PROOF_PATH: join(f.directory, "missing") }]) {
    await assert.rejects(f.recheck({ env: { ...f.env, ...patch }, fetchImpl: () => assert.fail("untrusted proof reached refresh") }));
  }
  writeFileSync(f.env.QUALITY_PROOF_PATH, `${readFileSync(f.env.QUALITY_PROOF_PATH, "utf8")} `);
  await assert.rejects(f.recheck(), /SHA256 mismatch/);
});

test("later successful rerun cannot replace the original pinned attempt", async (t) => {
  const f = fixture(t); const proof = await f.record();
  Object.assign(f.env, { QUALITY_PROOF_SHA256: hashQualityProof(proof), QUALITY_RUN_ID: String(proof.run.id), QUALITY_RUN_ATTEMPT: "1" });
  f.data.run.run_attempt = 2;
  for (const job of f.data.jobs.jobs) job.run_attempt = 2;
  await assert.rejects(f.recheck(), /changed since preparation/);
});

test("current job evidence changing after preparation fails even when statuses remain green", async (t) => {
  const f = fixture(t); const proof = await f.record();
  Object.assign(f.env, { QUALITY_PROOF_SHA256: hashQualityProof(proof), QUALITY_RUN_ID: String(proof.run.id), QUALITY_RUN_ATTEMPT: "1" });
  f.data.jobs.jobs[0].id += 2000;
  await assert.rejects(f.recheck(), /evidence changed/);
});

test("the actual Quality workflow still expands to the guarded 21-job inventory", () => {
  const sourceText = readFileSync(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8");
  const jobsText = sourceText.slice(sourceText.indexOf("\njobs:\n") + 7);
  const blocks = jobsText.split(/(?=^  [a-z][a-z0-9-]+:\n)/m).filter((b) => /^  [a-z]/.test(b));
  const names = [];
  for (const block of blocks) {
    const name = block.match(/^    name: (.+)$/m)?.[1];
    assert.ok(name, "every Quality job must keep an explicit guarded name");
    if (name.includes("matrix.shard")) {
      assert.match(block, /shard: \[1, 2, 3, 4\]/);
      for (const shard of [1, 2, 3, 4]) names.push(name.replace("${{ matrix.shard }}", String(shard)));
    } else if (name.includes("matrix.name")) {
      for (const match of block.matchAll(/^          - name: (.+)$/gm)) names.push(name.replace("${{ matrix.name }}", match[1]));
    } else names.push(name);
  }
  assert.deepEqual(names.sort(), QUALITY_JOB_NAMES);
  for (const name of nativeNames) assert.ok(sourceText.includes(`- name: ${name}\n`));
});
