import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeOwned, installOwnedShutdown } from "../apps/sync-reference/conformance/process-group.mjs";
import { referenceFixture, ReferenceBootstrapError } from "../apps/sync-reference/conformance/database-fixture.mjs";
const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = "apps/sync-reference/conformance/manifest.v1.json";
const MODES = ["deterministic", "reference-db", "host-compat"];
const hex = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const identifier = value => typeof value === "string" && /^[a-z0-9][a-z0-9/_.:-]{0,199}$/.test(value);
const localPath = value => typeof value === "string" && /^[a-zA-Z0-9_./-]+$/.test(value) && !isAbsolute(value) && !value.split("/").some(v => ["", ".", ".."].includes(v));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export class ConformanceError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ConformanceError(code); };
export function parseArguments(args) {
  const result = { mode: undefined, json: false, list: false, report: undefined, candidateRoot: undefined, scenario: undefined }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; if (!["--mode", "--json", "--list", "--report", "--candidate-root", "--scenario"].includes(arg) || seen.has(arg)) fail("invalid-arguments"); seen.add(arg);
    if (["--json", "--list"].includes(arg)) result[arg.slice(2)] = true;
    else { const value = args[++i]; if (!value || value.startsWith("--")) fail("invalid-arguments"); result[{ "--mode": "mode", "--report": "report", "--candidate-root": "candidateRoot", "--scenario": "scenario" }[arg]] = value; }
  }
  if (!MODES.includes(result.mode) || result.list && result.scenario || result.scenario && !identifier(result.scenario)) fail("invalid-arguments");
  return result;
}
export function validateManifest(value) {
  if (value?.schemaVersion !== 1 || value.kind !== "sync-conformance-manifest" || !Array.isArray(value.entries) || !value.entries.length || !Array.isArray(value.profiles) || value.profiles.length !== 10) fail("invalid-manifest");
  const ids = new Set();
  for (const e of value.entries) {
    if (!identifier(e.id) || ids.has(e.id) || !MODES.includes(e.mode) || !["json", "module"].includes(e.kind) || !localPath(e.file) || e.required !== true || !Number.isSafeInteger(e.timeoutMs) || e.timeoutMs < 100 || e.timeoutMs > 300000) fail("invalid-manifest"); ids.add(e.id);
    if (e.kind === "json" && (!localPath(e.corpus) || !Array.isArray(e.scenarios) || !e.scenarios.length || new Set(e.scenarios).size !== e.scenarios.length || e.scenarios.some(id => !/^[a-z][a-z0-9-]{0,79}$/.test(id)) || typeof e.suite !== "string")) fail("invalid-manifest");
    if (e.nodeArgs !== undefined && (!Array.isArray(e.nodeArgs) || e.nodeArgs.some(arg => !["--experimental-test-module-mocks", "--experimental-default-type=module"].includes(arg)))) fail("invalid-manifest");
    if (e.mode === "reference-db" && (e.kind !== "module" || e.cleanup !== "owned-reference-databases")) fail("invalid-manifest");
    for (const key of ["requiredNodeCases", "requiredLogCases", "requiredCompletionMarkers", "sourceExpandedNodeCases"]) if (e[key] !== undefined && (!Array.isArray(e[key]) || new Set(e[key]).size !== e[key].length || e[key].some(v => typeof v !== "string" || !v || v.length > 512))) fail("invalid-manifest");
    if (e.sourceExpandedNodeCases?.some(name => !e.requiredNodeCases?.includes(name))) fail("invalid-manifest");
    if (e.importedNodeCaseGroups !== undefined && (!Array.isArray(e.importedNodeCaseGroups) || e.importedNodeCaseGroups.some(g => !localPath(g.file) || !Array.isArray(g.caseNames) || !g.caseNames.length || g.caseNames.some(name => !e.requiredNodeCases?.includes(name))))) fail("invalid-manifest");
    if (e.kind === "module" && !(e.requiredNodeCases?.length || e.requiredLogCases?.length || e.requiredCompletionMarkers?.length || e.supplemental?.caseIDs?.length)) fail("missing-assertion-contract");
    if (e.requiredCompletionMarkers?.some(v => !/^SYNC_CONFORMANCE_COMPLETE:[a-z0-9/_.:-]{1,199}$/.test(v))) fail("invalid-manifest");
    if (e.mode !== "host-compat" && e.file.startsWith("apps/api/")) fail("portable-host-import");
  }
  const profiles = new Set(), tuples = new Set();
  for (const p of value.profiles) {
    if (!identifier(p.id) || profiles.has(p.id) || !["google", "microsoft", "caldav"].includes(p.provider) || !["event", "task"].includes(p.kind) || !["create", "update", "delete"].includes(p.action) ||
      !Array.isArray(p.requiredEntries) || p.requiredEntries.length < 2 || p.requiredEntries.some(id => !ids.has(id))) fail("invalid-profile-inventory"); profiles.add(p.id); tuples.add(`${p.provider}:${p.kind}:${p.action}`);
  }
  const expected = ["google:event:update", "google:event:create", "google:event:delete", "microsoft:event:create", "microsoft:event:delete", "caldav:event:create", "caldav:event:delete", "google:task:update", "google:task:delete", "google:task:create"];
  if (tuples.size !== expected.length || expected.some(id => !tuples.has(id))) fail("invalid-profile-inventory");
  for (const mode of MODES) if (JSON.stringify(value.modes?.[mode]?.requiredCaseIDs) !== JSON.stringify(caseIDs(value.entries.filter(e => e.mode === mode)))) fail("mode-inventory-mismatch");
  return value;
}
export function caseIDs(entries) { return entries.flatMap(e => e.kind === "json" ? e.scenarios.map(id => `${e.id}/${id}`) : [e.id]); }
export function selectCases(manifest, options) {
  const all = manifest.entries.filter(e => e.mode === options.mode), required = caseIDs(all);
  if (!all.length) fail("empty-mode");
  const selected = options.scenario ? all.flatMap(e => e.kind === "json" ? e.scenarios.includes(options.scenario.slice(e.id.length + 1)) && options.scenario.startsWith(`${e.id}/`) ? [{ ...e, scenarios: [options.scenario.slice(e.id.length + 1)] }] : [] : e.id === options.scenario ? [e] : []) : all;
  if (!selected.length) fail("unknown-scenario"); return { all, selected, required, selectedIDs: caseIDs(selected) };
}
export function decodeJsonReport(output, entry) {
  let value; try { value = JSON.parse(output); } catch { fail("invalid-child-report"); }
  if (value?.schemaVersion !== 1 || value.suite !== entry.suite || value.error || !Array.isArray(value.results) || value.results.length !== entry.scenarios.length || !Number.isFinite(value.durationMs) || value.durationMs < 0) fail("incomplete-child-report");
  return entry.scenarios.map(id => {
    const matches = value.results.filter(r => r?.id === id); const r = matches[0];
    if (matches.length !== 1 || !["passed", "failed"].includes(r.status) || !Number.isFinite(r.durationMs) || r.durationMs < 0 || r.skipped || r.todo) fail("missing-skipped-child-case");
    return { id: `${entry.id}/${id}`, status: r.status, durationMs: r.durationMs, exitCode: 0, skipped: 0, todo: 0, cleanup: null };
  });
}
export function decodeModuleReport(output, entry) {
  let value; try { value = JSON.parse(output); } catch { fail("invalid-child-report"); }
  if (value?.schemaVersion !== 1 || value.kind !== "sync-conformance-node-result" || !Array.isArray(value.cases) || !value.cases.length || value.skipped !== 0 || value.todo !== 0 || value.failures !== 0 ||
    value.cases.some(c => !c || typeof c.name !== "string" || c.status !== "passed" || c.skipped !== 0 || c.todo !== 0) || value.cases.filter(c => c.name === `module-loaded:${entry.id}`).length !== 1) fail("missing-skipped-child-case");
  if ((entry.requiredLogCases?.length && !Array.isArray(value.passedLogCases)) || (entry.requiredCompletionMarkers?.length && !Array.isArray(value.completionMarkers))) fail("missing-required-assertion");
  if ((entry.requiredNodeCases ?? []).some(name => !value.cases.some(c => c.name === name && c.status === "passed")) ||
    (entry.requiredLogCases ?? []).some(name => !value.passedLogCases?.includes(name)) ||
    (entry.requiredCompletionMarkers ?? []).some(name => value.completionMarkers?.filter(marker => marker === name).length !== 1)) fail("missing-required-assertion");
  if (entry.supplemental) {
    const proof = Array.isArray(value.supplemental) ? value.supplemental.filter(item => item?.suite === entry.supplemental.suite) : []; if (proof?.length !== 1) fail("missing-supplemental-proof");
    const results = proof[0].results;
    if (!Array.isArray(results) || results.length !== entry.supplemental.caseIDs.length || entry.supplemental.caseIDs.some(id => results.filter(r => r.id === id && r.status === "passed").length !== 1)) fail("missing-supplemental-proof");
  }
  return value;
}
export function failedEntryResults(entry, error, durationMs) {
  const bootstrap = error instanceof ReferenceBootstrapError;
  return caseIDs([entry]).map(id => ({ id, status: "failed", durationMs, exitCode: null, skipped: 0, todo: 0,
    cleanup: bootstrap ? error.cleanup : null,
    ...(bootstrap ? { cleanupEvidence: error.cleanupEvidence } : {}),
    errorCode: error instanceof ConformanceError || bootstrap ? error.code : "entry-unavailable" }));
}
export const execute = executeOwned;

