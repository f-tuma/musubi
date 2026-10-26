import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseArguments, validateManifest, caseIDs, selectCases, decodeJsonReport, decodeModuleReport, ConformanceError } from "../../../scripts/sync-conformance.mjs";
const manifest = JSON.parse(await readFile(new URL("./manifest.v1.json", import.meta.url), "utf8"));
const rejects = (run, code) => assert.throws(run, error => error instanceof ConformanceError && error.code === code);
test("manifest binds exact mode expansion and every declared profile entry", () => {
  validateManifest(manifest);
  for (const mode of ["deterministic", "reference-db", "host-compat"]) assert.deepEqual(caseIDs(manifest.entries.filter(e => e.mode === mode)), manifest.modes[mode].requiredCaseIDs);
  const missing = structuredClone(manifest); missing.entries.splice(0, 1); rejects(() => validateManifest(missing), "invalid-profile-inventory");
  const dropped = structuredClone(manifest); dropped.entries.find(e => e.kind === "json").scenarios.pop(); rejects(() => validateManifest(dropped), "mode-inventory-mismatch");
  const duplicate = structuredClone(manifest); duplicate.entries.push(duplicate.entries[0]); rejects(() => validateManifest(duplicate), "invalid-manifest");
  const emptyProof = structuredClone(manifest), entry = emptyProof.entries.find(e => e.kind === "module");
  entry.requiredNodeCases = []; entry.requiredLogCases = []; entry.requiredCompletionMarkers = []; delete entry.supplemental;
  rejects(() => validateManifest(emptyProof), "missing-assertion-contract");
});
test("portable mode cannot silently select a host-only API file", () => {
  const wrong = structuredClone(manifest); wrong.entries.find(e => e.mode === "deterministic").file = "apps/api/src/sync/engine.test.ts";
  rejects(() => validateManifest(wrong), "portable-host-import");
  const selected = selectCases(manifest, parseArguments(["--mode", "deterministic", "--scenario", "json/google-update/fresh-reference-title-update"]));
  assert.deepEqual(selected.selectedIDs, ["json/google-update/fresh-reference-title-update"]); assert.ok(selected.required.length > 1);
  rejects(() => selectCases(manifest, { mode: "deterministic", scenario: "missing" }), "unknown-scenario");
});
test("JSON proof refuses dropped duplicate skipped and unconsumed inventory", () => {
  const entry = manifest.entries.find(e => e.suite === "google-update"), report = { schemaVersion: 1, suite: entry.suite, durationMs: 1,
    results: entry.scenarios.map(id => ({ id, status: "passed", durationMs: 1 })) };
  assert.equal(decodeJsonReport(JSON.stringify(report), entry).length, entry.scenarios.length);
  const missing = structuredClone(report); missing.results.pop(); rejects(() => decodeJsonReport(JSON.stringify(missing), entry), "incomplete-child-report");
  const duplicate = structuredClone(report); duplicate.results[1] = duplicate.results[0]; rejects(() => decodeJsonReport(JSON.stringify(duplicate), entry), "missing-skipped-child-case");
  const skip = structuredClone(report); skip.results[0].status = "skipped"; rejects(() => decodeJsonReport(JSON.stringify(skip), entry), "missing-skipped-child-case");
  rejects(() => decodeJsonReport("", entry), "invalid-child-report");
});
test("native Node results require a completed module and no skipped TODO or failed cases", () => {
  const entry = manifest.entries.find(e => e.kind === "module" && !e.supplemental), report = { schemaVersion: 1, kind: "sync-conformance-node-result", skipped: 0, todo: 0, failures: 0,
    cases: [{ name: `module-loaded:${entry.id}`, status: "passed", skipped: 0, todo: 0 }], supplemental: [],
    completionMarkers: entry.requiredCompletionMarkers ?? [], passedLogCases: entry.requiredLogCases ?? [] };
  decodeModuleReport(JSON.stringify(report), entry);
  rejects(() => decodeModuleReport(JSON.stringify(report), { ...entry, requiredNodeCases: ["omitted-required-node-case"] }), "missing-required-assertion");
  for (const key of ["skipped", "todo", "failures"]) { const invalid = structuredClone(report); invalid[key] = 1; rejects(() => decodeModuleReport(JSON.stringify(invalid), entry), "missing-skipped-child-case"); }
  const empty = structuredClone(report); empty.cases = []; rejects(() => decodeModuleReport(JSON.stringify(empty), entry), "missing-skipped-child-case");
});
test("paired reference proof cannot omit either foreign-identity or rights assertion", () => {
  const entry = manifest.entries.find(e => e.id === "db/reference/cross-account"), report = { schemaVersion: 1, kind: "sync-conformance-node-result", skipped: 0, todo: 0, failures: 0,
    cases: [{ name: `module-loaded:${entry.id}`, status: "passed", skipped: 0, todo: 0 }], supplemental: [{ schemaVersion: 1, suite: entry.supplemental.suite,
      results: entry.supplemental.caseIDs.map(id => ({ id, status: "passed" })) }] };
  decodeModuleReport(JSON.stringify(report), entry); report.supplemental[0].results.pop(); rejects(() => decodeModuleReport(JSON.stringify(report), entry), "missing-supplemental-proof");
});
test("CLI cannot confuse listing selection duplicate flags and an absent mode", () => {
  for (const args of [[], ["--mode", "deterministic", "--mode", "reference-db"], ["--mode", "deterministic", "--list", "--scenario", "x"], ["--mode", "unknown"]]) rejects(() => parseArguments(args), "invalid-arguments");
});

