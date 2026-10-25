import assert from "node:assert/strict";
import test from "node:test";
import type { SyncOperationEnvelope } from "@musubi/types";
import {
  claimedMicrosoftDeleteInput, loadMicrosoftDeleteSuite, parseMicrosoftDeleteSuite, runMicrosoftDeleteScenario, ScenarioFailure,
  type MicrosoftDeleteSummary,
} from "./microsoft-delete";
import { runCli } from "./microsoft-delete-cli";

const suite = await loadMicrosoftDeleteSuite();
const first = () => structuredClone(suite.scenarios[0]!);
const byId = (id: string) => structuredClone(suite.scenarios.find(item => item.id === id)!);
const failureCode = (code: ScenarioFailure["code"]) => (error: unknown) => error instanceof ScenarioFailure && error.code === code;

test("Graph JSON harness exercises real codec/runtime/provider with exact wires and persisted native facts", async () => {
  const scenario = first(), result = await runMicrosoftDeleteScenario(scenario);
  assert.deepEqual(result.methods, ["GET", "GET", "GET", "GET", "GET", "GET", "GET", "DELETE", "GET"]);
  assert.deepEqual(result.evidence.map(fact => [fact.provider.kind, fact.remoteKind]), [["accepted", "unobserved"], ["accepted", "absent"]]);
  assert.equal((await runMicrosoftDeleteScenario(byId("fresh-reference-delete"))).methods.length, 6);
  const denied = await runMicrosoftDeleteScenario(byId("accepted-verification-denied"));
  assert.equal(denied.provider.kind, "accepted"); assert.equal(denied.errorOutcome, "unconfirmed"); assert.deepEqual(denied.ackKinds, []);
  scenario.expected.mutationMarks = 0;
  await assert.rejects(runMicrosoftDeleteScenario(scenario), failureCode("expectation-mismatch"));
});

test("Graph observe-only and explicit-resolution fixtures distinguish dispatch authority after possible delivery", async () => {
  for (const id of ["lost-reply-restart-present", "rate-limited-restart-present", "resolution-second-attempt-observe"]) {
    const observed = await runMicrosoftDeleteScenario(byId(id));
    assert.deepEqual(observed.methods, ["GET"]); assert.equal(observed.mutationMarks, 0); assert.equal(observed.errorOutcome, "unconfirmed");
  }
  const resolution = await runMicrosoftDeleteScenario(byId("resolution-first-attempt-send")); assert.equal(resolution.mutationMarks, 1);
  const gap = await runMicrosoftDeleteScenario(byId("accepted-read-write-gap"));
  const dispatch = gap.methods.indexOf("DELETE"); assert.equal(gap.ifMatch[dispatch], 'W/"before"');
  assert.equal(gap.dispatchVersions[dispatch], 'W/"concurrent-edit"'); assert.equal(gap.status, "acked");
  const limited = await runMicrosoftDeleteScenario(byId("resolution-uncertain-rate-limit"));
  assert.equal(limited.provider.kind, "uncertain"); assert.equal(limited.provider.retryAfterMs, null);
  assert.equal(limited.retryAfterMs, 2000); assert.equal(limited.possibleDispatch, true); assert.equal(limited.errorOutcome, "not-written");
  assert.equal(limited.methods.filter(method => method === "GET").length, 7);
  assert.equal(limited.methods.filter(method => method === "DELETE").length, 1); assert.deepEqual(limited.ackKinds, []);
});

test("Graph caught transport failures cannot hide unexpected or unconsumed HTTP exchanges", async () => {
  const unconsumed = first(); unconsumed.exchanges.push(structuredClone(unconsumed.exchanges[0]!));
  await assert.rejects(runMicrosoftDeleteScenario(unconsumed), failureCode("unconsumed-exchange"));
  const wrong = first(); wrong.exchanges[0]!.method = "DELETE";
  await assert.rejects(runMicrosoftDeleteScenario(wrong), failureCode("exchange-mismatch"));
  const missing = first(); missing.exchanges.pop();
  await assert.rejects(runMicrosoftDeleteScenario(missing), failureCode("exchange-mismatch"));
});

