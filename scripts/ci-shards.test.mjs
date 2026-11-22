import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FALLBACK_MS, assertSelection, databaseTests, loadTimingFile, parseShard, partition, reservedWeights, timingCoverage, webTests,
} from "./ci-shards.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const ids = items => items.map(item => item.id);

test("partitions every test exactly once, including new tests without timings", () => {
  const items = Array.from({ length: 47 }, (_, i) => ({ id: `case-${i}` }));
  const timings = { "case-0": 50, "case-1": 40, "case-2": 30, "case-3": 20 };
  for (const count of [1, 2, 4, 7]) {
    const shards = partition(items, count, timings, 5);
    const actual = shards.flatMap(shard => shard.items.map(item => item.id));
    assert.equal(new Set(actual).size, items.length);
    assert.deepEqual(actual.sort(), items.map(item => item.id).sort());
    assert.deepEqual(partition(items, count, timings, 5), shards);
  }
});

test("spreads expensive tests and preserves source order inside each shard", () => {
  const items = ["a", "b", "c", "d", "e", "f"].map(id => ({ id }));
  const shards = partition(items, 2, { a: 12, b: 12, c: 2, d: 2, e: 1, f: 1 });
  assert.deepEqual(shards.map(shard => shard.duration), [15, 15]);
  for (const shard of shards) {
    const positions = shard.items.map(item => items.indexOf(item));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  }
});

test("rejects malformed shards, duplicate tests, and invalid weights", () => {
  assert.deepEqual(parseShard("2/4"), { current: 2, total: 4 });
  for (const value of ["0/4", "5/4", "1/0", "2", "1.5/4", "1/NaN"]) {
    assert.throws(() => parseShard(value));
  }
  assert.throws(() => partition([{ id: "a" }, { id: "a" }], 2), /Duplicate/);
  assert.throws(() => partition([{ id: "a" }], 2));
  assert.throws(() => partition([{ id: "a" }], 1, { a: -1 }));
});

test("R1: a reserved load counts as initial shard work before suites are placed", () => {
  const items = ["a", "b", "c", "d", "e", "f"].map(id => ({ id }));
  const shards = partition(items, 2, { a: 12, b: 12, c: 2, d: 2, e: 1, f: 1 }, 1, [20, 0]);
  assert.deepEqual(shards.map(shard => ids(shard.items).join("")), ["cde", "abf"]);
  assert.deepEqual(shards.map(shard => shard.duration), [25, 25]);
  assert.deepEqual(shards.map(shard => shard.reservedMs), [20, 0]);
});

test("R2: invalid reserved weights are rejected before any assignment", () => {
  const items = ["a", "b", "c"].map(id => ({ id }));
  for (const reservedMs of [[-1], [NaN], [Infinity], [1.5], ["5"], [0, 0, 0], [, 1], 5, null, { 0: 1 }]) {
    assert.throws(() => partition(items, 2, {}, 1, reservedMs), /reserved weight/i, `accepted ${JSON.stringify(reservedMs)}`);
  }
});

test("R3: a reservation may not leave a shard without suites", () => {
  const items = ["a", "b", "c"].map(id => ({ id }));
  assert.throws(() => partition(items, 2, {}, 1, [1e6]), /shard 1 without suites/);
  assert.throws(() => partition(items, 2, {}, 1, [0, 1e6]), /shard 2 without suites/);
});

