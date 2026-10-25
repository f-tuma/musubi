import assert from "node:assert/strict";
import test from "node:test";
import type { SyncOperationEnvelope } from "@musubi/types";
import { claimedCaldavCreateInput, loadCaldavCreateSuite, parseCaldavCreateSuite, runCaldavCreateScenario, ScenarioFailure } from "./caldav-create";
import { runCli } from "./caldav-create-cli";

const suite = await loadCaldavCreateSuite();
const first = () => structuredClone(suite.scenarios[0]!);
const failure = (code: ScenarioFailure["code"]) => (value: unknown) => value instanceof ScenarioFailure && value.code === code;

test("DAV CREATE JSON uses actual codec, provider, guarded transport and runtime with full expected summaries", async () => {
  const scenario = first(); assert.equal((await runCaldavCreateScenario(scenario)).status, "acked");
  scenario.expected.mutationMarks = 0;
  await assert.rejects(runCaldavCreateScenario(scenario), failure("expectation-mismatch"));
  const retry = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "recover-404-conditional-retry")!);
  assert.deepEqual(retry.methods, ["GET", "PROPFIND", "PUT"]); assert.deepEqual(retry.ifNoneMatch, [null, null, "*"]);
  assert.equal(retry.mutationMarks, 1); assert.equal(retry.sessions, 3);
});

test("unplanned or unconsumed native calls fail independently from caught delivery outcomes", async () => {
  const extra = first(); extra.exchanges.push(structuredClone(extra.exchanges[0]!));
  await assert.rejects(runCaldavCreateScenario(extra), failure("unconsumed-exchange"));
  const unexpected = first(); unexpected.exchanges[0]!.method = "PUT";
  await assert.rejects(runCaldavCreateScenario(unexpected), failure("exchange-mismatch"));
  const missing = first(); missing.exchanges.pop();
  await assert.rejects(runCaldavCreateScenario(missing), failure("exchange-mismatch"));
});

test("broken admitted UID or exact resource target holds before prepare, credentials, DNS and HTTP", async () => {
  for (const mismatch of ["uid", "target"] as const) {
    const scenario = first(); scenario.exchanges = [];
    scenario.expected = { status: "hold", methods: [], urls: [], ifNoneMatch: [], bodyHashes: [], authorized: [], propfindKinds: [], metrics: [], dnsLookups: 0,
      ackKinds: [], finishStatuses: ["hold"], evidence: [], provider: { kind: "not-dispatched", status: null, etag: null, errorCode: null, retry: null, retryAfterMs: null },
      remoteKind: "unobserved", remoteEtag: null, remoteUid: null, remoteUrl: null, remoteDataHash: null, remoteStatus: null, possibleDispatch: false,
      mutationMarks: 0, normalizations: 0, preparations: 0, sessions: 0, projectionPort: "portable", retryAfterMs: null,
      errorCode: mismatch === "uid" ? "operation-envelope-codec-unavailable" : "operation-envelope-binding-mismatch", errorOutcome: "not-written" };
    const claim = structuredClone(claimedCaldavCreateInput(scenario));
    if (mismatch === "uid") {
      const envelope = (claim.payload as { operationEnvelope: SyncOperationEnvelope }).operationEnvelope;
      (envelope.nativePlan.data as { uid: string }).uid = "different";
    } else (claim.nativeTarget as { resourceUrl: string }).resourceUrl = "https://dav.example.test/cal/different.ics";
    const result = await runCaldavCreateScenario(scenario, claim); assert.equal(result.sessions, 0); assert.equal(result.preparations, 0);
  }
});

test("fixture schema rejects executable fields, unknown profiles and incoherent host-projection declarations", () => {
  const legacy = structuredClone(suite.scenarios.find(item => item.id === "extra-uid-existing")!);
  const candidates: unknown[] = [
    { ...suite, schemaVersion: 2 }, { ...suite, module: "do-not-import" }, { ...suite, scenarios: [] },
    { ...suite, scenarios: [first(), first()] }, { ...suite, scenarios: [{ ...first(), script: "do-not-execute" }] },
    { ...suite, scenarios: [{ ...first(), expected: { status: "acked" } }] },
    { ...suite, scenarios: [{ ...first(), recovery: { required: true, possibleDispatch: false } }] },
    { ...suite, scenarios: [{ ...first(), priorProvider: { kind: "uncertain" } }] },
    { ...suite, scenarios: [{ ...first(), collection: "https://other.invalid/" }] },
    { ...suite, scenarios: [{ ...legacy, policy: "reference" }] },
    { ...suite, scenarios: [{ ...legacy, normalize: "throw" }] },
    { ...suite, scenarios: [{ ...legacy, hostProjection: { ...legacy.hostProjection, script: "do-not-execute" } }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], error: "lost-reply" }] }] },
  ];
  let getters = 0;
  const injected = first(); Object.defineProperty(injected.expected, "getter", { enumerable: true, get() { getters++; return true; } });
  candidates.push({ schemaVersion: 1, scenarios: [injected] });
  const rows = [first()]; Object.defineProperty(rows, "0", { enumerable: true, get() { getters++; return first(); } });
  candidates.push({ schemaVersion: 1, scenarios: rows });
  for (const candidate of candidates) assert.throws(() => parseCaldavCreateSuite(candidate), failure("invalid-suite"));
  assert.equal(getters, 0);
});

