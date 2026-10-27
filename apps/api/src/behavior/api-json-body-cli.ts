import { pathToFileURL } from "node:url";
import { ApiJsonBodyScenarioFailure, loadApiJsonBodySuite, runApiJsonBodyScenario } from "./api-json-body";

export async function runApiJsonBodyCli(args: string[], write: (line: string) => void = line => process.stdout.write(`${line}\n`)) {
  const started = performance.now(), json = args.includes("--json");
  let scenarioId: string | undefined;
  try {
    const seen = new Set<string>(); let selected: string | undefined, list = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (!["--json", "--list", "--scenario"].includes(flag) || seen.has(flag))
        throw new ApiJsonBodyScenarioFailure("invalid-arguments", "Use --list or --scenario <id>, and optional --json.");
      seen.add(flag);
      if (flag === "--list") list = true;
      if (flag === "--scenario") {
        selected = args[++index];
        if (!selected || !/^[a-z][a-z0-9-]{0,79}$/.test(selected))
          throw new ApiJsonBodyScenarioFailure("invalid-arguments", "Use one valid scenario id.");
      }
    }
    if (list && selected) throw new ApiJsonBodyScenarioFailure("invalid-arguments", "Choose either list or scenario.");
    const suite = await loadApiJsonBodySuite();
    if (list) {
      const scenarios = suite.scenarios.map(({ id, title }) => ({ id, title }));
      write(json ? JSON.stringify({ schemaVersion: 1, suite: suite.suite, scenarios }) : scenarios.map(item => `${item.id}: ${item.title}`).join("\n"));
      return 0;
    }
    const selectedScenarios = suite.scenarios.filter(item => !selected || item.id === selected);
    if (!selectedScenarios.length) throw new ApiJsonBodyScenarioFailure("unknown-scenario", "The requested scenario is not in this suite.");
    const results = [];
    for (const scenario of selectedScenarios) {
      scenarioId = scenario.id;
      const before = performance.now(), summary = await runApiJsonBodyScenario(scenario);
      results.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs: Math.round(performance.now() - before), summary });
    }
    const durationMs = Math.round(performance.now() - started);
    write(json ? JSON.stringify({ schemaVersion: 1, suite: suite.suite, results, durationMs })
      : `${results.map(item => `PASS ${item.id}`).join("\n")}\n${results.length} scenarios passed (${durationMs}ms).`);
    return 0;
  } catch (error) {
    const failure = error instanceof ApiJsonBodyScenarioFailure ? error
      : new ApiJsonBodyScenarioFailure("expectation-mismatch", "The API JSON body scenario failed.");
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "api-json-body", error: { code: failure.code, message: failure.message, ...(scenarioId ? { scenarioId } : {}) } })
      : `FAIL ${scenarioId ?? ""} ${failure.code}: ${failure.message}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runApiJsonBodyCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