test("R4: placement stays deterministic with lowest-index ties", () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}` }));
  const plain = partition(items, 3, {}, 7);
  assert.deepEqual(plain.map(shard => ids(shard.items)), [["t0", "t3"], ["t1", "t4"], ["t2", "t5"]]);
  assert.deepEqual(partition(items, 3, {}, 7), plain);
  assert.deepEqual(partition(items, 3, {}, 7, [0, 0, 0]).map(shard => shard.items), plain.map(shard => shard.items));
});

test("R5: recorded reservations apply only to their own shard total and must be well formed", () => {
  const reservations = { total: 4, reservedMs: [500, 0, 0, 0], basis: "fixture" };
  assert.deepEqual(reservedWeights({ durationsMs: {} }, 4), []);
  assert.deepEqual(reservedWeights({ durationsMs: {}, reservations }, 4), [500, 0, 0, 0]);
  for (const total of [1, 3]) assert.deepEqual(reservedWeights({ durationsMs: {}, reservations }, total), []);
  for (const malformed of [
    null, [], "500", { total: 4, reservedMs: [500, 0, 0, 0] }, { ...reservations, extra: true },
    { ...reservations, total: 4.5 }, { ...reservations, total: 0, reservedMs: [] }, { ...reservations, reservedMs: [500, 0, 0] },
    { ...reservations, reservedMs: [-1, 0, 0, 0] }, { ...reservations, reservedMs: [1.5, 0, 0, 0] },
    { ...reservations, reservedMs: ["500", 0, 0, 0] }, { ...reservations, reservedMs: "500" }, { ...reservations, basis: "" },
    { total: 3, reservedMs: [1, 0, 0, 0], basis: "length differs from total" },
  ]) {
    for (const total of [1, 4]) {
      assert.throws(() => reservedWeights({ durationsMs: {}, reservations: malformed }, total), /reservations/i,
        `accepted ${JSON.stringify(malformed)} for ${total}`);
    }
  }
});

test("R6: any timing coverage is reported and selects every suite; only invalid timing files are fatal", () => {
  const inventory = databaseTests();
  const half = Object.fromEntries(inventory.filter((_, index) => index % 2).map(item => [item.id, 10000]));
  const scenarios = {
    // Uniform 20 s keeps total work well above four times the 600 s reservation;
    // R3 covers the separate case where a reservation would empty a shard.
    full: { measured: inventory.length, obsolete: 0, durationsMs: Object.fromEntries(inventory.map(item => [item.id, 20000])) },
    partial: { measured: Object.keys(half).length, obsolete: 1, durationsMs: { ...half, "removed/suite.test.ts": 4000 } },
    zero: { measured: 0, obsolete: 0, durationsMs: {} },
    renamed: { measured: 0, obsolete: inventory.length,
      durationsMs: Object.fromEntries(inventory.map(item => [`renamed/${item.id}`, 10000])) },
  };
  const directory = mkdtempSync(join(tmpdir(), "musubi-ci-timing-file-"));
  try {
    for (const [name, scenario] of Object.entries(scenarios)) {
      const path = join(directory, `${name}.json`);
      // No reservations: tolerated by the planner, which then reports it.
      writeFileSync(path, JSON.stringify({ schemaVersion: 2, durationsMs: scenario.durationsMs }));
      const file = loadTimingFile(path);
      assert.deepEqual(reservedWeights(file, 4), [], name);
      const coverage = timingCoverage(inventory, file.durationsMs);
      assert.deepEqual(coverage, {
        inventory: inventory.length, measured: scenario.measured, obsolete: scenario.obsolete,
        fallbackIds: ids(inventory.filter(item => !(item.id in scenario.durationsMs))),
      }, name);
      for (const reservedMs of [[], [600000, 0, 0, 0]]) {
        const shards = partition(inventory, 4, file.durationsMs, FALLBACK_MS.db, reservedMs);
        assert.deepEqual(shards.flatMap(shard => ids(shard.items)).sort(), ids(inventory).sort(), name);
        assert.ok(shards.every(shard => shard.items.length > 0), name);
      }
    }
    const fatal = {
      "not JSON": "{", "an array": "[]", "null": "null", "a string": "\"x\"",
      "no duration map": "{}", "an array duration map": JSON.stringify({ durationsMs: [] }),
      "zero": JSON.stringify({ durationsMs: { "obsolete/suite": 0 } }), "negative": JSON.stringify({ durationsMs: { a: -1 } }),
      "a string duration": JSON.stringify({ durationsMs: { a: "NaN" } }), "an infinite duration": "{\"durationsMs\":{\"a\":1e999}}",
      "malformed reservations": JSON.stringify({ durationsMs: { a: 1 }, reservations: { total: 4, reservedMs: [1], basis: "x" } }),
      "null reservations": JSON.stringify({ durationsMs: { a: 1 }, reservations: null }),
    };
    for (const [name, text] of Object.entries(fatal)) {
      const path = join(directory, "fatal.json");
      writeFileSync(path, text);
      assert.throws(() => loadTimingFile(path), /timing file|Invalid timing|reservations/i, name);
    }
    assert.throws(() => loadTimingFile(join(directory, "missing.json")), /Unreadable timing file/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expands nested root and workspace scripts without omitting a suite", () => {
  const manifests = {
    "": { scripts: {
      "test:db": "pnpm test:db:one && pnpm --filter @musubi/api run test:extra && pnpm --filter @musubi/sync-reference run test:db",
      "test:db:one": "pnpm --filter @musubi/api exec tsx src/one.test.ts && pnpm --filter @musubi/db exec tsx src/two.test.ts",
    } },
    "apps/api": { scripts: { "test:extra": "tsx src/three.test.ts" } },
    "apps/sync-reference": { scripts: { "test:db": "tsx src/store.integration.test.ts && tsx src/process.integration.test.ts" } },
  };
  assert.deepEqual(databaseTests(directory => manifests[directory]).map(item => item.id), [
    "apps/api/src/one.test.ts", "packages/db/src/two.test.ts", "apps/api/src/three.test.ts",
    "apps/sync-reference/src/store.integration.test.ts", "apps/sync-reference/src/process.integration.test.ts",
  ]);
  for (const command of ["echo ignored", "pnpm test:missing", "pnpm test:db"]) {
    assert.throws(() => databaseTests(() => ({ scripts: { "test:db": command } })));
  }
});

test("the real database inventory has no duplicates or empty shards", () => {
  const inventory = databaseTests();
  assert.ok(inventory.length > 60);
  for (const id of ["apps/sync-reference/src/store.integration.test.ts", "apps/sync-reference/src/process.integration.test.ts", "packages/db/src/queries/operation-admission-missing.integration.test.ts",
    "apps/sync-reference/src/task-update.integration.test.ts", "apps/sync-reference/src/task-update-process.integration.test.ts",
    "apps/api/src/sync/google_shared_task_update_delivery.integration.test.ts", "apps/api/src/sync/google_shared_task_delete_delivery.integration.test.ts",
    "apps/sync-reference/src/task-delete.integration.test.ts", "apps/sync-reference/src/task-delete-process.integration.test.ts",
    "apps/api/src/sync/google_shared_task_create_delivery.integration.test.ts", "apps/sync-reference/src/task-create.integration.test.ts", "apps/sync-reference/src/task-create-process.integration.test.ts",
    "apps/api/src/sync/google_task_causal_delivery.integration.test.ts", "apps/api/src/sync/task_compatibility_delivery.integration.test.ts", "apps/api/src/sync/event_compatibility_delivery.integration.test.ts", "apps/api/src/sync/google_rsvp_barrier.integration.test.ts", "packages/db/src/queries/task-causal.integration.test.ts",
    "apps/sync-reference/src/task-intent.integration.test.ts", "apps/sync-reference/src/task-intent-process.integration.test.ts"]) {
    assert.equal(inventory.filter(item => item.id === id).length, 1);
  }
  const shards = partition(inventory, 4);
  assert.equal(shards.flatMap(shard => shard.items).length, inventory.length);
});

test("web inventory preserves generated cases, nested groups and browser projects", () => {
  const spec = title => ({ title, file: "example.spec.ts", line: 10, tests: [{ projectName: "chromium" }, { projectName: "firefox" }] });
  const report = { suites: [{ title: "example.spec.ts", line: 0, suites: [
    { title: "outer", line: 3, suites: [{ title: "inner", line: 4, specs: [spec("first case"), spec("second case")] }] },
  ] }] };
  const inventory = webTests(report);
  assert.equal(inventory.length, 4);
  assert.equal(new Set(inventory.map(item => item.id)).size, 4);
  assert.equal(inventory[0].id, "[chromium] › example.spec.ts › outer › inner › first case");
  assert.throws(() => webTests({ errors: [{ message: "syntax error" }], suites: [] }), /collection failed/);
});

test("a missing, duplicate or extra Playwright match cannot produce a green shard", () => {
  const planned = [{ id: "a" }, { id: "b" }];
  assertSelection(planned, [{ id: "b" }, { id: "a" }]);
  for (const actual of [[], [{ id: "a" }], [{ id: "a" }, { id: "a" }], [...planned, { id: "c" }]]) {
    assert.throws(() => assertSelection(planned, actual), /selected/);
  }
});

test("measured database weights preserve every current and new suite in source order", async () => {
  const { readFileSync } = await import("node:fs");
  const timings = JSON.parse(readFileSync(new URL("./ci-db-timings.json", import.meta.url), "utf8")).durationsMs;
  const existing = databaseTests();
  const inventory = [...existing, { id: "new-unmeasured-suite" }];
  const shards = partition(inventory, 4, { ...timings, "obsolete-removed-suite": 1e9 }, 15000);
  assert.deepEqual(shards.flatMap(shard => shard.items.map(item => item.id)).sort(), inventory.map(item => item.id).sort());
  assert.equal(shards.reduce((sum, shard) => sum + shard.duration, 0),
    inventory.reduce((sum, item) => sum + (timings[item.id] ?? 15000), 0));
  for (const shard of shards) {
    const positions = shard.items.map(item => inventory.indexOf(item));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  }
});

// Importer tests stay in this existing CI test entry point: every one of the
// four database/web jobs continues to run the provenance and coverage checks.
const { RESERVATION_JOB, RESERVATION_STEP, importTimings, median, medianTimings, successfulTimings } = await import("./ci-timings.mjs");

// The jobs API response for one run attempt, bound to its run.
function boundJobs(run, { startedAt = "2026-10-15T10:10:00Z", completedAt = "2026-10-15T10:18:20Z", step = {}, job = {} } = {}) {
  return { total_count: 2, jobs: [
    { id: 900, name: "Database integration (2/4)", run_id: run.id, head_sha: run.head_sha, run_attempt: run.run_attempt,
      conclusion: "success", steps: [{ name: RESERVATION_STEP, number: 10, conclusion: "skipped", started_at: startedAt, completed_at: startedAt }] },
    { id: 901, name: RESERVATION_JOB, run_id: run.id, head_sha: run.head_sha, run_attempt: run.run_attempt, conclusion: "success",
      ...job, steps: [
        { name: "Run node scripts/ci-shards.mjs db 1/4", number: 9, conclusion: "success", started_at: "2026-10-15T10:01:00Z", completed_at: startedAt },
        { name: RESERVATION_STEP, number: 10, conclusion: "success", started_at: startedAt, completed_at: completedAt, ...step },
      ] },
  ] };
}

test("timing medians omit obsolete IDs while leaving new tests eligible for fallback", () => {
  const inventory = [{ id: "current" }, { id: "new" }];
  const runs = [100, 200, 300, 10000].map(durationMs => [{ id: "current", durationMs }, { id: "deleted", durationMs: 90000 }]);
  const timings = medianTimings(inventory, runs);
  assert.deepEqual(timings, { current: 250 });
  assert.deepEqual(medianTimings(inventory, runs.slice(0, 3)), { current: 200 });
  const shards = partition(inventory, 2, timings, 6000);
  assert.deepEqual(shards.flatMap(shard => shard.items).map(item => item.id).sort(), ["current", "new"]);
  assert.equal(shards.reduce((sum, shard) => sum + shard.duration, 0), 6250);
  assert.throws(() => medianTimings(inventory, [[{ id: "current", durationMs: 1 }, { id: "current", durationMs: 2 }]]), /Duplicate/);
  for (const durationMs of [0, -1, NaN]) {
    assert.throws(() => medianTimings(inventory, [[{ id: "current", durationMs }]]), /Invalid timing/);
  }
});

test("web timing samples exclude retries, failures and conditional skips without changing identities", () => {
  const passed = { status: "passed", retry: 0, duration: 120, errors: [] };
  const entry = (title, patch = {}) => ({ title, file: "cases.spec.ts", tests: [
    { projectName: "chromium", expectedStatus: "passed", status: "expected", results: [passed], ...patch },
  ] });
  const report = { suites: [{ line: 0, suites: [{ title: "outer", line: 1, specs: [
    entry("clean"), entry("flaky", { status: "flaky", results: [{ ...passed, status: "failed" }, { ...passed, retry: 1 }] }),
    entry("retry-only", { results: [{ ...passed, retry: 1 }] }), entry("skip", { expectedStatus: "skipped", results: [] }),
    entry("failure", { status: "unexpected", results: [{ ...passed, status: "failed" }] }),
  ] }] }] };
  assert.equal(webTests(report).length, 5);
  assert.deepEqual(successfulTimings("web", report), [{ id: "[chromium] › cases.spec.ts › outer › clean", durationMs: 120 }]);
  assert.deepEqual(successfulTimings("db", [{ id: "good", exitCode: 0, durationMs: 12 }, { id: "failed", exitCode: 1, durationMs: 9999 }]),
    [{ id: "good", durationMs: 12 }]);
});

test("artifact import rejects incomplete, duplicate or unsuccessful provenance before producing weights", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "musubi-ci-timing-fixture-"));
  try {
    const run = { id: 123, run_attempt: 1, status: "completed", conclusion: "success", head_sha: "a".repeat(40),
      html_url: "https://github.com/example/project/actions/runs/123" };
    const artifacts = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, name: `database-timings-${index + 1}` }));
    const writeMetadata = () => {
      writeFileSync(join(directory, "run.json"), JSON.stringify(run));
      writeFileSync(join(directory, "artifacts.json"), JSON.stringify({ artifacts }));
      // Database imports also bind the shard-1 conformance step (R7).
      writeFileSync(join(directory, "jobs.json"), JSON.stringify(boundJobs(run)));
    };
    writeMetadata();
    for (const [index, artifact] of artifacts.entries()) {
      mkdirSync(join(directory, artifact.name));
      writeFileSync(join(directory, artifact.name, "selected-tests.txt"), `suite-${index}\n`);
      writeFileSync(join(directory, artifact.name, "db-results.json"), JSON.stringify([{ id: `suite-${index}`, exitCode: 0, durationMs: 10 + index }]));
    }
    const inventory = artifacts.map((_, index) => ({ id: `suite-${index}` }));
    const baseline = importTimings("db", "2026-10-15", [directory], inventory);
    assert.equal(Object.keys(baseline.durationsMs).length, 4);
    assert.match(baseline.sources[0].artifacts[0].reportSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => importTimings("db", "2026-10-15", [directory, directory], inventory), /distinct/);
    writeFileSync(join(directory, artifacts[0].name, "selected-tests.txt"), "suite-0\nsuite-missing\n");
    assert.throws(() => importTimings("db", "2026-10-15", [directory], inventory), /selected/);
    writeFileSync(join(directory, artifacts[0].name, "selected-tests.txt"), "suite-0\n");
    run.conclusion = "failure";
    writeMetadata();
    assert.throws(() => importTimings("db", "2026-10-15", [directory], inventory), /successful/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("R7: database imports bind the shard-1 conformance step to its run and record the median as a reservation", () => {
  const directories = [];
  const fixture = (runId, completedAt) => {
    const directory = mkdtempSync(join(tmpdir(), "musubi-ci-reservation-fixture-"));
    directories.push(directory);
    const run = { id: runId, run_attempt: 1, status: "completed", conclusion: "success", head_sha: String(runId % 10).repeat(40),
      html_url: `https://github.com/example/project/actions/runs/${runId}` };
    const artifacts = Array.from({ length: 4 }, (_, index) => ({ id: runId * 10 + index, name: `database-timings-${index + 1}` }));
    writeFileSync(join(directory, "run.json"), JSON.stringify(run));
    writeFileSync(join(directory, "artifacts.json"), JSON.stringify({ artifacts }));
    writeFileSync(join(directory, "jobs.json"), JSON.stringify(boundJobs(run, { completedAt })));
    for (const [index, artifact] of artifacts.entries()) {
      mkdirSync(join(directory, artifact.name));
      writeFileSync(join(directory, artifact.name, "selected-tests.txt"), `suite-${index}\n`);
      writeFileSync(join(directory, artifact.name, "db-results.json"), JSON.stringify([{ id: `suite-${index}`, exitCode: 0, durationMs: 10 + index }]));
    }
    return { directory, run };
  };
  const inventory = Array.from({ length: 4 }, (_, index) => ({ id: `suite-${index}` }));
  try {
    // 500 s, 540 s and 520 s steps starting at 10:10:00.
    const sources = [fixture(101, "2026-10-15T10:18:20Z"), fixture(102, "2026-10-15T10:19:00Z"), fixture(103, "2026-10-15T10:18:40Z")];
    const result = importTimings("db", "2026-10-15", sources.map(source => source.directory), inventory);
    assert.equal(result.schemaVersion, 2);
    assert.deepEqual(result.sources.map(source => source.reservation), [500000, 540000, 520000].map((durationMs, index) => ({
      jobId: 901, job: RESERVATION_JOB, step: RESERVATION_STEP, stepNumber: 10, startedAt: "2026-10-15T10:10:00Z",
      completedAt: ["2026-10-15T10:18:20Z", "2026-10-15T10:19:00Z", "2026-10-15T10:18:40Z"][index], durationMs,
    })));
    assert.equal(result.reservations.total, 4);
    assert.deepEqual(result.reservations.reservedMs, [520000, 0, 0, 0]);
    assert.equal(typeof result.reservations.basis, "string");
    assert.deepEqual(reservedWeights(result, 4), [520000, 0, 0, 0]);
    assert.equal(Object.keys(result.durationsMs).length, 4);

    const [{ directory, run }] = sources;
    const rejects = (jobs, pattern) => {
      writeFileSync(join(directory, "jobs.json"), JSON.stringify(jobs));
      assert.throws(() => importTimings("db", "2026-10-15", [directory], inventory), pattern, JSON.stringify(pattern));
    };
    const valid = boundJobs(run, { completedAt: "2026-10-15T10:18:20Z" });
    const target = jobs => jobs.jobs.find(job => job.name === RESERVATION_JOB);
    const edit = change => { const jobs = structuredClone(valid); change(jobs, target(jobs)); return jobs; };
    rejects(edit((jobs, job) => { job.steps[1].conclusion = "failure"; }), /did not succeed/);
    rejects(edit((jobs, job) => { job.steps.push({ ...job.steps[1] }); }), /exactly one .*step/);
    rejects(edit((jobs, job) => { job.steps.pop(); }), /exactly one .*step/);
    rejects(edit((jobs, job) => { job.run_attempt = 2; }), /run_attempt/);
    rejects(edit((jobs, job) => { job.run_id = run.id + 1; }), /run_id/);
    rejects(edit((jobs, job) => { job.head_sha = "f".repeat(40); }), /head_sha/);
    rejects(edit((jobs, job) => { job.conclusion = "failure"; }), /job .*did not succeed/);
    rejects(edit(jobs => { jobs.jobs.push({ ...target(jobs) }); }), /exactly one job/);
    rejects(edit(jobs => { jobs.jobs = jobs.jobs.filter(job => job.name !== RESERVATION_JOB); }), /exactly one job/);
    rejects(edit((jobs, job) => { job.steps[1].completed_at = job.steps[1].started_at; }), /duration/);
    rmSync(join(directory, "jobs.json"));
    assert.throws(() => importTimings("db", "2026-10-15", [directory], inventory), /jobs\.json/);
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});

