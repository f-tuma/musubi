import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadAttempt, ReadAttemptInterrupted } from "../read_attempt";
import { loadReadAttemptSuite, ReadAttemptScenarioFailure, ReadAttemptTestClock, runReadAttemptScenario } from "./read-attempt-driver";
import { runReadAttemptCli } from "./read-attempt-cli";

const failure = (code: ReadAttemptScenarioFailure["code"]) => (error: unknown) => error instanceof ReadAttemptScenarioFailure && error.code === code;
const interrupted = (reason: ReadAttemptInterrupted["reason"]) => (error: unknown) => error instanceof ReadAttemptInterrupted && error.reason === reason;

test("every fixed read-attempt JSON scenario executes the actual production boundary", async () => {
  const suite = await loadReadAttemptSuite();
  assert.equal(suite.scenarios.length, 8);
  for (const scenario of suite.scenarios) {
    const summary = await runReadAttemptScenario(scenario);
    assert.equal(summary.callbacksAfterDispose, 0); assert.equal(summary.pendingTimers, 0);
    if (scenario.id === "steady-large-pagination") {
      assert.equal(summary.pages, 190); assert.equal(summary.completedAtMs, 95_500);
      assert(summary.completedAtMs > 95_000); assert.deepEqual(summary.guards, ["live", "finished"]);
      assert.equal(summary.runs.filter(run => run.outcome === "completed").length, 2);
    }
    if (scenario.id === "quota-pause-keeps-heartbeats") assert.equal(summary.renewals, 6);
    if (["caller-abort-during-pause", "lease-loss-during-pause"].includes(scenario.id)) assert.equal(summary.resumeCalls, 0);
  }
});

test("read-attempt inventory rejects malformed, duplicate, unknown and unbounded fixtures", async () => {
  const suite = await loadReadAttemptSuite(), first = suite.scenarios[0]!;
  const malformed = [
    { ...suite, unknown: "field" }, { ...suite, schemaVersion: 2 }, { ...suite, scenarios: [] },
    { ...suite, scenarios: [first, first] }, { ...suite, driver: "other" },
    { ...suite, scenarios: [{ ...first, id: "INVALID ID" }] },
    { ...suite, scenarios: [{ ...first, title: " " }] },
    { ...suite, scenarios: [{ ...first, expected: { ...first.expected, extra: true } }] },
    { ...suite, scenarios: [{ ...first, steps: [{ command: "simulate-attempt" }] }] },
    { ...suite, scenarios: [{ ...first, steps: [{ command: "advance", durationMs: -1 }] }] },
    { ...suite, scenarios: [{ ...first, steps: [{ command: "advance", durationMs: 0.5 }] }] },
    { ...suite, scenarios: [{ ...first, options: { heartbeatMs: Infinity } }] },
  ];
  for (const value of malformed) await assert.rejects(loadReadAttemptSuite(value), failure("invalid-suite"));
});

test("read-attempt driver rejects mismatched evidence and unconsumed or unbound ports", async () => {
  const suite = await loadReadAttemptSuite(), first = suite.scenarios[0]!;
  await assert.rejects(runReadAttemptScenario({ ...first, expected: { ...first.expected, pages: 189 } }), failure("expectation-mismatch"));
  await assert.rejects(runReadAttemptScenario({ ...first, steps: [{ command: "resume", id: "missing" }, { command: "dispose" }] }), failure("unexpected-port"));
  await assert.rejects(runReadAttemptScenario({ ...first, steps: [{ command: "guard" }] }), failure("unconsumed-port"));
  await assert.rejects(runReadAttemptScenario({ ...first, renewalResponses: [true, true, true, true, true] }), failure("unconsumed-port"));
  await assert.rejects(runReadAttemptScenario({ ...first, steps: [{ command: "immediate-run", id: "same" }, { command: "immediate-run", id: "same" }, { command: "dispose" }] }), failure("unexpected-port"));
});

test("read-attempt CLI lists and selects exact inventory with one bounded JSON report", async () => {
  const suite = await loadReadAttemptSuite(), lines: string[] = [];
  assert.equal(await runReadAttemptCli(["--list", "--json"], line => lines.push(line)), 0);
  assert.equal(lines.length, 1); assert.deepEqual(JSON.parse(lines.pop()!).scenarios, suite.scenarios.map(({ id, title }) => ({ id, title })));
  assert.equal(await runReadAttemptCli(["--scenario", "steady-large-pagination", "--json"], line => lines.push(line)), 0);
  assert.equal(lines.length, 1); const report = JSON.parse(lines.pop()!);
  assert.equal(report.schemaVersion, 1); assert.equal(report.suite, "read-attempt"); assert.equal(report.results.length, 1);
  assert.equal(report.results[0].id, "steady-large-pagination"); assert.equal(report.results[0].summary.completedAtMs, 95_500);
  assert.equal(await runReadAttemptCli(["--json"], line => lines.push(line)), 0);
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines.pop()!).results.length, suite.scenarios.length);
  for (const args of [["--json", "--json"], ["--json", "--scenario"], ["--unknown", "--json"], ["--list", "--scenario", "steady-large-pagination", "--json"], ["--scenario", "$(touch /tmp/never)", "--json"]]) {
    assert.equal(await runReadAttemptCli(args, line => lines.push(line)), 1); assert.equal(lines.length, 1);
    const invalid = JSON.parse(lines.pop()!); assert.equal(invalid.error.code, "invalid-arguments"); assert.equal(invalid.results, undefined); assert.equal(invalid.error.stack, undefined);
  }
  assert.equal(await runReadAttemptCli(["--scenario", "missing", "--json"], line => lines.push(line)), 1);
  assert.equal(JSON.parse(lines.pop()!).error.code, "unknown-scenario");
});

test("disposed production attempts reject late guards, pause and body execution without callback leaks", async () => {
  const clock = new ReadAttemptTestClock(), caller = new AbortController(); let renewals = 0, bodies = 0;
  const attempt = createReadAttempt(async () => { renewals++; return true; }, { clock, signal: caller.signal });
  const resume = attempt.pause(); attempt.dispose(); attempt.dispose(); caller.abort(); resume(); resume(); attempt.progress();
  assert.throws(attempt.guard, interrupted("finished")); assert.throws(attempt.pause, interrupted("finished"));
  await assert.rejects(attempt.run(async () => { bodies++; }), interrupted("finished"));
  await clock.advance(360_000);
  assert.equal(bodies, 0); assert.equal(renewals, 0); assert.equal(clock.callbacks, 0); assert.equal(clock.pendingTimers, 0);
});

test("production lease renewal rejection remains active during an explicit pause", async () => {
  const clock = new ReadAttemptTestClock(), attempt = createReadAttempt(async () => { throw new Error("Synthetic renewal receipt"); }, { clock });
  attempt.pause(); const rejected = assert.rejects(attempt.run(() => new Promise<void>(() => {})), interrupted("lease-lost"));
  await clock.advance(20_000); await rejected;
  assert.equal(attempt.signal.aborted, true); attempt.dispose(); assert.equal(clock.pendingTimers, 0);
});

test("production read timer validation rejects unsupported options before scheduling", () => {
  const clock = new ReadAttemptTestClock();
  for (const value of [0, -1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => createReadAttempt(async () => true, { clock, idleTimeoutMs: value }), RangeError);
    assert.throws(() => createReadAttempt(async () => true, { clock, heartbeatMs: value }), RangeError);
  }
  assert.equal(clock.pendingTimers, 0);
});
