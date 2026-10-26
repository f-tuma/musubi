import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalNewPath, execute, parseArguments, requiredCases, requireArchivedPackageManager, sha256, stripReferenceTestSupport } from "./sync-alpha-common.mjs";
import { validateConformance } from "./verify-sync-alpha.mjs";

const mode = "reference-db", root = "/owned/candidate", manifestSha256 = "a".repeat(64), source = { commit: "b".repeat(40), tree: "c".repeat(40) };
const expectedCaseIDs = ["db/reference/paired"], binding = { mode, root, manifestSha256, manifest: { source }, expectedCaseIDs };
function receipt() {
  return { schemaVersion: 1, kind: "sync-conformance-report", mode, status: "passed", partial: false,
    source: { head: source.commit, tree: source.tree }, candidate: { root, manifestSha256 },
    inventory: { requiredCaseIDs: expectedCaseIDs, selectedCaseIDs: expectedCaseIDs },
    results: [{ id: expectedCaseIDs[0], status: "passed", durationMs: 1, exitCode: 0, skipped: 0, todo: 0, cleanup: { required: true, completed: true } }],
    totals: { required: 1, selected: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }, installedRuntime: false, liveProvider: false, deployed: false };
}
test("packaging option parser refuses unknown, repeated and missing values", () => {
  assert.deepEqual({ ...parseArguments(["--ref", "a"], ["--ref"]) }, { "--ref": "a" });
  for (const args of [["--other", "a"], ["--ref"], ["--ref", "--other"], ["--ref", "a", "--ref", "b"]]) assert.throws(() => parseArguments(args, ["--ref"]));
});
test("package manager pin is validated from archived source without inherited configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-manager-test-"));
  try {
    const calls = [], run = async (...args) => { calls.push(args); return { stdout: Buffer.from("11.8.0\n") }; };
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@11.8.0" }));
    await requireArchivedPackageManager(directory, run);
    assert.deepEqual(calls, [["pnpm-version", "pnpm", ["--version"], { cwd: directory }]]);
    await assert.rejects(requireArchivedPackageManager(directory, async () => ({ stdout: Buffer.from("12.4.2\n") })), /Exact pinned pnpm/);
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@12.4.2" }));
    await assert.rejects(requireArchivedPackageManager(directory, () => { throw new Error("Must not execute before source pin validation"); }), /Source package manager pin/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("new output paths reject real parent aliases into candidate/checkout and existing dangling leaves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-path-test-"));
  try {
    const candidate = join(directory, "candidate"), checkout = join(directory, "checkout"), output = join(directory, "output");
    for (const path of [candidate, checkout, output]) await mkdir(path);
    const candidateAlias = join(directory, "outside-candidate"), checkoutAlias = join(directory, "outside-checkout"), safeAlias = join(directory, "safe-alias");
    await symlink(candidate, candidateAlias, "dir"); await symlink(checkout, checkoutAlias, "dir"); await symlink(output, safeAlias, "dir");
    for (const path of [join(candidateAlias, "report.json"), join(candidateAlias, "report.json.conformance.json"), join(checkoutAlias, "new-build")])
      await assert.rejects(canonicalNewPath(path, [candidate, checkout]), /immutable/);
    assert.equal(await canonicalNewPath(join(safeAlias, "report.json"), [candidate, checkout]), join(output, "report.json"));
    const sidecar = join(output, "report.json.conformance.json"); await symlink(join(candidate, "not-created.json"), sidecar);
    await assert.rejects(canonicalNewPath(sidecar, [candidate, checkout]), /already exist/);
    await assert.rejects(canonicalNewPath(join(directory, "absent-parent", "new-report.json"), [candidate, checkout]));
    assert.deepEqual(await readdir(candidate), []); assert.deepEqual(await readdir(checkout), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("owned process groups stop and reap descendants on timeout or output overflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-process-test-"));
  const fixture = `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); let stopping = false;
    child.once("exit", () => { if (stopping) process.exit(0); });
    process.on("SIGTERM", () => { stopping = true; if (child.exitCode !== null || child.signalCode !== null) process.exit(0); });
    writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, descendant: child.pid }));
    if (process.argv[2] === "overflow") process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);`;
  const pidFiles = [];
  try {
    for (const reason of ["timeout", "overflow"]) {
      const pidFile = join(directory, `${reason}.json`); pidFiles.push(pidFile);
      await assert.rejects(execute(`descendant-${reason}`, process.execPath, ["-e", fixture, pidFile, reason],
        { cwd: directory, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 2000, maximumOutput: reason === "overflow" ? 64 : 8000 }), /required process did not complete successfully/);
      const pids = JSON.parse(await readFile(pidFile, "utf8"));
      for (const pid of [pids.parent, pids.descendant]) {
        assert(Number.isSafeInteger(pid) && pid > 1);
        assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
      }
    }
  } finally {
    // Only this nonce fixture's own group IDs are eligible for emergency cleanup.
    for (const path of pidFiles) {
      let parent; try { parent = JSON.parse(await readFile(path, "utf8")).parent; } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      assert(Number.isSafeInteger(parent) && parent > 1);
      try { process.kill(-parent, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
test("production runtime excludes declared reference conformance support and retains CLI source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-runtime-test-"));
  try {
    await mkdir(join(directory, "src")); await mkdir(join(directory, "conformance"));
    await writeFile(join(directory, "src/cli.ts"), "export const cli = true;\n");
    const helper = "export const testOnly = true;\n"; await writeFile(join(directory, "conformance/module.mjs"), helper);
    const record = await stripReferenceTestSupport(directory);
    assert.equal(record.directory, "conformance"); assert.equal(record.present, true);
    assert.equal(record.files.length, 1); assert.equal(record.files[0].path, "module.mjs"); assert.equal(record.files[0].sha256, sha256(helper));
    await assert.rejects(lstat(join(directory, "conformance")), error => error.code === "ENOENT");
    assert.equal(await readFile(join(directory, "src/cli.ts"), "utf8"), "export const cli = true;\n");
    assert.deepEqual(await stripReferenceTestSupport(directory), { directory: "conformance", present: false, files: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("required corpus inventory independently expands and reconciles manifest IDs", () => {
  const value = { schemaVersion: 1, entries: [{ id: "json/google-update", kind: "json", mode: "deterministic", required: true, scenarios: ["fresh"] }],
    modes: { deterministic: { requiredCaseIDs: ["json/google-update/fresh"] } } };
  assert.deepEqual(requiredCases(value, "deterministic"), ["json/google-update/fresh"]);
  for (const change of [draft => { draft.entries[0].scenarios.push("fresh"); }, draft => { draft.modes.deterministic.requiredCaseIDs = []; },
    draft => { draft.entries[0].required = false; }, draft => { draft.entries[0].kind = "unknown"; }]) {
    const draft = structuredClone(value); change(draft); assert.throws(() => requiredCases(draft, "deterministic"));
  }
});
test("full conformance receipt requires exact candidate, required cases and own cleanup", () => {
  assert.deepEqual(validateConformance(receipt(), binding), { required: 1, passed: 1, cleanupCompleted: true });
  const mutations = [value => { value.source.head = "d".repeat(40); }, value => { value.candidate.manifestSha256 = "e".repeat(64); },
    value => { value.partial = true; }, value => { value.status = "listed"; }, value => { value.results = []; },
    value => { value.results.push(value.results[0]); }, value => { value.results[0].status = "failed"; },
    value => { value.results[0].exitCode = 1; }, value => { value.results[0].skipped = 1; }, value => { value.results[0].todo = 1; },
    value => { value.results[0].cleanup = null; }, value => { value.results[0].cleanup.completed = false; },
    value => { value.inventory.requiredCaseIDs = ["db/reference/other"]; value.inventory.selectedCaseIDs = ["db/reference/other"]; value.results[0].id = "db/reference/other"; },
    value => { value.totals.passed = 2; }, value => { value.liveProvider = true; }];
  for (const mutate of mutations) { const value = receipt(); mutate(value); assert.throws(() => validateConformance(value, binding)); }
});