async function resolveFile(root, path) { if (!localPath(path)) fail("invalid-file-path"); let actual; try { actual = await realpath(resolve(root, path)); } catch { fail("missing-required-file"); }
  const local = relative(await realpath(root), actual); if (!local || local.startsWith("..") || isAbsolute(local)) fail("source-symlink-escape"); return actual; }
async function identity(root, candidateRoot, run) {
  if (candidateRoot) {
    const candidateBytes = await readFile(join(candidateRoot, "candidate.json")), candidate = JSON.parse(candidateBytes); const head = candidate.source?.head ?? candidate.source?.commit, tree = candidate.source?.tree;
    if (!hex(head) || !hex(tree) || await realpath(root) !== await realpath(join(candidateRoot, "conformance"))) fail("candidate-identity-mismatch");
    return { source: { head, tree }, archiveSha256: candidate.source?.archiveSha256, candidateManifestSha256: hash(candidateBytes) };
  }
  const child = await run("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10000 });
  const [head, tree] = child.stdout.trim().split("\n"); const status = await run("git", ["status", "--porcelain"], { cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10000 });
  if (child.exitCode !== 0 || status.exitCode !== 0 || !hex(head) || !hex(tree) || status.stdout.trim()) fail("unclean-source-identity"); return { source: { head, tree } };
}

async function runCorpus(options, { root = SOURCE_ROOT, run = execute, env = process.env, identify = identity, shutdown } = {}) {
  const bytes = await readFile(await resolveFile(root, MANIFEST)), manifest = validateManifest(JSON.parse(bytes));
  const selection = selectCases(manifest, options), bound = await identify(root, options.candidateRoot ? resolve(options.candidateRoot) : undefined, run);
  for (const entry of selection.all) { await resolveFile(root, entry.file); for (const group of entry.importedNodeCaseGroups ?? []) await resolveFile(root, group.file); if (entry.kind === "json") {
    const corpus = JSON.parse(await readFile(await resolveFile(root, entry.corpus), "utf8"));
    if (corpus.schemaVersion !== 1 || !Array.isArray(corpus.scenarios) || JSON.stringify(corpus.scenarios.map(s => s.id)) !== JSON.stringify(entry.scenarios)) fail("corpus-inventory-mismatch");
  } }
  const report = { schemaVersion: 1, kind: "sync-conformance-report", mode: options.mode, source: bound.source, candidate: { root: resolve(options.candidateRoot ?? root), manifestSha256: bound.candidateManifestSha256 ?? hash(bytes), ...(bound.archiveSha256 ? { archiveSha256: bound.archiveSha256 } : {}) },
    inventory: { requiredCaseIDs: selection.required, selectedCaseIDs: selection.selectedIDs }, results: [], totals: { required: selection.required.length, selected: selection.selectedIDs.length, passed: 0, failed: 0, skipped: 0, todo: 0 },
    status: options.list ? "listed" : "passed", partial: selection.required.length !== selection.selectedIDs.length, installedRuntime: false, liveProvider: false, deployed: false };
  if (options.list) return report;
  for (const entry of selection.selected) {
    if (shutdown.interrupted) { for (const id of caseIDs([entry])) report.results.push({ id, status: "failed", durationMs: 0, exitCode: null, skipped: 0, todo: 0, cleanup: null, errorCode: "runner-interrupted" }); continue; }
    const started = performance.now(), directory = await mkdtemp(join(tmpdir(), "sync-conformance-")); let fixture, results, cleanup = null;
    try {
      const childEnv = { PATH: env.PATH, ...(env.HOME ? { HOME: env.HOME } : {}), SYNC_CONFORMANCE_SOURCE_ROOT: root, SYNC_CONFORMANCE_MODULE: entry.file, SYNC_CONFORMANCE_CASE_ID: entry.id };
      if (entry.mode === "reference-db") { fixture = await referenceFixture(env, directory); Object.assign(childEnv, fixture.env); }
      if (entry.mode === "host-compat") for (const key of ["ENVIRONMENT", "DATABASE_URL", "REFERENCE_DATABASE_URL"]) if (env[key] !== undefined) childEnv[key] = env[key];
      if (shutdown.interrupted) fail("runner-interrupted");
      const flags = [...(entry.nodeArgs ?? [])];
      if (entry.mode === "host-compat" && !flags.includes("--experimental-test-module-mocks")) flags.unshift("--experimental-test-module-mocks");
      const launch = [...flags, "--import", "tsx", ...(entry.mode === "host-compat" ? ["--import", pathToFileURL(await resolveFile(root, "apps/api/src/sync/behavior/host-fixture-preload.mjs")).href] : [])];
      const args = entry.kind === "json" ? [...launch, resolve(root, entry.file), "--json", ...(options.scenario ? ["--scenario", entry.scenarios[0]] : [])] :
        [...launch, "--test", `--test-reporter=${pathToFileURL(resolve(root, "apps/sync-reference/conformance/node-reporter.mjs")).href}`, resolve(root, "apps/sync-reference/conformance/module.mjs")];
      const child = await run(process.execPath, args, { cwd: root, env: childEnv, timeoutMs: entry.timeoutMs });
      if (child.exitCode !== 0 || child.groupReaped !== true) fail("child-exit-failed");
      if (entry.kind === "json") results = decodeJsonReport(child.stdout, entry);
      else { decodeModuleReport(child.stdout, entry); results = [{ id: entry.id, status: "passed", durationMs: Math.round(performance.now() - started), exitCode: child.exitCode, skipped: 0, todo: 0, cleanup: null }]; }
    } catch (error) { results = failedEntryResults(entry, error, Math.round(performance.now() - started)); if (error instanceof ReferenceBootstrapError) cleanup = error.cleanup; }
    finally {
      try { if (fixture) cleanup = await fixture.cleanup(); } catch { cleanup = { required: true, completed: false }; }
      try { const facts = JSON.parse(await readFile(join(directory, "cleanup-facts.json"), "utf8")); for (const result of results ?? []) result.cleanupEvidence = facts; } catch { /* Missing evidence never turns a failed cleanup into PASS. */ }
      await rm(directory, { recursive: true, force: true });
    }
    for (const result of results) { if (cleanup) { result.cleanup = cleanup; if (!cleanup.completed) { result.status = "failed"; result.errorCode ??= "cleanup-incomplete"; } } report.results.push(result); }
  }
  report.totals.passed = report.results.filter(r => r.status === "passed").length; report.totals.failed = report.results.filter(r => r.status === "failed").length;
  if (report.results.length !== report.totals.selected || report.totals.failed) report.status = "failed";
  if (shutdown.interrupted) { report.status = "failed"; return report; }
  const after = await identify(root, options.candidateRoot ? resolve(options.candidateRoot) : undefined, run);
  if (JSON.stringify(after.source) !== JSON.stringify(bound.source) || after.candidateManifestSha256 !== bound.candidateManifestSha256 || hash(await readFile(resolve(root, MANIFEST))) !== hash(bytes)) fail("source-changed-during-run");
  return report;
}
export async function runConformance(options, dependencies = {}) {
  const shutdown = installOwnedShutdown();
  try { return await runCorpus(options, { ...dependencies, shutdown }); }
  finally { shutdown.dispose(); }
}
export async function main(args) {
  let options, report;
  try { options = parseArguments(args); report = await runConformance(options); }
  catch (error) { report = { schemaVersion: 1, kind: "sync-conformance-report", status: "failed", errorCode: error instanceof ConformanceError ? error.code : "conformance-unavailable", partial: true, installedRuntime: false, liveProvider: false, deployed: false }; }
  if (options?.report) await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(options?.json || args.includes("--json") ? `${JSON.stringify(report)}\n` : `${report.status}: ${report.totals?.passed ?? 0}/${report.totals?.selected ?? 0} selected cases\n`);
  return report.status === "failed" ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
