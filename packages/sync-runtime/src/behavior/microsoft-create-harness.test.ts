import assert from "node:assert/strict";
import test from "node:test";
import type { SyncOperationEnvelope } from "@musubi/types";
import {
  claimedMicrosoftCreateInput, loadMicrosoftCreateSuite, parseMicrosoftCreateSuite, runMicrosoftCreateScenario, ScenarioFailure,
} from "./microsoft-create";
import { runCli } from "./microsoft-create-cli";

const suite = await loadMicrosoftCreateSuite();
const first = () => structuredClone(suite.scenarios[0]!);
const failure = (code: ScenarioFailure["code"]) => (value: unknown) => value instanceof ScenarioFailure && value.code === code;

test("Graph CREATE scenarios exercise production codec/runtime/provider with complete wire and outcome expectations", async () => {
  const scenario = first();
  assert.equal((await runMicrosoftCreateScenario(scenario)).status, "acked");
  scenario.expected.mutationMarks = 0;
  await assert.rejects(runMicrosoftCreateScenario(scenario), failure("expectation-mismatch"));
  const lost = suite.scenarios.find(item => item.id === "lost-reply-reference")!;
  const result = await runMicrosoftCreateScenario(lost);
  assert.deepEqual(result.methods, ["GET", "GET", "POST", "GET"]);
  assert.equal(result.mutationMarks, 1); assert.equal(result.provider.kind, "uncertain");
  assert.deepEqual(result.evidence.map(fact => fact.remoteKind), ["unobserved", "confirmed"]);
});

test("unexpected or unconsumed HTTP exchanges fail independently of caught runtime errors", async () => {
  const extra = first(); extra.exchanges.push(structuredClone(extra.exchanges[0]!));
  await assert.rejects(runMicrosoftCreateScenario(extra), failure("unconsumed-exchange"));
  const unexpected = first(); unexpected.exchanges[0]!.method = "POST";
  await assert.rejects(runMicrosoftCreateScenario(unexpected), failure("exchange-mismatch"));
  const missing = first(); missing.exchanges.pop();
  await assert.rejects(runMicrosoftCreateScenario(missing), failure("exchange-mismatch"));
});

test("malformed admitted identity stops before credentials and dispatch", async () => {
  for (const mismatch of ["marker", "target"] as const) {
    const scenario = first(); scenario.exchanges = [];
    scenario.expected = { status: "hold", methods: [], paths: [], redirects: [], prefer: [], bodyHashes: [], markers: [], metrics: [],
      ackKinds: [], finishStatuses: ["hold"], evidence: [],
      provider: { kind: "not-dispatched", status: null, eventId: null, etag: null, errorCode: null, retry: null, retryAfterMs: null },
      remoteKind: "unobserved", remoteId: null, remoteEtag: null, remoteHash: null, possibleDispatch: false,
      mutationMarks: 0, normalizations: 0, retryAfterMs: null, errorOutcome: "not-written",
      errorCode: mismatch === "marker" ? "operation-envelope-codec-unavailable" : "operation-envelope-binding-mismatch" };
    const claim = structuredClone(claimedMicrosoftCreateInput(scenario));
    if (mismatch === "marker") {
      const envelope = (claim.payload as { operationEnvelope: SyncOperationEnvelope }).operationEnvelope;
      (envelope.nativePlan.data.body as { transactionId: string }).transactionId = "00000000-0000-4000-8000-000000000072";
    } else (claim.nativeTarget as { calendarId: string }).calendarId = "wrong-calendar";
    assert.equal((await runMicrosoftCreateScenario(scenario, claim)).mutationMarks, 0);
  }
});

test("schema refuses unknown executable fields, contradictory recovery and incomplete assertions", () => {
  const candidates: unknown[] = [
    { ...suite, schemaVersion: 2 }, { ...suite, module: "do-not-import" }, { ...suite, scenarios: [] },
    { ...suite, scenarios: [first(), first()] }, { ...suite, scenarios: [{ ...first(), script: "do-not-execute" }] },
    { ...suite, scenarios: [{ ...first(), expected: { status: "acked" } }] },
    { ...suite, scenarios: [{ ...first(), recovery: { required: false, possibleDispatch: true } }] },
    { ...suite, scenarios: [{ ...first(), priorProvider: { kind: "uncertain" } }] },
    { ...suite, scenarios: [{ ...first(), priorCandidateEventId: "native/event" }] },
    { ...suite, scenarios: [{ ...first(), priorCandidateEventId: "" }] },
    { ...suite, scenarios: [{ ...first(), priorCandidateEventId: { module: "do-not-import" } }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ method: "POST", path: "https://other.invalid", status: 201, body: {} }] }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], error: "lost-reply" }] }] },
  ];
  let getters = 0;
  const injected = first(); Object.defineProperty(injected.exchanges[0]!.body, "getter", { enumerable: true, get() { getters++; return true; } });
  candidates.push({ schemaVersion: 1, scenarios: [injected] });
  const sparse = first(); delete sparse.exchanges[0]; candidates.push({ schemaVersion: 1, scenarios: [sparse] });
  const hidden = first(); Object.defineProperty(hidden.expected.provider, "hidden", { value: true }); candidates.push({ schemaVersion: 1, scenarios: [hidden] });
  for (const candidate of candidates) assert.throws(() => parseMicrosoftCreateSuite(candidate), failure("invalid-suite"));
  assert.equal(getters, 0);
});