// R8 runs the actual CLI against the real repository files. The expected
// values are compositions of production exports (a), the committed reservation
// (b), sums over the IDs the CLI actually listed (c), and the greedy LPT bound (d).
const ESTIMATE = "Estimated load ms per shard (suites + reserved): ";
const HEADER_PREFIXES = ["db: ", "Timing coverage: ", ESTIMATE, "Unmeasured suites (", "No reserved weights recorded",
  "reserved weights: none", "::notice"];

function listDatabaseShard(shard) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  const result = spawnSync(process.execPath, ["scripts/ci-shards.mjs", "db", shard, "--list"], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.equal(lines.pop(), "");
  const isHeader = line => HEADER_PREFIXES.some(prefix => line.startsWith(prefix));
  const line = prefix => {
    const matches = lines.filter(candidate => candidate.startsWith(prefix));
    assert.equal(matches.length, 1, `${shard}: one "${prefix}" line`);
    return matches[0];
  };
  const loads = line(ESTIMATE).slice(ESTIMATE.length).split(", ").map(part => {
    const match = /^(-?\d+)(?: \((-?\d+) \+ (\d+) reserved\))?$/.exec(part);
    assert.ok(match, `${shard}: unparseable load "${part}"`);
    const combined = Number(match[1]);
    return match[2] ? { combined, suites: Number(match[2]), reserved: Number(match[3]) } : { combined, suites: combined, reserved: null };
  });
  return { ids: lines.filter(candidate => !isHeader(candidate)), lines, line, loads };
}

