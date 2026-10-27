import assert from "node:assert/strict";
import { loadGoogleUpdateSuite, parseGoogleUpdateSuite, runGoogleUpdateScenario, ScenarioFailure } from "./google-update";
import { runCli } from "./google-update-cli";
const suite = await loadGoogleUpdateSuite();
for (const scenario of suite.scenarios) await runGoogleUpdateScenario(scenario);
const invalid = (value: unknown) => assert.throws(() => parseGoogleUpdateSuite(value), error => error instanceof ScenarioFailure && error.code === "invalid-suite");
invalid({ ...suite, importedModule: "./arbitrary" });
invalid({ ...suite, scenarios: [suite.scenarios[0], suite.scenarios[0]] });
const method = structuredClone(suite); (method.scenarios[0]!.exchanges[0] as unknown as Record<string, unknown>).method = "POST"; invalid(method);
const target = structuredClone(suite); target.scenarios[0]!.exchanges[0]!.path = "https://foreign.test/"; invalid(target);
let invoked = false; const getter = structuredClone(suite);
Object.defineProperty(getter.scenarios[0]!, "fault", { enumerable: true, get() { invoked = true; return "unknown-version"; } }); invalid(getter); assert.equal(invoked, false);
const wrong = structuredClone(suite.scenarios[0]!); wrong.expected.mutationMarks++;
await assert.rejects(() => runGoogleUpdateScenario(wrong), error => error instanceof ScenarioFailure && error.code === "expectation-mismatch");
const extra = structuredClone(suite.scenarios[0]!); extra.exchanges.push(structuredClone(extra.exchanges[0]!));
await assert.rejects(() => runGoogleUpdateScenario(extra), error => error instanceof ScenarioFailure && error.code === "unconsumed-exchange");
for (const args of [["--unknown", "--json"], ["--scenario", "missing", "--json"], ["--list", "--scenario", "fresh-reference-title-update", "--json"]]) {
  const output: string[] = []; assert.equal(await runCli(args, v => output.push(v)), 1); assert.equal(output.length, 1); assert.equal(JSON.parse(output[0]!).suite, "google-update");
}
const listed: string[] = []; assert.equal(await runCli(["--list", "--json"], v => listed.push(v)), 0);
assert.deepEqual(JSON.parse(listed[0]!).scenarios.map((v: { id: string }) => v.id), suite.scenarios.map(v => v.id));
console.log("Google UPDATE actual kernel/provider JSON and fail-closed harness checks passed; no DB/live claim.");

console.log("SYNC_CONFORMANCE_COMPLETE:harness/google-update-harness");
