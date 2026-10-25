import assert from "node:assert/strict";
import { loadGoogleTaskDeleteSuite, parseGoogleTaskDeleteSuite, runGoogleTaskDeleteScenario, ScenarioFailure } from "./google-task-delete";
import { runCli } from "./google-task-delete-cli";

const suite = await loadGoogleTaskDeleteSuite();
for (const scenario of suite.scenarios) await runGoogleTaskDeleteScenario(scenario);
let negative = 0;
function invalid(value: unknown) {
  assert.throws(() => parseGoogleTaskDeleteSuite(value), error => error instanceof ScenarioFailure && error.code === "invalid-suite"); negative++;
}
invalid({ ...suite, importedModule: "./arbitrary" });
invalid({ ...suite, scenarios: [suite.scenarios[0], suite.scenarios[0]] });
const unknownField = structuredClone(suite); (unknownField.scenarios[0]!.exchanges[0] as unknown as Record<string, unknown>).execute = "arbitrary"; invalid(unknownField);
const invalidMethod = structuredClone(suite); (invalidMethod.scenarios[0]!.exchanges[0] as unknown as Record<string, unknown>).method = "PATCH"; invalid(invalidMethod);
const invalidExpectedMethod = structuredClone(suite); invalidExpectedMethod.scenarios[0]!.expected.methods[0] = "POST"; invalid(invalidExpectedMethod);
const invalidSidecar = structuredClone(suite); invalidSidecar.scenarios[0]!.priorAcceptedStatus = 404; invalid(invalidSidecar);
let invoked = false; const getter = structuredClone(suite);
Object.defineProperty(getter.scenarios[0]!, "recovery", { enumerable: true, get() { invoked = true; return false; } }); invalid(getter); assert.equal(invoked, false);
const wrongExpected = structuredClone(suite.scenarios[0]!); wrongExpected.expected.sessions++;
await assert.rejects(() => runGoogleTaskDeleteScenario(wrongExpected), error => error instanceof ScenarioFailure && error.code === "expectation-mismatch"); negative++;
const unexpected = structuredClone(suite.scenarios[0]!); unexpected.exchanges[0]!.method = "DELETE";
await assert.rejects(() => runGoogleTaskDeleteScenario(unexpected), error => error instanceof ScenarioFailure && error.code === "exchange-mismatch"); negative++;
const unconsumed = structuredClone(suite.scenarios[0]!); unconsumed.exchanges.push(structuredClone(unconsumed.exchanges[0]!));
await assert.rejects(() => runGoogleTaskDeleteScenario(unconsumed), error => error instanceof ScenarioFailure && error.code === "unconsumed-exchange"); negative++;
for (const args of [["--unknown", "--json"], ["--scenario", "absent", "--json"], ["--list", "--scenario", "fresh-delete", "--json"]]) {
  const output: string[] = []; assert.equal(await runCli(args, line => output.push(line)), 1); assert.equal(output.length, 1);
  const report = JSON.parse(output[0]!); assert.equal(report.suite, "google-task-delete"); assert(["invalid-arguments", "unknown-scenario"].includes(report.error.code)); negative++;
}
const listed: string[] = []; assert.equal(await runCli(["--list", "--json"], line => listed.push(line)), 0);
assert.deepEqual(JSON.parse(listed[0]!).scenarios.map((item: { id: string }) => item.id), suite.scenarios.map(item => item.id));
console.log(`Google task DELETE: ${suite.scenarios.length} actual codec/kernel/provider scenarios + ${negative} fail-closed schema/harness checks passed; no DB or live-provider claim.`);