test("every module rejects a loaded sentinel without its actual assertion evidence", () => {
  for (const entry of manifest.entries.filter(e => e.kind === "module")) {
    const sentinel = { schemaVersion: 1, kind: "sync-conformance-node-result", skipped: 0, todo: 0, failures: 0,
      cases: [{ name: `module-loaded:${entry.id}`, status: "passed", skipped: 0, todo: 0 }], supplemental: [], passedLogCases: [], completionMarkers: [] };
    assert.throws(() => decodeModuleReport(JSON.stringify(sentinel), entry), error => error instanceof ConformanceError &&
      ["missing-required-assertion", "missing-supplemental-proof"].includes(error.code), entry.id);
  }
});
test("expanded causal cases and external packaging names are required individually", () => {
  for (const id of ["unit/sync-runtime/task-causal", "unit/alpha-packaging"]) {
    const entry = manifest.entries.find(e => e.id === id);
    assert.equal(entry.requiredNodeCases.length, id.endsWith("task-causal") ? 48 : 6);
    const report = { schemaVersion: 1, kind: "sync-conformance-node-result", skipped: 0, todo: 0, failures: 0,
      cases: [...entry.requiredNodeCases.map(name => ({ name, status: "passed", skipped: 0, todo: 0 })),
        { name: `module-loaded:${entry.id}`, status: "passed", skipped: 0, todo: 0 }], supplemental: [], passedLogCases: [], completionMarkers: [] };
    decodeModuleReport(JSON.stringify(report), entry); report.cases.splice(0, 1);
    rejects(() => decodeModuleReport(JSON.stringify(report), entry), "missing-required-assertion");
  }
});
test("an omitted side-effect imported runtime test module cannot satisfy index registration", () => {
  const entry = manifest.entries.find(e => e.id === "unit/sync-runtime/index"), group = entry.importedNodeCaseGroups[0];
  assert.equal(entry.importedNodeCaseGroups.length, 6); assert.equal(entry.requiredNodeCases.length, 131);
  const report = { schemaVersion: 1, kind: "sync-conformance-node-result", skipped: 0, todo: 0, failures: 0,
    cases: [...entry.requiredNodeCases.map(name => ({ name, status: "passed", skipped: 0, todo: 0 })),
      { name: `module-loaded:${entry.id}`, status: "passed", skipped: 0, todo: 0 }], supplemental: [], passedLogCases: [], completionMarkers: [] };
  decodeModuleReport(JSON.stringify(report), entry); report.cases = report.cases.filter(c => !group.caseNames.includes(c.name));
  rejects(() => decodeModuleReport(JSON.stringify(report), entry), "missing-required-assertion");
});
test("every source-expanded loop assertion is required even in a module with other literal tests", () => {
  for (const entry of manifest.entries.filter(e => e.sourceExpandedNodeCases?.length)) {
    const report = { schemaVersion: 1, kind: "sync-conformance-node-result", skipped: 0, todo: 0, failures: 0,
      cases: [...entry.requiredNodeCases.map(name => ({ name, status: "passed", skipped: 0, todo: 0 })),
        { name: `module-loaded:${entry.id}`, status: "passed", skipped: 0, todo: 0 }], supplemental: [], passedLogCases: [], completionMarkers: [] };
    decodeModuleReport(JSON.stringify(report), entry);
    report.cases = report.cases.filter(c => c.name !== entry.sourceExpandedNodeCases[0]);
    rejects(() => decodeModuleReport(JSON.stringify(report), entry), "missing-required-assertion");
  }
});
