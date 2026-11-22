import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GENERATED_MANAGER_PATHS, canonicalNewPath, execute, inventoryPackages, parseArguments, planDeployedManifest, planGeneratedManagerMetadata,
  requiredCases, requireArchivedPackageManager, sha256, stripReferenceTestSupport } from "./sync-alpha-common.mjs";
import { validateConformance } from "./verify-sync-alpha.mjs";
import * as common from "./sync-alpha-common.mjs";
import * as verifier from "./verify-sync-alpha.mjs";

const mode = "reference-db", root = "/owned/candidate", manifestSha256 = "a".repeat(64), source = { commit: "b".repeat(40), tree: "c".repeat(40) };
const expectedCaseIDs = ["db/reference/paired"], binding = { mode, root, manifestSha256, manifest: { source }, expectedCaseIDs };
function receipt() {
  return { schemaVersion: 1, kind: "sync-conformance-report", mode, status: "passed", partial: false,
    source: { head: source.commit, tree: source.tree }, candidate: { root, manifestSha256 },
    inventory: { requiredCaseIDs: expectedCaseIDs, selectedCaseIDs: expectedCaseIDs },
    results: [{ id: expectedCaseIDs[0], status: "passed", durationMs: 1, exitCode: 0, skipped: 0, todo: 0, cleanup: { required: true, completed: true } }],
    totals: { required: 1, selected: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }, installedRuntime: false, liveProvider: false, deployed: false };
}
async function manifestFixture() {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-manifest-test-")), sourceRoot = join(directory, "source"), runtimeRoot = join(directory, "runtime"), toolingRoot = join(directory, "tooling");
  const original = join(sourceRoot, "packages/sync-runtime"), deployed = join(runtimeRoot, "node_modules/@musubi/sync-runtime"), toolingImporter = join(toolingRoot, "node_modules/@musubi/sync-runtime");
  async function pkg(path, value) { await mkdir(path, { recursive: true }); await writeFile(join(path, "package.json"), `${JSON.stringify(value, null, 2)}\n`); await writeFile(join(path, "index.js"), "export const fixture = true;\n"); }
  const source = { name: "@musubi/sync-runtime", private: true, type: "module", main: "index.js", description: "owned fixture metadata",
    dependencies: { "dep-a": "^1.0.0", "@musubi/types": "workspace:*" }, devDependencies: { "tool-dep": "^3.0.0" } };
  const typesSource = join(sourceRoot, "packages/types"), typesTarget = join(runtimeRoot, "node_modules/@musubi/types");
  const types = { name: "@musubi/types", private: true, type: "module", main: "index.js" };
  await pkg(original, source); await pkg(typesSource, types); await pkg(typesTarget, types);
  const raw = structuredClone(source); raw.dependencies["dep-a"] = "1.2.3";
  raw.dependencies["@musubi/types"] = `@musubi/types@${pathToFileURL(typesSource).href}`; raw.devDependencies["tool-dep"] = "3.1.2"; raw.optionalDependencies = {};
  await pkg(deployed, raw); await pkg(toolingImporter, source);
  for (const [path, name, version] of [[join(deployed, "node_modules/dep-a"), "dep-a", "1.2.3"], [join(runtimeRoot, "node_modules/dep-a"), "dep-a", "9.0.0"],
    [join(toolingImporter, "node_modules/tool-dep"), "tool-dep", "3.1.2"], [join(toolingRoot, "node_modules/tool-dep"), "tool-dep", "9.0.0"]]) await pkg(path, { name, version, main: "index.js" });
  await mkdir(join(original, "src")); await writeFile(join(original, "src/schema.sql"), "-- original SQL fixture\n");
  return { directory, source, raw, typesSource, typesTarget, pkg, input: { original, deployed, sourceRoot, closureRoot: runtimeRoot, closureKind: "runtime", toolingRoot, toolingImporter,
    workspaceLocations: new Map([["@musubi/types", { original: typesSource, deployed: typesTarget }]]) } };
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
test("deployed manifest normalization binds importer-specific versions and relocatable workspace targets", async () => {
  const fixture = await manifestFixture();
  try {
    const sourceBefore = await readFile(join(fixture.input.original, "package.json")), sqlBefore = await readFile(join(fixture.input.original, "src/schema.sql"));
    const plan = await planDeployedManifest(fixture.input), normalized = JSON.parse(plan.normalizedBytes);
    assert.equal(normalized.dependencies["dep-a"], "1.2.3"); assert.equal(normalized.devDependencies["tool-dep"], "3.1.2");
    assert.equal(normalized.dependencies["@musubi/types"], "file:../types"); assert.equal(normalized.description, fixture.source.description);
    assert.equal(plan.record.edges.find(edge => edge.name === "dep-a").resolution.target, "node_modules/@musubi/sync-runtime/node_modules/dep-a");
    assert.equal(plan.record.edges.find(edge => edge.name === "tool-dep").resolution.closure, "tooling");
    assert.deepEqual(await readFile(plan.path), plan.rawBytes); assert.equal(plan.record.sourceSha256, sha256(sourceBefore));
    await writeFile(plan.path, plan.normalizedBytes);
    assert.deepEqual(await readFile(join(fixture.input.original, "package.json")), sourceBefore); assert.deepEqual(await readFile(join(fixture.input.original, "src/schema.sql")), sqlBefore);
    const moved = join(fixture.directory, "relocated-runtime"); await rename(fixture.input.closureRoot, moved); await rm(fixture.input.sourceRoot, { recursive: true });
    const owner = join(moved, "node_modules/@musubi/sync-runtime"), value = JSON.parse(await readFile(join(owner, "package.json")));
    assert.equal(await realpath(resolve(owner, value.dependencies["@musubi/types"].slice(5))), await realpath(join(moved, "node_modules/@musubi/types")));
    assert.equal(createRequire(join(owner, "package.json")).resolve("@musubi/types"), join(moved, "node_modules/@musubi/types/index.js"));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test("deployed manifest normalization rejects wrong versions, workspace origins and installed targets", async () => {
  const changes = [async fixture => { fixture.raw.dependencies["dep-a"] = "2.0.0"; await writeFile(join(fixture.input.deployed, "package.json"), JSON.stringify(fixture.raw)); },
    async fixture => { fixture.source.dependencies["dep-a"] = "1.0.0"; await writeFile(join(fixture.input.original, "package.json"), JSON.stringify(fixture.source)); },
    async fixture => { fixture.raw.dependencies["@musubi/types"] = "@musubi/types@file:///outside/types"; await writeFile(join(fixture.input.deployed, "package.json"), JSON.stringify(fixture.raw)); },
    async fixture => { await fixture.pkg(fixture.typesTarget, { name: "@musubi/sync-codec", private: true, main: "index.js" }); },
    async fixture => { fixture.input.workspaceLocations.get("@musubi/types").deployed = fixture.input.toolingImporter; },
    async fixture => { await rm(join(fixture.input.deployed, "package.json")); await symlink(join(fixture.input.original, "package.json"), join(fixture.input.deployed, "package.json")); },
    async fixture => { await rm(join(fixture.input.deployed, "node_modules/dep-a"), { recursive: true }); await rm(join(fixture.input.closureRoot, "node_modules/dep-a"), { recursive: true });
      await fixture.pkg(join(fixture.input.toolingImporter, "node_modules/dep-a"), { name: "dep-a", version: "1.2.3", main: "index.js" }); }];
  for (const change of changes) {
    const fixture = await manifestFixture();
    try { await change(fixture); const before = await readFile(join(fixture.input.original, "package.json"));
      await assert.rejects(planDeployedManifest(fixture.input)); assert.deepEqual(await readFile(join(fixture.input.original, "package.json")), before);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  }
});
test("generated deployment metadata is planned only for fixed regular owned paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-manager-metadata-test-"));
  try {
    for (const path of GENERATED_MANAGER_PATHS) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), `raw:${path}\n`); }
    const plans = await planGeneratedManagerMetadata(directory, "runtime"); assert.equal(plans.length, 4);
    for (const plan of plans) { assert.equal(plan.record.to, `provenance/generated-manager/${plan.record.from}`); assert.equal(sha256(await readFile(plan.path)), plan.record.sha256); }
    const path = join(directory, GENERATED_MANAGER_PATHS[0]), outside = join(directory, "dependency-owned.yaml");
    await writeFile(outside, "do not change\n"); await rm(path); await symlink(outside, path);
    await assert.rejects(planGeneratedManagerMetadata(directory, "runtime"), /regular/); assert.equal(await readFile(outside, "utf8"), "do not change\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("license inventory retains complete same-package embedded MIT and included third-party notices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-license-test-")), root = join(directory, "candidate"), output = join(directory, "collected");
  try {
    const mit = await readFile(new URL("../LICENSE", import.meta.url));
    const owned = join(root, "runtime/node_modules/@musubi/sync-runtime"), embedded = join(root, "runtime/node_modules/fixture-mit"), notices = join(root, "tooling/node_modules/fixture-notices");
    for (const path of [owned, embedded, notices]) await mkdir(path, { recursive: true });
    await writeFile(join(root, "LICENSE"), mit); await writeFile(join(owned, "package.json"), JSON.stringify({ name: "@musubi/sync-runtime", private: true }));
    await writeFile(join(embedded, "package.json"), JSON.stringify({ name: "fixture-mit", version: "1.0.0", license: "MIT" }));
    const readme = Buffer.concat([Buffer.from("# Package usage\n\nEntire README must be preserved.\n\n## License\n\n"), mit]); await writeFile(join(embedded, "README.md"), readme);
    await writeFile(join(notices, "package.json"), JSON.stringify({ name: "fixture-notices", version: "1.0.0", license: "MIT" }));
    await writeFile(join(notices, "LICENSE"), mit); const notice = Buffer.from("Included original third-party notice fixture.\n"); await writeFile(join(notices, "ThirdPartyNoticeText.txt"), notice);
    const inventory = await inventoryPackages(root, output), fromReadme = inventory.find(value => value.name === "fixture-mit").licenses[0];
    assert.equal(fromReadme.sourceKind, "embedded-license-readme"); assert.equal(fromReadme.sha256, sha256(readme));
    assert.deepEqual(await readFile(join(output, `${fromReadme.sha256}.txt`)), readme);
    const fromNotice = inventory.find(value => value.name === "fixture-notices").licenses.find(value => value.sourceKind === "third-party-notice");
    assert.equal(fromNotice.sha256, sha256(notice)); assert.deepEqual(await readFile(join(output, `${fromNotice.sha256}.txt`)), notice);
    assert(inventory.every(value => value.licenseReview === "pending-owner-review"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("license inventory refuses partial or undeclared embedded notices and non-MIT fallback", async () => {
  const mit = (await readFile(new URL("../LICENSE", import.meta.url))).toString("utf8");
  const variations = [{ license: "MIT", text: "## License\nCopyright (c) 2026 Fixture\nPermission is hereby granted, free of charge.\n" },
    { license: undefined, text: `## License\n${mit}` }, { license: "BSD-2-Clause", text: `## License\n${mit}` },
    { license: "MIT", text: mit }, { license: "MIT", text: `## License\n${mit.replace(/^Copyright.*\n/m, "")}` },
    { license: "MIT", text: `## License\n${mit.replace(/The above copyright notice[\s\S]*?Software\./, "")}` },
    { license: "MIT", text: `## License\n${mit.slice(0, mit.indexOf("THE SOFTWARE IS PROVIDED"))}` },
    { license: "MIT", text: `## License\n${mit.slice(0, mit.indexOf("IN NO EVENT"))}` }];
  for (const variation of variations) {
    const directory = await mkdtemp(join(tmpdir(), "sync-alpha-license-negative-")), root = join(directory, "candidate"), owned = join(root, "runtime/node_modules/@musubi/sync-runtime"), external = join(root, "runtime/node_modules/fixture-partial");
    try {
      await mkdir(owned, { recursive: true }); await mkdir(external, { recursive: true }); await writeFile(join(root, "LICENSE"), mit);
      await writeFile(join(owned, "package.json"), JSON.stringify({ name: "@musubi/sync-runtime", private: true }));
      await writeFile(join(external, "package.json"), JSON.stringify({ name: "fixture-partial", version: "1.0.0", ...(variation.license ? { license: variation.license } : {}) }));
      await writeFile(join(external, "README.md"), variation.text); await writeFile(join(external, "ThirdPartyNoticeText.txt"), "Copyright notice alone is not a complete license.\n");
      await assert.rejects(inventoryPackages(root, join(directory, "collected")), /no collected license text: fixture-partial/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
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

test("owned execution failures expose only a fixed failure code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-alpha-failure-code-test-")), env = { PATH: process.env.PATH ?? "" };
  const leak = "process.stdout.write('STDOUT-SECRET'); process.stderr.write('STDERR-SECRET');";
  try {
    for (const [code, script, options] of [["child-failed", `${leak} process.exit(3);`, {}], ["timeout", `${leak} setInterval(() => {}, 1000);`, { timeoutMs: 300 }],
      ["output-overflow", `process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);`, { maximumOutput: 64 }]]) {
      await assert.rejects(execute(`failure-${code}`, process.execPath, ["-e", script], { cwd: directory, env, ...options }), error => {
        assert.equal(error.code, code); assert.equal(error.id, `failure-${code}`); assert.ok(common.EXECUTE_FAILURE_CODES.includes(error.code));
        assert.deepEqual(Object.keys(error).sort(), ["code", "id"]); assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /SECRET|xxxx/);
        return true;
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
const RETENTION_IDS = ["db/reference/paired", "db/reference/second"], SECRET_URL = "postgresql://owner:hunter2@127.0.0.1:1/reference";
const RETENTION_STUB = `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1], fixture = JSON.parse(process.env.STUB_FIXTURE), behavior = fixture.behavior;
const url = process.env.REFERENCE_DATABASE_URL ?? "postgresql://absent", ids = fixture.ids;
const result = id => ({ id, status: behavior === "passed" ? "passed" : "failed", durationMs: 12, exitCode: behavior === "passed" ? 0 : null, skipped: 0, todo: 0,
  ...(behavior === "passed" ? {} : { errorCode: "child-exit-failed", terminationReason: "timeout", stack: "Error at " + url }),
  cleanup: { required: true, completed: true, ...(behavior === "passed" ? {} : { leaked: url }) }, ...(behavior === "passed" ? {} : { cleanupEvidence: { url, outer: "c10_secret_db" } }) });
const report = { schemaVersion: 1, kind: "sync-conformance-report", mode: at("--mode"), source: { head: fixture.head, tree: fixture.tree },
  candidate: { root: at("--candidate-root"), manifestSha256: fixture.digest, ...(behavior === "passed" ? {} : { url }) },
  inventory: { requiredCaseIDs: ids, selectedCaseIDs: ids }, results: ids.map(result),
  totals: { required: ids.length, selected: ids.length, passed: behavior === "passed" ? ids.length : 0, failed: behavior === "passed" ? 0 : ids.length, skipped: 0, todo: 0 },
  status: behavior === "passed" ? "passed" : "failed", partial: false, installedRuntime: false, liveProvider: false, deployed: false, ...(behavior === "passed" ? {} : { debug: url }) };
if (behavior === "foreign-case") report.results[0].id = "db/reference/other";
if (behavior === "bad-status") report.results[0].status = "maybe";
if (behavior === "bad-duration") report.results[0].durationMs = "12; " + url;
if (behavior === "wrong-source") report.source.head = "d".repeat(40);
if (behavior === "wrong-digest") report.candidate.manifestSha256 = "e".repeat(64);
if (behavior === "runner-error") { for (const key of ["source", "candidate", "inventory", "results", "totals", "mode"]) delete report[key]; report.partial = true; report.errorCode = "conformance-unavailable"; }
if (behavior === "unknown-code") report.results[1].errorCode = "free text " + url;
const bytes = behavior === "garbage" ? "not json " + url : behavior === "oversize" ? JSON.stringify({ ...report, padding: "x".repeat(3_000_000) }) : JSON.stringify(report);
if (behavior !== "no-report") writeFileSync(at("--report"), bytes, { flag: "wx", mode: 0o600 });
process.stdout.write("STDOUT-SECRET " + url + "\\n"); process.stderr.write("STDERR-SECRET " + url + "\\n");
process.exit(behavior === "passed" ? 0 : 1);
`;
async function retentionFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sync-alpha-retention-test-"))), root = join(directory, "candidate"), conformance = join(root, "conformance");
  await mkdir(join(conformance, "scripts"), { recursive: true }); await mkdir(join(conformance, "apps/sync-reference/conformance"), { recursive: true });
  const corpus = JSON.stringify({ schemaVersion: 1, entries: RETENTION_IDS.map(id => ({ id, kind: "module", mode, required: true })), modes: { [mode]: { requiredCaseIDs: RETENTION_IDS } } });
  await writeFile(join(conformance, "apps/sync-reference/conformance/manifest.v1.json"), corpus);
  await writeFile(join(conformance, "scripts/sync-conformance.mjs"), RETENTION_STUB);
  const manifest = { source, conformance: { manifest: "apps/sync-reference/conformance/manifest.v1.json", manifestSha256: sha256(corpus) } };
  return { directory, root, conformance, manifest, conformanceReportPath: join(directory, "sync-alpha-reference-db.json.conformance.json") };
}
async function runRetention(fixture, behavior, { work } = {}) {
  const scratch = work ?? await mkdtemp(join(fixture.directory, "work-")), saved = {};
  for (const [key, value] of Object.entries({ REFERENCE_DATABASE_URL: SECRET_URL, REFERENCE_CREDENTIAL_KEY: "6".repeat(64), ENVIRONMENT: "test" })) { saved[key] = process.env[key]; process.env[key] = value; }
  try {
    return await verifier.runInstalledConformance({ mode, root: fixture.root, conformance: fixture.conformance, work: scratch, manifest: fixture.manifest, manifestSha256,
      conformanceReportPath: fixture.conformanceReportPath,
      env: { PATH: process.env.PATH ?? "", STUB_FIXTURE: JSON.stringify({ behavior, ids: RETENTION_IDS, head: source.commit, tree: source.tree, digest: manifestSha256 }) } });
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const retainedHeader = { schemaVersion: 1, kind: "sync-alpha-conformance-failure", status: "failed", mode, phase: "installed-conformance-reference-db", code: "child-failed",
  source: { head: source.commit, tree: source.tree }, candidate: { manifestSha256 } };
test("installed conformance failure retains a strictly sanitized receipt and rethrows the original failure", async () => {
  const fixture = await retentionFixture();
  try {
    const expectFailure = error => { assert.equal(error.code, "child-failed"); assert.equal(error.id, "installed-conformance-reference-db"); assert.doesNotMatch(error.message, /SECRET|hunter2/); return true; };
    const read = async () => { const text = await readFile(fixture.conformanceReportPath, "utf8"); assert.doesNotMatch(text, /hunter2|postgresql|SECRET|c10_secret|candidate"?:\s*\{\s*"root|stack|debug|leaked|cleanupEvidence|free text/);
      assert.equal((await lstat(fixture.conformanceReportPath)).mode & 0o777, 0o600); assert.throws(() => validateConformance(JSON.parse(text), { ...binding, root: fixture.root, expectedCaseIDs: RETENTION_IDS }));
      await rm(fixture.conformanceReportPath); return JSON.parse(text); };
    await assert.rejects(runRetention(fixture, "malicious-valid"), expectFailure);
    assert.deepEqual(await read(), { ...retainedHeader, receipt: "retained", report: { status: "failed", partial: false, errorCode: null,
      totals: { required: 2, recorded: 2, passed: 0, failed: 2 }, results: RETENTION_IDS.map(id => ({ id, status: "failed", durationMs: 12, exitCode: null, skipped: 0, todo: 0,
        errorCode: "child-exit-failed", terminationReason: "timeout", cleanup: { required: true, completed: true } })) } });
    await assert.rejects(runRetention(fixture, "runner-error"), expectFailure);
    assert.deepEqual(await read(), { ...retainedHeader, receipt: "retained", report: { status: "failed", partial: true, errorCode: "conformance-unavailable",
      totals: { required: 2, recorded: 0, passed: 0, failed: 0 }, results: [] } });
    for (const [behavior, receipt] of [["foreign-case", "invalid"], ["bad-status", "invalid"], ["bad-duration", "invalid"], ["wrong-source", "invalid"], ["wrong-digest", "invalid"],
      ["unknown-code", "invalid"], ["garbage", "invalid"], ["oversize", "oversize"], ["no-report", "missing"]]) {
      await assert.rejects(runRetention(fixture, behavior), expectFailure, behavior);
      assert.deepEqual(await read(), { ...retainedHeader, receipt, report: null }, behavior);
    }
    // A failed diagnostic write never masks the original installed-conformance failure.
    await writeFile(fixture.conformanceReportPath, "existing\n");
    await assert.rejects(runRetention(fixture, "malicious-valid"), expectFailure);
    assert.equal(await readFile(fixture.conformanceReportPath, "utf8"), "existing\n"); await rm(fixture.conformanceReportPath);
    // The passing acceptance path and its full receipt are unchanged.
    const passed = await runRetention(fixture, "passed");
    assert.equal(passed.status, "passed"); assert.equal(passed.required, 2); assert.equal(passed.cleanupCompleted, true);
    assert.equal(JSON.parse(await readFile(fixture.conformanceReportPath, "utf8")).kind, "sync-conformance-report");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
test("verifier failure line carries only allowlisted phase and code", async () => {
  const secret = new Error(`database ${SECRET_URL} refused`);
  assert.deepEqual(verifier.verificationErrorRecord(secret), { schemaVersion: 1, kind: "sync-alpha-verification-error", status: "failed", phase: "unclassified", code: "unclassified" });
  const failure = Object.assign(new Error("installed-conformance-reference-db: required process did not complete successfully."), { id: "installed-conformance-reference-db", code: "timeout" });
  assert.deepEqual(verifier.verificationErrorRecord(failure), { schemaVersion: 1, kind: "sync-alpha-verification-error", status: "failed", phase: "installed-conformance-reference-db", code: "timeout" });
  for (const forged of [{ id: SECRET_URL, code: "timeout" }, { id: "installed-conformance-reference-db", code: SECRET_URL }, { id: "installed-conformance-reference-db" }]) {
    const record = verifier.verificationErrorRecord(Object.assign(new Error("x"), forged)); assert.doesNotMatch(JSON.stringify(record), /hunter2/);
    assert.ok(record.phase === "unclassified" || record.code === "unclassified");
  }
  const cli = await new Promise(done => { const child = spawn(process.execPath, [new URL("./verify-sync-alpha.mjs", import.meta.url).pathname, "--mode", SECRET_URL], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", part => { stdout += part; }); child.stderr.on("data", part => { stderr += part; }); child.once("close", code => done({ code, stdout, stderr })); });
  assert.equal(cli.code, 1); assert.equal(cli.stdout, "");
  assert.deepEqual(JSON.parse(cli.stderr), { schemaVersion: 1, kind: "sync-alpha-verification-error", status: "failed", phase: "unclassified", code: "unclassified" });
});
test("failure receipt allowlists cover every installed runner code and termination reason", async () => {
  const runner = await readFile(new URL("./sync-conformance.mjs", import.meta.url), "utf8"), bootstrap = "db-bootstrap-allocation-failed";
  const codes = new Set([...runner.matchAll(/(?:fail|ConformanceError)\("([a-z][a-z-]*)"\)|errorCode(?: \?\?=|:) (?:[^,"]*? : )?"([a-z][a-z-]*)"/g)].map(match => match[1] ?? match[2]));
  assert.ok(codes.size >= 20 && codes.has("child-exit-failed") && codes.has("cleanup-incomplete"));
  assert.deepEqual([...codes, bootstrap].sort(), [...verifier.CONFORMANCE_ERROR_CODES].sort());
  const reasons = /TERMINATION_REASONS = Object\.freeze\((\[[^\]]*\])\)/.exec(runner);
  assert.deepEqual(JSON.parse(reasons[1]), [...common.TERMINATION_REASONS]);
});
