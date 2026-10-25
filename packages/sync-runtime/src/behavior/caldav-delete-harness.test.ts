import assert from "node:assert/strict";
import test from "node:test";
import type { SyncOperationEnvelope } from "@musubi/types";
import {
  claimedCaldavDeleteInput, loadCaldavDeleteSuite, parseCaldavDeleteSuite, runCaldavDeleteScenario, ScenarioFailure, type CaldavDeleteSummary,
} from "./caldav-delete";
import { runCli } from "./caldav-delete-cli";

const suite = await loadCaldavDeleteSuite(), first = () => structuredClone(suite.scenarios[0]!);
const byId = (id: string) => structuredClone(suite.scenarios.find(item => item.id === id)!);
const failureCode = (code: ScenarioFailure["code"]) => (error: unknown) => error instanceof ScenarioFailure && error.code === code;

test("conditional DAV DELETE preserves older native facts through a later known refusal or lost reply", async () => {
  const limited = await runCaldavDeleteScenario(byId("uncertain-retry-rate-limit"));
  assert.equal(limited.provider.kind, "uncertain"); assert.equal(limited.provider.retryAfterMs, null);
  assert.equal(limited.retryAfterMs, 2000); assert.equal(limited.errorOutcome, "not-written");
  const lost = await runCaldavDeleteScenario(byId("accepted-retry-lost-reply"));
  assert.equal(lost.provider.kind, "accepted"); assert.equal(lost.provider.status, 204);
  assert.equal(lost.evidence.at(-1)!.provider.kind, "accepted"); assert.equal(lost.errorOutcome, "unconfirmed");
  assert.equal(lost.possibleDispatch, true); assert.equal(lost.methods.filter(method => method === "DELETE").length, 1);
});

test("DAV JSON harness runs actual codec/runtime/transport with complete native wire and evidence expectations", async () => {
  const scenario = first(), observed = await runCaldavDeleteScenario(scenario);
  assert.deepEqual(observed.methods, ["GET", "PROPFIND", "GET", "DELETE"]); assert.equal(observed.dnsLookups, 4);
  assert.deepEqual(observed.ackKinds, ["provider-response"]); assert.equal(observed.provider.kind, "accepted");
  assert.equal((await runCaldavDeleteScenario(byId("owned-organizer-delete"))).methods.length, 6);
  const reference = await runCaldavDeleteScenario(byId("reference-exact-absence"));
  assert.deepEqual(reference.evidence.map(fact => [fact.provider.kind, fact.remoteKind]), [["accepted", "unobserved"], ["accepted", "absent"]]);
  scenario.expected.mutationMarks = 0;
  await assert.rejects(runCaldavDeleteScenario(scenario), failureCode("expectation-mismatch"));
});

test("DAV uncertainty replays only the admitted conditional target and never fabricates native acceptance", async () => {
  const replay = await runCaldavDeleteScenario(byId("uncertain-conditional-replay"));
  assert.equal(replay.methods.filter(method => method === "DELETE").length, 1); assert.equal(replay.ifMatch.at(-1), '"before"');
  const absent = await runCaldavDeleteScenario(byId("uncertain-restart-absence"));
  assert.deepEqual(absent.methods, ["GET"]); assert.equal(absent.provider.kind, "uncertain"); assert.equal(absent.mutationMarks, 0);
  const late = await runCaldavDeleteScenario(byId("preflight-404-is-error")); assert.deepEqual(late.ackKinds, []);
  const denied = await runCaldavDeleteScenario(byId("accepted-readback-denied")); assert.equal(denied.provider.kind, "accepted"); assert.deepEqual(denied.ackKinds, []);
});

test("DAV guarded redirects exercise shared per-hop metrics and stripping rather than a simulated redirect policy", async () => {
  const redirected = await runCaldavDeleteScenario(byId("cross-origin-auth-stripped"));
  assert.deepEqual(redirected.authorized, [true, false, true, true, true]); assert.equal(redirected.metrics.length, redirected.methods.length);
  assert.deepEqual(redirected.metrics.slice(0, 2).map(metric => metric.status), [302, 200]);
  const denied = await runCaldavDeleteScenario(byId("dns-private-denied")); assert.equal(denied.dnsLookups, 1); assert.deepEqual(denied.metrics, []);
  const strict = await runCaldavDeleteScenario(byId("reference-refuses-alias")); assert.equal(strict.methods.length, 1); assert.equal(strict.mutationMarks, 0);
});

