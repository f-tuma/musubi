import assert from "node:assert/strict";
import { loadGoogleTaskCreateSuite, parseGoogleTaskCreateSuite, runGoogleTaskCreateScenario, ScenarioFailure } from "./google-task-create";
import { runCli } from "./google-task-create-cli";

const suite = await loadGoogleTaskCreateSuite();
for (const scenario of suite.scenarios) await runGoogleTaskCreateScenario(scenario);
let negative = 0;
function invalid(value: unknown) {
  assert.throws(() => parseGoogleTaskCreateSuite(value), error => error instanceof ScenarioFailure && error.code === "invalid-suite"); negative++;
}
function change(mutator: (scenario: Record<string, any>) => void) {
  const input = structuredClone(suite); mutator(input.scenarios[0]!); invalid(input);
}
invalid({ ...suite, importedModule: "./arbitrary" });
invalid({ ...suite, scenarios: [suite.scenarios[0], suite.scenarios[0]] });
change(item => { item.dispatchRecovery = "blind-retry"; });
change(item => { item.exchanges[0].execute = "arbitrary"; });
change(item => { item.exchanges[0].method = "DELETE"; });
change(item => { item.exchanges[0].url = "https://example.invalid/tasks"; });
change(item => { item.exchanges[0].rawBody = "{}"; });
change(item => { item.exchanges[0].error = "lost-reply"; });
change(item => { item.exchanges[0].status = 204; });
change(item => { item.exchanges[0].headers = { authorization: "Private" }; });
change(item => { item.exchanges[0].responseUrl = "https://arbitrary.invalid"; });
change(item => { item.expected.methods[0] = "PATCH"; });
change(item => { item.expected.urls.pop(); });
change(item => { item.expected.metrics[0].accessToken = "Private"; });
change(item => { item.expected.metrics[0].durationMs = NaN; });
change(item => { item.expected.evidence[0].writerResult.extra = "ignored"; });
change(item => { item.expected.responseAddress.validator = 'W/"weak"'; });
change(item => { item.expected.acceptedStatus = 202; });
change(item => { item.priorAcceptedStatus = 404; });
change(item => { item.priorAcceptedStatus = 201; });
change(item => { item.priorResponseAddress = { taskId: "native/task", validator: null }; });
change(item => { item.priorError = { code: "conflict", retry: "never" }; });
change(item => { item.taskOverrides = { due: "not-a-date" }; });
change(item => { item.saved = { baseline: null, patch: {}, extra: "ignored" }; });
change(item => { item.saved = { baseline: null, patch: { title: undefined } }; });
change(item => { item.saved = { baseline: null, patch: { status: "in-process" } }; });
let invoked = false; const getter = structuredClone(suite);
Object.defineProperty(getter.scenarios[0]!, "recovery", { enumerable: true, get() { invoked = true; return false; } }); invalid(getter); assert.equal(invoked, false);
const cycle = structuredClone(suite) as unknown as Record<string, unknown>; cycle.self = cycle; invalid(cycle);
const sparse = structuredClone(suite); delete sparse.scenarios[0]!.exchanges[0]; invalid(sparse);
const wrongExpected = structuredClone(suite.scenarios[0]!); wrongExpected.expected.sessions++;
await assert.rejects(() => runGoogleTaskCreateScenario(wrongExpected), error => error instanceof ScenarioFailure && error.code === "expectation-mismatch"); negative++;
const unexpectedMethod = structuredClone(suite.scenarios[0]!); unexpectedMethod.exchanges[0]!.method = "POST";
await assert.rejects(() => runGoogleTaskCreateScenario(unexpectedMethod), error => error instanceof ScenarioFailure && error.code === "exchange-mismatch"); negative++;
const unexpectedURL = structuredClone(suite.scenarios[0]!); unexpectedURL.exchanges[0]!.url = "https://tasks.googleapis.com/tasks/v1/users/@me/lists/different";
await assert.rejects(() => runGoogleTaskCreateScenario(unexpectedURL), error => error instanceof ScenarioFailure && error.code === "exchange-mismatch"); negative++;
const unconsumed = structuredClone(suite.scenarios[0]!); unconsumed.exchanges.push(structuredClone(unconsumed.exchanges[0]!));
await assert.rejects(() => runGoogleTaskCreateScenario(unconsumed), error => error instanceof ScenarioFailure && error.code === "unconsumed-exchange"); negative++;
for (const args of [["--unknown", "--json"], ["--scenario", "absent", "--json"], ["--scenario", "--json"], ["--json", "--json"], ["--list", "--scenario", "fresh-create", "--json"]]) {
  const output: string[] = []; assert.equal(await runCli(args, line => output.push(line)), 1); assert.equal(output.length, 1);
  if (args.includes("--json")) { const report = JSON.parse(output[0]!); assert.equal(report.suite, "google-task-create"); assert(["invalid-arguments", "unknown-scenario"].includes(report.error.code)); } negative++;
}
const listed: string[] = []; assert.equal(await runCli(["--list", "--json"], line => listed.push(line)), 0);
assert.deepEqual(JSON.parse(listed[0]!).scenarios.map((item: { id: string }) => item.id), suite.scenarios.map(item => item.id));
const selected: string[] = []; assert.equal(await runCli(["--scenario", "fresh-create", "--json"], line => selected.push(line)), 0);
const report = JSON.parse(selected[0]!); assert.deepEqual(report.results.map((item: { id: string }) => item.id), ["fresh-create"]);
assert.equal(report.results[0].status, "passed"); assert(!selected[0]!.includes("fixture-initial-token")); assert(!selected[0]!.includes("fixture-recovered-token"));
console.log(`Google task CREATE: ${suite.scenarios.length} actual codec/kernel/provider scenarios + ${negative} fail-closed schema/harness checks passed; no DB or live-provider claim.`);

console.log("SYNC_CONFORMANCE_COMPLETE:harness/google-task-create-harness");