test("R8: the actual database CLI applies the committed reservation with consistent accounting", async t => {
  const inventory = databaseTests();
  const file = JSON.parse(readFileSync(join(root, "scripts/ci-db-timings.json"), "utf8"));
  const timings = file.durationsMs;
  const fallback = FALLBACK_MS.db;
  const recorded = file.reservations?.reservedMs ?? [0, 0, 0, 0];
  const R = recorded[0];
  const estimate = id => timings[id] ?? fallback;
  const wmax = Math.max(...inventory.map(item => estimate(item.id)));
  const order = new Map(inventory.map((item, index) => [item.id, index]));
  const runs = [1, 2, 3, 4].map(k => listDatabaseShard(`${k}/4`));
  // Exact list-derived loads: lookup rule plus the recorded reservation, no partitioning.
  const exact = runs.map(({ ids: listed }, index) => listed.reduce((sum, id) => sum + estimate(id), 0) + recorded[index]);

  await t.test("(a) each list is the production composition with the recorded reservation", () => {
    const expected = partition(inventory, 4, timings, fallback, reservedWeights(file, 4));
    for (const [index, run] of runs.entries()) {
      assert.match(run.line("db: "), new RegExp(`^db: ${inventory.length} total suites/tests; shard ${index + 1}/4: ${run.ids.length}$`));
      assert.match(run.line("Timing coverage: "), /^Timing coverage: \d+\/\d+ measured, \d+ fallback at 15000 ms, \d+ obsolete; /);
      assert.deepEqual(run.ids, ids(expected[index].items), `shard ${index + 1}/4 list`);
      assert.deepEqual(run.loads, runs[0].loads, "every job prints the same plan");
    }
  });
  await t.test("(b) the reservation is real and printed only for shard 1", () => {
    assert.ok(Number.isSafeInteger(R) && R > 0, `committed reservation ${R}`);
    for (const run of runs) {
      assert.equal(run.loads[0].reserved, R);
      assert.deepEqual(run.loads.slice(1).map(load => load.reserved), [null, null, null]);
    }
  });
  await t.test("(c) printed parts add up and match the sum over the listed suites", () => {
    for (const [index, run] of runs.entries()) {
      for (const load of run.loads) assert.equal(load.suites + (load.reserved ?? 0), load.combined);
      assert.ok(Math.abs(run.loads[index].combined - exact[index]) <= 0.5,
        `shard ${index + 1}/4 printed ${run.loads[index].combined}, list-derived ${exact[index]}`);
    }
  });
  await t.test("(d) list-derived loads respect the greedy LPT bound", t => {
    const spread = Math.max(...exact) - Math.min(...exact);
    assert.ok(spread <= wmax, `load spread ${spread} ms exceeds the largest suite estimate ${wmax} ms`);
    const suiteLoads = exact.map((load, index) => load - recorded[index]);
    if (R > wmax) {
      // Bound with R > wmax: R + S1 - Sj <= wmax, so S1 < Sj for every other shard.
      assert.ok(suiteLoads.slice(1).every(load => suiteLoads[0] < load), `suite loads ${suiteLoads.join(", ")}`);
    } else {
      t.diagnostic(`shard-1 suite clause not applicable: reservation ${R} ms <= largest suite estimate ${wmax} ms`);
    }
  });
  await t.test("every suite runs exactly once, in source order, with no empty shard", () => {
    const union = runs.flatMap(run => run.ids);
    assert.equal(union.length, inventory.length);
    assert.deepEqual([...union].sort(), ids(inventory).sort());
    for (const run of runs) {
      assert.ok(run.ids.length > 0);
      const positions = run.ids.map(id => order.get(id));
      assert.deepEqual(positions, [...positions].sort((x, y) => x - y));
    }
  });
  await t.test("other totals plan the same inventory without the four-shard reservation", () => {
    for (const total of [1, 3]) {
      const others = Array.from({ length: total }, (_, index) => listDatabaseShard(`${index + 1}/${total}`));
      for (const other of others) {
        assert.equal(other.line("reserved weights: none"),
          `reserved weights: none for ${total} shard(s) (recorded for ${file.reservations?.total})`);
        assert.ok(other.loads.every(load => load.reserved === null));
        assert.ok(other.ids.length > 0);
      }
      const listed = others.flatMap(other => other.ids);
      assert.deepEqual([...listed].sort(), ids(inventory).sort());
      if (total === 1) assert.deepEqual(others[0].ids, ids(inventory));
    }
  });
});