test("caught native transport errors cannot hide unplanned or unconsumed DAV exchanges", async () => {
  const extra = first(); extra.exchanges.push(structuredClone(extra.exchanges[0]!));
  await assert.rejects(runCaldavDeleteScenario(extra), failureCode("unconsumed-exchange"));
  const wrong = first(); wrong.exchanges[0]!.method = "DELETE";
  await assert.rejects(runCaldavDeleteScenario(wrong), failureCode("exchange-mismatch"));
  const missing = first(); missing.exchanges.pop();
  await assert.rejects(runCaldavDeleteScenario(missing), failureCode("exchange-mismatch"));
});

test("malformed frozen native UID/address/plan binding is held before any credentials or HTTP", async () => {
  for (const defect of ["uid", "url", "plan"] as const) {
    const scenario = first(); scenario.exchanges = [];
    const expected: CaldavDeleteSummary = { status: "hold", methods: [], urls: [], ifMatch: [], authorized: [], propfindKinds: [], metrics: [], dnsLookups: 0,
      ackKinds: [], finishStatuses: ["hold"], evidence: [], provider: { kind: "not-dispatched", status: null, errorCode: null, retry: null, retryAfterMs: null },
      remoteKind: "unobserved", remoteEtag: null, remoteUid: null, remoteUrl: null, remoteDataHash: null, remoteStatus: null, possibleDispatch: false,
      mutationMarks: 0, retryAfterMs: null, errorCode: "operation-envelope-binding-mismatch", errorOutcome: "not-written" };
    scenario.expected = expected; const claim = structuredClone(claimedCaldavDeleteInput(scenario));
    if (defect === "uid") (claim.nativeTarget as { uid: string }).uid = "wrong-native-uid";
    else if (defect === "url") (claim.nativeTarget as { resourceUrl: string }).resourceUrl = "https://dav.example.test/cal/wrong.ics";
    else {
      const envelope = (claim.payload as { operationEnvelope: SyncOperationEnvelope }).operationEnvelope;
      envelope.nativePlan.data.uid = "wrong-native-uid";
      scenario.expected.errorCode = "operation-envelope-codec-unavailable";
    }
    assert.equal((await runCaldavDeleteScenario(scenario, claim)).mutationMarks, 0);
  }
});

test("DAV fixture schema rejects executable data, unknown fields, unsafe URLs and incomplete assertions without getters", () => {
  const candidates: unknown[] = [
    { ...suite, schemaVersion: 2 }, { ...suite, module: "do-not-import" }, { ...suite, scenarios: [] }, { ...suite, scenarios: [first(), first()] },
    { ...suite, scenarios: [{ ...first(), id: "../unsafe" }] }, { ...suite, scenarios: [{ ...first(), expected: { status: "acked" } }] },
    { ...suite, scenarios: [{ ...first(), recovery: { required: true, possibleDispatch: false } }] },
    { ...suite, scenarios: [{ ...first(), priorProvider: { kind: "uncertain" } }] },
    { ...suite, scenarios: [{ ...first(), network: "do-not-fetch" }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ method: "GET", url: "https://unplanned.invalid", status: 200, body: "" }] }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], error: "lost-reply" }] }] },
    { ...suite, scenarios: [{ ...first(), exchanges: [{ ...first().exchanges[0], headers: { authorization: "private" } }] }] },
  ];
  let getters = 0; const accessor = first();
  Object.defineProperty(accessor.exchanges[0]!, "body", { enumerable: true, get() { getters++; return "unsafe"; } }); candidates.push({ schemaVersion: 1, scenarios: [accessor] });
  const hidden = first(); Object.defineProperty(hidden, "hidden", { value: true }); candidates.push({ schemaVersion: 1, scenarios: [hidden] });
  for (const candidate of candidates) assert.throws(() => parseCaldavDeleteSuite(candidate), failureCode("invalid-suite")); assert.equal(getters, 0);
});

test("DAV CLI lists and exactly selects fixed scenarios with bounded non-sensitive diagnostics", async () => {
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  assert.equal(await runCli(["--list", "--json"], write), 0); const list = JSON.parse(lines.pop()!);
  assert.equal(list.suite, "caldav-delete"); assert.equal(list.scenarios.length, suite.scenarios.length);
  assert.equal(await runCli(["--scenario", "initial-absence", "--json"], write), 0); const selected = JSON.parse(lines.pop()!);
  assert.equal(selected.results.length, 1); assert.equal(selected.results[0].id, "initial-absence"); assert.deepEqual(selected.results[0].summary.methods, ["GET"]);
  for (const args of [["--json", "--scenario", "missing"], ["--json", "--scenario"], ["--json", "--list", "--scenario", "fresh-delete"],
    ["--json", "--json"], ["--json", "PRIVATE_ARGUMENT"]]) {
    assert.equal(await runCli(args, write), 1); const line = lines.pop()!; assert.ok(JSON.parse(line).error.code); assert.ok(!line.includes("PRIVATE_ARGUMENT")); assert.ok(line.length < 300);
  }
  assert.equal(lines.length, 0);
});