test("native acceptance stays separate from failed readback and missing correlation never authorizes resend", async () => {
  for (const id of ["reference-verification-denied", "reference-verification-missing", "reference-readback-strong-etag", "reference-candidate-id-changed", "reference-ignored-text-prefer"]) {
    const result = await runMicrosoftCreateScenario(suite.scenarios.find(item => item.id === id)!);
    assert.equal(result.provider.kind, "accepted"); assert.equal(result.provider.eventId, "native/event");
    assert.equal(result.evidence[0]!.provider.kind, "accepted"); assert.equal(result.evidence[0]!.remoteKind, "unobserved");
    assert.equal(result.methods.filter(method => method === "POST").length, 1); assert.equal(result.ackKinds.length, 0);
  }
  const missing = await runMicrosoftCreateScenario(suite.scenarios.find(item => item.id === "recover-missing-no-repost")!);
  assert.deepEqual(missing.methods, ["GET"]); assert.equal(missing.remoteKind, "missing"); assert.equal(missing.mutationMarks, 0);
});

test("uncertain restart keeps its durable correlated candidate ID without inventing native acceptance", async () => {
  const same = suite.scenarios.find(item => item.id === "restart-uncertain-candidate")!;
  assert.equal(claimedMicrosoftCreateInput(same).priorCandidateEventId, "native/event");
  const recovered = await runMicrosoftCreateScenario(same);
  assert.equal(recovered.status, "acked"); assert.equal(recovered.provider.kind, "uncertain");
  assert.deepEqual(recovered.methods, ["GET"]); assert.equal(recovered.remoteId, "native/event"); assert.equal(recovered.mutationMarks, 0);
  const changed = await runMicrosoftCreateScenario(suite.scenarios.find(item => item.id === "restart-uncertain-candidate-changed")!);
  assert.equal(changed.status, "conflict"); assert.equal(changed.provider.kind, "uncertain");
  assert.equal(changed.remoteId, "other/event"); assert.equal(changed.errorCode, "runtime-creation-identity-changed");
  assert.deepEqual(changed.methods, ["GET"]); assert.equal(changed.mutationMarks, 0); assert.deepEqual(changed.ackKinds, []);
});

test("driver uses the explicit host normalization port before any selected candidate can ACK", async () => {
  const result = await runMicrosoftCreateScenario(suite.scenarios.find(item => item.id === "host-normalizer-failure")!);
  assert.equal(result.normalizations, 1); assert.equal(result.ackKinds.length, 0); assert.equal(result.mutationMarks, 0);
  const raw = await runMicrosoftCreateScenario(suite.scenarios.find(item => item.id === "fresh-empty-etag")!);
  assert.equal(raw.provider.etag, ""); assert.equal(raw.normalizations, 0);
});

test("Graph CREATE CLI lists and selects exact IDs with bounded clean diagnostics", async () => {
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  assert.equal(await runCli(["--list", "--json"], write), 0); assert.equal(JSON.parse(lines.pop()!).scenarios.length, suite.scenarios.length);
  assert.equal(await runCli(["--scenario", "recover-matching-create", "--json"], write), 0);
  const selected = JSON.parse(lines.pop()!); assert.equal(selected.suite, "microsoft-create"); assert.equal(selected.results.length, 1);
  assert.equal(selected.results[0].id, "recover-matching-create"); assert.deepEqual(selected.results[0].summary.methods, ["GET"]);
  for (const args of [["--json", "--scenario", "missing"], ["--json", "--scenario"], ["--json", "--list", "--scenario", "fresh-create"],
    ["--json", "--json"], ["--json", "PRIVATE_ARGUMENT"]]) {
    assert.equal(await runCli(args, write), 1); const line = lines.pop()!;
    assert.ok(JSON.parse(line).error.code); assert.equal(line.includes("PRIVATE_ARGUMENT"), false); assert.ok(line.length < 300);
  }
  assert.equal(lines.length, 0);
});
