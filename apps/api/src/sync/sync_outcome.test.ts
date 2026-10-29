import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderDispatchDeferred } from "@musubi/sync-runtime";
import { observeSyncFailure, observeSyncRun, syncDeferral, SyncWorkDeferred } from "./sync_outcome";
import { loadSyncOutcomeSuite, runSyncOutcomeScenario, SyncOutcomeScenarioFailure } from "./behavior/sync-outcome-driver";
import { runSyncOutcomeCli } from "./behavior/sync-outcome-cli";

test("fixed JSON scenarios exercise production run and failure telemetry ports", async () => {
  const suite = await loadSyncOutcomeSuite();
  assert.equal(suite.scenarios.length, 14);
  for (const scenario of suite.scenarios) await runSyncOutcomeScenario(scenario);
});

test("explicit deferrals preserve rejection identity and never record failure or success", async () => {
  for (const error of [new SyncWorkDeferred(12345), new ProviderDispatchDeferred({ reason: "credit", retryAtMs: 12345, blockedDimensions: [] })]) {
    const outcomes: string[] = [], logs: { event: string; fields: Record<string, unknown> }[] = [];
    await assert.rejects(observeSyncRun("google", async () => { throw error; }, (_provider, outcome) => outcomes.push(outcome)), caught => caught === error);
    observeSyncFailure({ provider: "google", stage: "account", error, accountId: "private-account" }, "private-user", {
      failure() { assert.fail("A control-flow deferral is not a failure"); },
      deferred(_stage, _provider, reason) { assert(["queued-read", "credit"].includes(reason)); },
      log(_level, event, fields) { logs.push({ event, fields }); },
    });
    assert.deepEqual(outcomes, ["deferred"]); assert.equal(logs.length, 1);
    assert.equal(logs[0]!.event, "sync.account.deferred"); assert(!JSON.stringify(logs).includes("private-"));
  }
});

test("counterfeit names, plain data and invalid queue timestamps cannot suppress failures", () => {
  for (const error of [Object.assign(new Error("Provider dispatch deferred."), { name: "ProviderDispatchDeferred" }),
    { name: "SyncWorkDeferred", retryAtMs: 1 }, new SyncWorkDeferred(NaN), new SyncWorkDeferred(Infinity),
    new SyncWorkDeferred(-1), new SyncWorkDeferred(253_402_300_800_000)]) assert.equal(syncDeferral(error), undefined);
});

test("source fences and unknown errors remain failed and retain their original error object", async () => {
  const error = Object.assign(new Error("A private source changed"), { name: "SyncReadWorkChanged" });
  let failures = 0;
  await assert.rejects(observeSyncRun("google", async () => { throw error; }, (_provider, outcome) => assert.equal(outcome, "failed")), caught => caught === error);
  observeSyncFailure({ provider: "google", stage: "discovery", error }, "fixture", {
    failure() { failures++; }, deferred() { assert.fail("Authority loss is not a budget/queued deferral"); },
    log(level, event, fields) { assert.equal(level, "error"); assert.equal(event, "sync.provider.failed"); assert.equal(fields.error, error); },
  });
  assert.equal(failures, 1);
});

test("scenario inventory and expected evidence fail closed", async () => {
  const suite = await loadSyncOutcomeSuite(), first = suite.scenarios[0]!;
  for (const input of [{ ...suite, unknown: true }, { ...suite, scenarios: [first, first] },
    { ...suite, scenarios: [{ ...first, input: { ...first.input, kind: "unbounded-provider-error" } }] }])
    await assert.rejects(loadSyncOutcomeSuite(input), error => error instanceof SyncOutcomeScenarioFailure && error.code === "invalid-suite");
  await assert.rejects(runSyncOutcomeScenario({ ...first, expected: { ...first.expected, failureCount: 1 } }),
    error => error instanceof SyncOutcomeScenarioFailure && error.code === "expectation-mismatch");
});

test("CLI runs only exact selected scenarios and emits one bounded JSON document", async () => {
  const lines: string[] = [];
  assert.equal(await runSyncOutcomeCli(["--scenario", "credit-account", "--json"], line => lines.push(line)), 0);
  assert.equal(lines.length, 1); let report = JSON.parse(lines.pop()!); assert.equal(report.results.length, 1);
  assert.equal(report.results[0].summary.outcome, "deferred");
  assert.equal(await runSyncOutcomeCli(["--list", "--json"], line => lines.push(line)), 0);
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines.pop()!).scenarios.length, 14);
  for (const args of [["--json", "--json"], ["--scenario", "missing", "--json"], ["--list", "--scenario", "credit-account", "--json"]]) {
    assert.equal(await runSyncOutcomeCli(args, line => lines.push(line)), 1); assert.equal(lines.length, 1);
    report = JSON.parse(lines.pop()!); assert.equal(report.results, undefined); assert.equal(report.error.stack, undefined);
    assert(!JSON.stringify(report).includes("secret-value"));
  }
});
