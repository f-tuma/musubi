import assert from "node:assert/strict";
import { runApiJsonBodyCli } from "./api-json-body-cli";
import { ApiJsonBodyScenarioFailure, loadApiJsonBodySuite, runApiJsonBodyScenario } from "./api-json-body";

async function main() {
  const suite = await loadApiJsonBodySuite();
  const example = suite.scenarios[0]!;
  for (const invalid of [
    { ...suite, scenarios: [] },
    { ...suite, scenarios: [example, example] },
    { ...suite, scenarios: [{ ...example, unexpected: true }] },
    { ...suite, scenarios: [{ ...example, trailingBytes: 102401 }] },
    { ...suite, scenarios: [{ ...example, encoding: "identity" }] },
    { ...suite, scenarios: [{ ...example, input: "oversized-json" }] },
    { ...suite, scenarios: [{ ...example, expectedStatus: [500] }] },
  ]) {
    await assert.rejects(loadApiJsonBodySuite(invalid),
      error => error instanceof ApiJsonBodyScenarioFailure && error.code === "invalid-suite");
  }
  await assert.rejects(runApiJsonBodyScenario({ ...example, trailingBytes: -1 }),
    error => error instanceof ApiJsonBodyScenarioFailure && error.code === "invalid-suite");
  for (const args of [["--scenario"], ["--scenario", "missing"], ["--list", "--scenario", example.id], ["--json", "--json"], ["--unknown"]]) {
    const lines: string[] = [];
    assert.equal(await runApiJsonBodyCli([...args, "--json"], line => lines.push(line)), 1);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).error.code, args[0] === "--scenario" && args[1] === "missing" ? "unknown-scenario" : "invalid-arguments");
  }
  const lines: string[] = [];
  assert.equal(await runApiJsonBodyCli(["--list", "--json"], line => lines.push(line)), 0);
  assert.deepEqual(JSON.parse(lines[0]!).scenarios.map((item: { id: string }) => item.id), suite.scenarios.map(item => item.id));
  console.log("API JSON body scenario harness: OK");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
