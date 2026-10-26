import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PINS, WORKSPACES, canonicalNewPath, cleanEnvironment, execute, files, inside, loadTool, parseArguments,
  readJson, requiredCases, requireThat, sha256, writeJson } from "./sync-alpha-common.mjs";

const TOOL_ROOT = fileURLToPath(new URL("../", import.meta.url));
export function validateConformance(report, { mode, manifest, manifestSha256, root, expectedCaseIDs }) {
  requireThat(report?.schemaVersion === 1 && report.kind === "sync-conformance-report" && report.mode === mode && report.status === "passed" && report.partial === false,
    "Required full installed conformance did not pass.");
  requireThat(report.source?.head === manifest.source.commit && report.source.tree === manifest.source.tree && report.candidate?.root === root &&
    report.candidate.manifestSha256 === manifestSha256, "Conformance source/candidate binding differs.");
  requireThat(report.installedRuntime === false && report.liveProvider === false && report.deployed === false, "Conformance overstates its evidence boundary.");
  const required = report.inventory?.requiredCaseIDs, selected = report.inventory?.selectedCaseIDs, results = report.results;
  const ids = value => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === "string" && /^[a-z0-9][a-z0-9/_.:-]{0,199}$/.test(id)) && new Set(value).size === value.length;
  requireThat(ids(required) && ids(selected) && JSON.stringify([...required].sort()) === JSON.stringify([...selected].sort()), "Required/selected case inventory differs.");
  requireThat(ids(expectedCaseIDs) && JSON.stringify([...required].sort()) === JSON.stringify([...expectedCaseIDs].sort()), "Receipt omits installed manifest cases.");
  requireThat(Array.isArray(results) && results.length === required.length && new Set(results.map(value => value?.id)).size === required.length, "Conformance result inventory differs.");
  for (const result of results) {
    requireThat(required.includes(result.id) && result.status === "passed" && result.exitCode === 0 && result.skipped === 0 && result.todo === 0 &&
      Number.isFinite(result.durationMs) && result.durationMs >= 0, "Conformance has missing, skipped, TODO or failed cases.");
    requireThat(result.cleanup === null || typeof result.cleanup?.required === "boolean" && typeof result.cleanup.completed === "boolean" &&
      (!result.cleanup.required || result.cleanup.completed), "Required conformance cleanup is incomplete.");
    requireThat(mode !== "reference-db" || result.cleanup?.required === true && result.cleanup.completed === true, "Reference DB case omitted its required cleanup receipt.");
  }
  requireThat(report.totals?.required === required.length && report.totals.selected === required.length && report.totals.passed === required.length &&
    report.totals.failed === 0 && report.totals.skipped === 0 && report.totals.todo === 0, "Conformance totals do not reconcile.");
  return { required: required.length, passed: required.length, cleanupCompleted: true };
}
const CONSUMER = `import assert from "node:assert/strict";
import * as runtime from "@musubi/sync-runtime";
import * as google from "@musubi/provider-google";
import * as microsoft from "@musubi/provider-microsoft";
import * as caldav from "@musubi/provider-caldav";
import * as codec from "@musubi/sync-codec";
import { SyncOperationEnvelopeSchema } from "@musubi/types";
const leaf: runtime.BudgetLeaf = { scopes: [], purpose: "pull", method: "GET", targetKey: "external-consumer", incarnationKey: "synthetic" };
assert.equal(typeof runtime.createFairWorkCoordinator, "function");
assert.equal(typeof runtime.createProviderBudget, "function");
assert.equal(typeof runtime.runClaimedGooglePersonalUpdate, "function");
for (const value of [google, microsoft, caldav, codec]) assert(Object.keys(value).length > 0);
assert.equal(SyncOperationEnvelopeSchema.safeParse({}).success, false);
assert.equal(leaf.purpose, "pull");
console.log(JSON.stringify({ schemaVersion: 1, kind: "sync-alpha-external-consumer", status: "passed", packages: 6 }));
`;
export async function verifySyncAlpha(args) {
  const options = parseArguments(args, ["--candidate", "--mode", "--report"]), mode = options["--mode"] ?? "artifact";
  requireThat(["artifact", "deterministic", "reference-db"].includes(mode), "Choose artifact, deterministic or reference-db verification.");
  requireThat(typeof options["--candidate"] === "string" && isAbsolute(options["--candidate"]), "An absolute installed candidate is required.");
  requireThat(typeof options["--report"] === "string" && isAbsolute(options["--report"]), "An absolute new report path is required.");
  const root = await realpath(options["--candidate"]), forbiddenRoots = [root, TOOL_ROOT];
  const reportPath = await canonicalNewPath(options["--report"], forbiddenRoots);
  const conformanceReportPath = await canonicalNewPath(`${reportPath}.conformance.json`, forbiddenRoots);
  const manifestBytes = await readFile(join(root, "candidate.json")), manifest = JSON.parse(manifestBytes), manifestSha256 = sha256(manifestBytes);
  requireThat(manifest.schemaVersion === 1 && manifest.kind === "musubi-sync-private-alpha" && manifest.distribution === "private-local-review-candidate" &&
    manifest.publicReleaseApproved === false, "Invalid private candidate manifest.");
  requireThat(/^[a-f0-9]{40}$/.test(manifest.source?.commit) && /^[a-f0-9]{40}$/.test(manifest.source?.tree) && /^[a-f0-9]{64}$/.test(manifest.source?.archiveSha256), "Invalid candidate source identity.");
  requireThat(process.versions.node.split(".")[0] === String(PINS.nodeMajor) && manifest.runtime.nodeMajor === PINS.nodeMajor &&
    manifest.runtime.platform === process.platform && manifest.runtime.architecture === process.arch && manifest.runtime.tsx === PINS.tsx && manifest.runtime.typescript === PINS.typescript,
    "Installed candidate requires its declared Node 22/OS/architecture and exact TSX/TypeScript pins.");
  requireThat(manifest.fileInventory === "provenance/files.json" && manifest.packageInventory === "provenance/installed-packages.json", "Unsupported artifact inventory paths.");
  const inventory = await readJson(join(root, manifest.fileInventory));
  requireThat(Array.isArray(inventory) && sha256(Buffer.from(JSON.stringify(inventory))) === manifest.payloadDigest, "Candidate payload digest differs.");
  const current = (await files(root)).filter(entry => !["candidate.json", "provenance/files.json"].includes(entry.path));
  requireThat(JSON.stringify(current) === JSON.stringify(inventory), "Installed candidate bytes/modes/symlinks differ from packaged inventory.");
  const packageInventory = await readJson(join(root, manifest.packageInventory));
  requireThat(Array.isArray(packageInventory) && packageInventory.length > 0, "Installed package/license inventory is missing.");
  for (const item of packageInventory) {
    requireThat(typeof item.path === "string" && !isAbsolute(item.path) && inside(root, resolve(root, item.path)), "Invalid installed package path.");
    const bytes = await readFile(join(root, item.path)), value = JSON.parse(bytes);
    requireThat(sha256(bytes) === item.manifestSha256 && value.name === item.name && (value.version ?? null) === item.version && Array.isArray(item.licenses) && item.licenses.length > 0,
      "Installed package/license identity differs.");
    for (const license of item.licenses) requireThat(/^[a-f0-9]{64}$/.test(license.sha256) && license.text === `licenses/${license.sha256}.txt` &&
      sha256(await readFile(join(root, "provenance", license.text))) === license.sha256, "Collected installed license text differs.");
  }
  requireThat(sha256(await readFile(join(root, "provenance/source.tar"))) === manifest.source.archiveSha256, "Exact git source archive differs.");
  const runtime = join(root, "runtime"), conformance = join(root, "conformance"), tooling = join(root, "tooling"), checks = [];
  requireThat((await readJson(join(runtime, "package.json"))).private === true && (await readJson(join(runtime, "node_modules/tsx/package.json"))).version === PINS.tsx &&
    (await readJson(join(tooling, "node_modules/typescript/package.json"))).version === PINS.typescript, "Installed private runtime/tool pins differ.");
  const work = await mkdtemp(join(tmpdir(), "sync-alpha-verify-"));
  try {
    const consumer = join(work, "consumer"); await mkdir(join(consumer, "node_modules/@musubi"), { recursive: true });
    const env = await cleanEnvironment(join(work, "environment"));
    await writeJson(join(consumer, "package.json"), { private: true, type: "module" }); await writeFile(join(consumer, "consumer.ts"), CONSUMER, { flag: "wx" });
    for (const name of WORKSPACES) await symlink(join(runtime, "node_modules/@musubi", name), join(consumer, "node_modules/@musubi", name), "dir");
    const imported = await execute("external-consumer-import", process.execPath, ["--import", loadTool(runtime, "tsx"), join(consumer, "consumer.ts")], { cwd: consumer, env });
    const importResult = JSON.parse(imported.stdout.toString("utf8"));
    requireThat(importResult.schemaVersion === 1 && importResult.kind === "sync-alpha-external-consumer" && importResult.status === "passed" && importResult.packages === 6, "External package import did not return its required receipt.");
    checks.push({ id: imported.id, status: "passed" });
    await execute("external-consumer-typecheck", process.execPath, [loadTool(tooling, "typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--esModuleInterop",
      "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--lib", "ES2022,DOM", "--types", "node", "--typeRoots", join(tooling, "node_modules/@types"), join(consumer, "consumer.ts")], { cwd: consumer, env });
    checks.push({ id: "external-consumer-typecheck", status: "passed" });
    const cli = await execute("installed-cli-no-ambient-config", process.execPath, ["--import", loadTool(runtime, "tsx"), join(runtime, "src/cli.ts"), "show"],
      { cwd: consumer, env, input: "{}", expectedCode: 1 });
    requireThat(cli.stdout.length === 0 && cli.stderr.toString("utf8").trim() === '{"status":"hold","code":"command-failed"}', "CLI did not refuse missing own configuration predictably.");
    checks.push({ id: cli.id, status: "passed" });
    // No source checkout, dotenv, product DB/session/config variables or Node loader overrides are forwarded.
    let conformanceResult = { mode, status: "not-run" };
    if (mode !== "artifact") {
      const receipt = join(work, "conformance-report.json"), executionEnv = { ...env };
      if (mode === "reference-db") {
        const url = process.env.REFERENCE_DATABASE_URL, key = process.env.REFERENCE_CREDENTIAL_KEY;
        requireThat(typeof url === "string" && url && typeof key === "string" && key && process.env.ENVIRONMENT === "test", "Explicit disposable reference DB/key and test safety marker are required.");
        requireThat(["postgres:", "postgresql:"].includes(new URL(url).protocol), "Reference database URL must be PostgreSQL.");
        Object.assign(executionEnv, { REFERENCE_DATABASE_URL: url, REFERENCE_CREDENTIAL_KEY: key, ENVIRONMENT: "test" });
      }
      await execute(`installed-conformance-${mode}`, process.execPath, [join(conformance, "scripts/sync-conformance.mjs"), "--mode", mode, "--candidate-root", root, "--json", "--report", receipt],
        { cwd: conformance, env: executionEnv, timeoutMs: mode === "reference-db" ? 1_800_000 : 900_000, terminationGraceMs: 8000 });
      const report = await readJson(receipt);
      requireThat(manifest.conformance?.manifest === "apps/sync-reference/conformance/manifest.v1.json", "Unsupported installed conformance path.");
      const corpusPath = join(conformance, manifest.conformance.manifest);
      requireThat(sha256(await readFile(corpusPath)) === manifest.conformance.manifestSha256, "Installed conformance manifest differs.");
      const expectedCaseIDs = requiredCases(await readJson(corpusPath), mode);
      conformanceResult = { mode, status: "passed", ...validateConformance(report, { mode, manifest, manifestSha256, root, expectedCaseIDs }), receiptSha256: sha256(await readFile(receipt)) };
      // Retain the sanitized named-case receipt rather than raw DB URLs, provider payloads or subprocess output.
      await writeJson(conformanceReportPath, report);
    }
    const after = (await files(root)).filter(entry => !["candidate.json", "provenance/files.json"].includes(entry.path));
    requireThat(JSON.stringify(after) === JSON.stringify(inventory) && sha256(await readFile(join(root, "candidate.json"))) === manifestSha256,
      "Installed candidate changed during verification.");
    const report = { schemaVersion: 1, kind: "sync-alpha-verification", status: "passed", source: manifest.source,
      candidate: { payloadDigest: manifest.payloadDigest, manifestSha256 }, runtime: { node: process.version, tsx: PINS.tsx, typescript: PINS.typescript, platform: process.platform, architecture: process.arch },
      checks, artifactFiles: current.length, installedPackageEntries: packageInventory.length, cleanHomeAndCwd: true, ambientMusubiEnvironment: false,
      conformance: conformanceResult, hostCompatibility: "not-run", liveProvider: "not-run", deployed: "not-established", publicPublication: "not-performed" };
    await writeJson(reportPath, report); return report;
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) verifySyncAlpha(process.argv.slice(2)).then(
  report => process.stdout.write(`${JSON.stringify(report)}\n`), () => { process.stderr.write('{"schemaVersion":1,"kind":"sync-alpha-verification-error","status":"failed"}\n'); process.exitCode = 1; });
