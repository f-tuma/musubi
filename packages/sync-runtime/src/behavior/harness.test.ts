import assert from "node:assert/strict";
import test from "node:test";
import { loadDeleteSuite, parseDeleteSuite, runDeleteScenario, ScenarioFailure } from "./google-delete";
import { runCli } from "./cli";

const suite = await loadDeleteSuite();
const first = () => structuredClone(suite.scenarios[0]!);
const failureCode = (code: ScenarioFailure["code"]) => (error: unknown) => error instanceof ScenarioFailure && error.code === code;

test("JSON driver exercises the real runtime and rejects incorrect observable expectations", async () => {
  const scenario = first();
  assert.equal((await runDeleteScenario(scenario)).status, "acked");
  scenario.expected.mutationMarks = 0;
  await assert.rejects(runDeleteScenario(scenario), failureCode("expectation-mismatch"));
});

test("unconsumed and unexpected HTTP exchanges cannot pass as a runtime HOLD", async () => {
  const unconsumed = first();
  unconsumed.exchanges.push(structuredClone(unconsumed.exchanges[0]!));
  await assert.rejects(runDeleteScenario(unconsumed), failureCode("unconsumed-exchange"));
  const unexpected = first();
  unexpected.exchanges[0]!.method = "DELETE";
  await assert.rejects(runDeleteScenario(unexpected), failureCode("exchange-mismatch"));
  const missing = first();
  missing.exchanges.pop();
  await assert.rejects(runDeleteScenario(missing), failureCode("exchange-mismatch"));
});

test("schema refuses missing assertions, unknown fields, unsupported versions and duplicate ids", () => {
  const cases: unknown[] = [
    { ...suite, schemaVersion: 2 },
    { ...suite, unexpected: true },
    { ...suite, scenarios: [first(), first()] },
    { schemaVersion: 1, scenarios: [] },
    { schemaVersion: 1, scenarios: [{ ...first(), expected: { status: "acked" } }] },
    { schemaVersion: 1, scenarios: [{ ...first(), injected: true }] },
    { schemaVersion: 1, scenarios: [{ ...first(), exchanges: [{ method: "GET", path: "https://example.invalid", status: 200, body: {} }] }] },
    { schemaVersion: 1, scenarios: [{ ...first(), exchanges: [{ method: "GET", path: first().exchanges[0]!.path, error: "lost-reply", status: 500, body: {} }] }] },
  ];
  for (const value of cases) assert.throws(() => parseDeleteSuite(value), failureCode("invalid-suite"));
});

test("JSON CLI lists, selects, rejects ambiguous flags and emits bounded parseable diagnostics", async () => {
  const lines: string[] = [];
  const write = (line: string) => { lines.push(line); };
  assert.equal(await runCli(["--json", "--list"], write), 0);
  assert.equal(JSON.parse(lines.pop()!).scenarios.length, 5);
  assert.equal(await runCli(["--scenario", "already-absent", "--json"], write), 0);
  const selected = JSON.parse(lines.pop()!);
  assert.equal(selected.results.length, 1);
  assert.equal(selected.results[0].id, "already-absent");
  assert.equal(selected.results[0].summary.methods.join(), "GET");
  for (const args of [["--json", "--scenario", "missing"], ["--json", "--scenario"], ["--json", "--list", "--scenario", "already-absent"], ["--json", "--json"], ["--json", "PRIVATE_ARGUMENT"]]) {
    assert.equal(await runCli(args, write), 1);
    const line = lines.pop()!;
    assert.ok(JSON.parse(line).error.code);
    assert.equal(line.includes("PRIVATE_ARGUMENT"), false);
    assert.ok(line.length < 300);
  }
  assert.equal(lines.length, 0);
});
