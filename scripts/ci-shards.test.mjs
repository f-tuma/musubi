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