test("broken admitted Graph binding and unsupported coherent all-day profile are held before any native request", async () => {
  for (const defect of ["target", "all-day"] as const) {
    const scenario = first(); scenario.exchanges = [];
    const expected: MicrosoftDeleteSummary = { status: "hold", methods: [], paths: [], ifMatch: [], prefer: [], dispatchVersions: [],
      ackKinds: [], finishStatuses: ["hold"], evidence: [],
      provider: { kind: "not-dispatched", status: null, errorCode: null, retry: null, retryAfterMs: null },
      remoteKind: "unobserved", remoteEtag: null, remoteStatus: null, possibleDispatch: false, mutationMarks: 0, retryAfterMs: null,
      errorCode: defect === "target" ? "operation-envelope-binding-mismatch" : "operation-envelope-codec-unavailable", errorOutcome: "not-written" };
    scenario.expected = expected;
    const claim = structuredClone(claimedMicrosoftDeleteInput(scenario));
    if (defect === "target") (claim.nativeTarget as { eventId: string }).eventId = "wrong-native-id";
    else {
      const envelope = (claim.payload as { operationEnvelope: SyncOperationEnvelope }).operationEnvelope;
      envelope.admittedProjection.data.isAllDay = true;
      envelope.admittedProjection.data.start = "2026-10-13T00:00:00.000Z";
      envelope.admittedProjection.data.end = "2026-10-13T00:00:00.000Z";
    }
    assert.equal((await runMicrosoftDeleteScenario(scenario, claim)).mutationMarks, 0);
  }
});

test("Graph fixture schema refuses executable fields, unknown versions, incomplete expectations and contradictory recovery", () => {
  const candidates: unknown[] = [
    { ...suite, schemaVersion: 2 }, { ...suite, module: "do-not-import" }, { ...suite, scenarios: [] }, { ...suite, scenarios: [first(), first()] },
    { ...suite, scenarios: [{ ...first(), id: "../escape" }] }, { ...suite, scenarios: [{ ...first(), script: "do-not-execute" }] },
    { ...suite, scenarios: [{ ...first(), expected: { status: "acked" } }] },
    { ...suite, scenarios: [{ ...first(), recovery: { required: true, possibleDispatch: false } }] },
    { ...suite, scenarios: [{ ...first(), priorProvider: { kind: "uncertain" } }] },
    { ...suite, scenarios: [{ ...first(), resolution: { expectedRemoteExists: false, expectedRemoteEtag: 'W/"before"' } }] },
    { ...suite, scenarios: [{ ...first(), attemptNumber: 0 }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ method: "GET", path: "https://example.invalid", status: 200, body: {} }] }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], error: "lost-reply" }] }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], nativeEtagAtDispatch: 'W/"changed"' }] }] },
  ];
  let getters = 0;
  const accessor = first(); Object.defineProperty(accessor.exchanges[0]!.body, "getter", { enumerable: true, get() { getters++; return true; } });
  candidates.push({ schemaVersion: 1, scenarios: [accessor] });
  const hidden = first(); Object.defineProperty(hidden, "hidden", { value: true }); candidates.push({ schemaVersion: 1, scenarios: [hidden] });
  const arrayAccessor = first(); Object.defineProperty(arrayAccessor.exchanges, "0", { enumerable: true, get() { getters++; return {}; } });
  candidates.push({ schemaVersion: 1, scenarios: [arrayAccessor] });
  for (const candidate of candidates) assert.throws(() => parseMicrosoftDeleteSuite(candidate), failureCode("invalid-suite"));
  assert.equal(getters, 0);
});

test("Graph CLI lists and exactly selects scenarios with bounded fail-closed diagnostics", async () => {
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  assert.equal(await runCli(["--list", "--json"], write), 0);
  const inventory = JSON.parse(lines.pop()!); assert.equal(inventory.suite, "microsoft-delete"); assert.equal(inventory.scenarios.length, suite.scenarios.length);
  assert.equal(await runCli(["--scenario", "restart-absent", "--json"], write), 0);
  const selected = JSON.parse(lines.pop()!); assert.equal(selected.results.length, 1); assert.equal(selected.results[0].id, "restart-absent");
  assert.deepEqual(selected.results[0].summary.methods, ["GET"]);
  for (const args of [["--json", "--scenario", "missing"], ["--json", "--scenario"], ["--json", "--list", "--scenario", "fresh-delete"],
    ["--json", "--json"], ["--json", "PRIVATE_ARGUMENT"]]) {
    assert.equal(await runCli(args, write), 1);
    const line = lines.pop()!; assert.ok(JSON.parse(line).error.code); assert.ok(!line.includes("PRIVATE_ARGUMENT")); assert.ok(line.length < 300);
  }
  assert.equal(lines.length, 0);
});