test("R9: the workflow still runs the conformance step only after the four-shard database plan's shard 1", () => {
  const workflow = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");
  const start = workflow.indexOf("\n  integration:\n");
  const integration = workflow.slice(start, workflow.indexOf("\n  e2e:\n", start));
  assert.ok(start > 0 && integration.length > 0);
  const name = /\n {4}name: (Database integration \(\$\{\{ matrix\.shard \}\}\/4\))\n/.exec(integration)?.[1];
  assert.equal(name?.replace("${{ matrix.shard }}", "1"), RESERVATION_JOB);
  assert.match(integration, /\n {8}shard: \[1, 2, 3, 4\]\n/);
  assert.ok(integration.includes("\n      - run: node scripts/ci-shards.mjs db ${{ matrix.shard }}/4\n"));
  assert.ok(integration.includes(`\n      - name: ${RESERVATION_STEP}\n        if: matrix.shard == 1\n`));
});

test("R10: the committed database timing file is internally consistent importer output", () => {
  const path = join(root, "scripts/ci-db-timings.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.schemaVersion, 2);
  assert.equal(file.reservations?.total, 4);
  const [reserved, ...others] = file.reservations.reservedMs;
  assert.equal(file.reservations.reservedMs.length, 4);
  assert.ok(Number.isSafeInteger(reserved) && reserved > 0);
  assert.deepEqual(others, [0, 0, 0]);
  assert.ok(file.sources.length >= 1);
  for (const source of file.sources) {
    const { reservation } = source;
    assert.equal(reservation?.job, RESERVATION_JOB, `run ${source.runId}`);
    assert.equal(reservation.step, RESERVATION_STEP);
    assert.equal(reservation.durationMs, Date.parse(reservation.completedAt) - Date.parse(reservation.startedAt));
  }
  assert.equal(reserved, Math.round(median(file.sources.map(source => source.reservation.durationMs))));
  assert.deepEqual(loadTimingFile(path), file);
});
