import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSelection, databaseTests, parseShard, partition, webTests } from "./ci-shards.mjs";

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
  for (const id of ["apps/sync-reference/src/store.integration.test.ts", "apps/sync-reference/src/process.integration.test.ts", "packages/db/src/queries/operation-admission-missing.integration.test.ts"]) {
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
const { medianTimings, successfulTimings, importTimings } = await import("./ci-timings.mjs");

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