test("declared existing-host fixture projection is visible and cannot bypass the actual content comparison", async () => {
  const legacy = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "extra-uid-existing")!);
  assert.equal(legacy.projectionPort, "fixture"); assert.equal(legacy.status, "acked"); assert.equal(legacy.normalizations, 1);
  const wrong = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "wrong-host-projection")!);
  assert.equal(wrong.projectionPort, "fixture"); assert.equal(wrong.status, "conflict"); assert.deepEqual(wrong.ackKinds, []);
  const malformed = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "normalizer-before-cancel")!);
  assert.equal(malformed.projectionPort, "throw"); assert.equal(malformed.normalizations, 1); assert.equal(malformed.mutationMarks, 0);
});

test("native acceptance and prior uncertainty survive later failures without same-attempt blind replay", async () => {
  for (const id of ["reference-readback-404", "reference-readback-410", "reference-null-readback"]) {
    const result = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === id)!);
    assert.equal(result.provider.kind, "accepted"); assert.equal(result.evidence[0]!.remoteKind, "unobserved");
    assert.equal(result.methods.filter(method => method === "PUT").length, 1); assert.deepEqual(result.ackKinds, []);
  }
  const uncertain = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "uncertain-retry-412")!);
  assert.equal(uncertain.provider.kind, "uncertain"); assert.equal(uncertain.possibleDispatch, true); assert.deepEqual(uncertain.methods, ["GET", "PROPFIND", "PUT"]);
  const accepted = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "accepted-retry-rate-limit")!);
  assert.equal(accepted.provider.kind, "accepted"); assert.equal(accepted.provider.etag, '"old"'); assert.equal(accepted.retryAfterMs, 2000);
});

test("long derived native URL fixture reaches the actual unchanged v1 decoder and holds with zero ports", async () => {
  const result = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "long-resource-admission-boundary")!);
  assert.equal(result.status, "hold"); assert.equal(result.errorCode, "operation-envelope-malformed");
  assert.equal(result.preparations, 0); assert.equal(result.sessions, 0); assert.equal(result.dnsLookups, 0); assert.deepEqual(result.methods, []);
});

test("a non-UTC TZID without its resource-owned definition cannot establish portable CREATE completion", async () => {
  const result = await runCaldavCreateScenario(suite.scenarios.find(item => item.id === "reference-ambient-tzid-no-definition")!);
  assert.equal(result.status, "conflict"); assert.equal(result.errorCode, "runtime-profile-unavailable");
  assert.equal(result.projectionPort, "portable"); assert.equal(result.normalizations, 1);
  assert.deepEqual(result.methods, ["GET"]); assert.equal(result.mutationMarks, 0); assert.deepEqual(result.ackKinds, []);
});

test("DAV CREATE CLI selects exact IDs and emits only bounded fail-closed diagnostics", async () => {
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  assert.equal(await runCli(["--list", "--json"], write), 0); assert.equal(JSON.parse(lines.pop()!).scenarios.length, suite.scenarios.length);
  assert.equal(await runCli(["--scenario", "recover-matching-create", "--json"], write), 0);
  const selected = JSON.parse(lines.pop()!); assert.equal(selected.suite, "caldav-create"); assert.equal(selected.results.length, 1);
  assert.deepEqual(selected.results[0].summary.methods, ["GET"]);
  for (const args of [["--json", "--scenario", "missing"], ["--json", "--scenario"], ["--json", "--list", "--scenario", "fresh-create"],
    ["--json", "--json"], ["--json", "PRIVATE_ARGUMENT"]]) {
    assert.equal(await runCli(args, write), 1); const line = lines.pop()!;
    assert.ok(JSON.parse(line).error.code); assert.equal(line.includes("PRIVATE_ARGUMENT"), false); assert.ok(line.length < 300);
  }
  assert.equal(lines.length, 0);
});
