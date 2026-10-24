import assert from "node:assert/strict";
import test from "node:test";
import type { SyncOperationEnvelope } from "@musubi/types";
import { claimedCreateInput, loadCreateSuite, parseCreateSuite, runCreateScenario, ScenarioFailure } from "./google-create";
import { runCli } from "./create-cli";

const suite = await loadCreateSuite();
const first = () => structuredClone(suite.scenarios[0]!);
const failureCode = (code: ScenarioFailure["code"]) => (error: unknown) => error instanceof ScenarioFailure && error.code === code;

test("CREATE JSON scenarios exercise actual codec/runtime/provider behavior and complete expectations", async () => {
  const scenario = first();
  assert.equal((await runCreateScenario(scenario)).status, "acked");
  scenario.expected.mutationMarks = 0;
  await assert.rejects(runCreateScenario(scenario), failureCode("expectation-mismatch"));
  const lost = suite.scenarios.find(item => item.id === "lost-reply-reference")!;
  const result = await runCreateScenario(lost);
  assert.deepEqual(result.methods, ["GET", "POST", "GET"]);
  assert.equal(result.mutationMarks, 1);
  assert.equal(result.provider.kind, "uncertain");
});

test("CREATE driver rejects unexpected or unconsumed calls even when the runtime catches transport errors", async () => {
  const unconsumed = first(); unconsumed.exchanges.push(structuredClone(unconsumed.exchanges[0]!));
  await assert.rejects(runCreateScenario(unconsumed), failureCode("unconsumed-exchange"));
  const unexpected = first(); unexpected.exchanges[0]!.method = "POST";
  await assert.rejects(runCreateScenario(unexpected), failureCode("exchange-mismatch"));
  const missing = first(); missing.exchanges.pop();
  await assert.rejects(runCreateScenario(missing), failureCode("exchange-mismatch"));
});

test("broken admitted CREATE identity is held before any provider calls", async () => {
  for (const mismatch of ["marker", "target"] as const) {
    const scenario = first();
    scenario.exchanges = [];
    scenario.expected = { status: "hold", methods: [], bodyIds: [], markers: [], ackKinds: [], finishStatuses: ["hold"],
      provider: { kind: "not-dispatched", validator: null, errorCode: null, retry: null, retryAfterMs: null },
      remoteKind: "unobserved", possibleDispatch: false, mutationMarks: 0, retryAfterMs: null,
      errorCode: mismatch === "marker" ? "operation-envelope-codec-unavailable" : "operation-envelope-binding-mismatch" };
    const claim = structuredClone(claimedCreateInput(scenario));
    if (mismatch === "marker") {
      const envelope = (claim.payload as { operationEnvelope: SyncOperationEnvelope }).operationEnvelope;
      const body = envelope.nativePlan.data.body as { extendedProperties: { private: { musubiOperationID: string } } };
      body.extendedProperties.private.musubiOperationID = "00000000-0000-4000-8000-000000000072";
    } else (claim.nativeTarget as { eventId: string }).eventId = "wrong-native-id";
    assert.equal((await runCreateScenario(scenario, claim)).mutationMarks, 0);
  }
});

test("CREATE schema rejects unsupported versions, unknown fields, incomplete assertions and contradictory recovery", () => {
  const cases: unknown[] = [
    { ...suite, schemaVersion: 2 }, { ...suite, module: "do-not-import" }, { ...suite, scenarios: [] },
    { ...suite, scenarios: [first(), first()] }, { ...suite, scenarios: [{ ...first(), script: "do-not-execute" }] },
    { ...suite, scenarios: [{ ...first(), expected: { status: "acked" } }] },
    { ...suite, scenarios: [{ ...first(), recovery: { required: true, possibleDispatch: false } }] },
    { ...suite, scenarios: [{ ...first(), priorProvider: "uncertain" }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ method: "GET", path: "https://example.invalid", status: 200, body: {} }] }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], error: "lost-reply" }] }] },
  ];
  let getters = 0;
  const injected = first();
  Object.defineProperty(injected.exchanges[0]!.body, "getter", { enumerable: true, get() { getters++; return true; } });
  cases.push({ schemaVersion: 1, scenarios: [injected] });
  for (const candidate of cases) assert.throws(() => parseCreateSuite(candidate), failureCode("invalid-suite"));
  assert.equal(getters, 0);
});

test("CREATE CLI lists and exactly selects scenarios, with bounded fail-closed diagnostics", async () => {
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  assert.equal(await runCli(["--list", "--json"], write), 0);
  assert.equal(JSON.parse(lines.pop()!).scenarios.length, suite.scenarios.length);
  assert.equal(await runCli(["--scenario", "recover-matching-create", "--json"], write), 0);
  const selected = JSON.parse(lines.pop()!);
  assert.equal(selected.suite, "google-create"); assert.equal(selected.results.length, 1);
  assert.equal(selected.results[0].id, "recover-matching-create"); assert.deepEqual(selected.results[0].summary.methods, ["GET"]);
  for (const args of [["--json", "--scenario", "missing"], ["--json", "--scenario"], ["--json", "--list", "--scenario", "fresh-create"],
    ["--json", "--json"], ["--json", "PRIVATE_ARGUMENT"]]) {
    assert.equal(await runCli(args, write), 1);
    const line = lines.pop()!;
    assert.ok(JSON.parse(line).error.code); assert.equal(line.includes("PRIVATE_ARGUMENT"), false); assert.ok(line.length < 300);
  }
  assert.equal(lines.length, 0);
});
