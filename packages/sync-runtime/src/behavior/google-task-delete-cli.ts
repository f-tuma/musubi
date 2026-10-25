import { pathToFileURL } from "node:url";
import { loadGoogleTaskDeleteSuite, runGoogleTaskDeleteScenario, ScenarioFailure } from "./google-task-delete";

export async function runCli(args: string[], write: (line: string) => void = line => process.stdout.write(`${line}\n`)): Promise<number> {
  const json = args.includes("--json"), started = performance.now();
  let scenarioId: string | undefined;
  try {
    let selected: string | undefined, list = false;
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (!["--json", "--list", "--scenario"].includes(arg) || seen.has(arg)) throw new ScenarioFailure("invalid-arguments", "Use --list, --scenario <id> and optional --json.");
      seen.add(arg);
      if (arg === "--list") list = true;
      if (arg === "--scenario") {
        selected = args[++index];
        if (!selected || !/^[a-z][a-z0-9-]{0,79}$/.test(selected)) throw new ScenarioFailure("invalid-arguments", "Use --scenario with one valid scenario id.");
      }
    }
    if (list && selected) throw new ScenarioFailure("invalid-arguments", "Choose either --list or --scenario.");
    const suite = await loadGoogleTaskDeleteSuite();
    if (list) {
      const scenarios = suite.scenarios.map(({ id, title }) => ({ id, title }));
      write(json ? JSON.stringify({ schemaVersion: 1, suite: "google-task-delete", scenarios }) : scenarios.map(item => `${item.id}: ${item.title}`).join("\n"));
      return 0;
    }
    const scenarios = suite.scenarios.filter(item => !selected || item.id === selected);
    if (!scenarios.length) throw new ScenarioFailure("unknown-scenario", "The requested scenario id is not in this suite.");
    const results = [];
    for (const scenario of scenarios) {
      scenarioId = scenario.id;
      const before = performance.now(), summary = await runGoogleTaskDeleteScenario(scenario);
      results.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs: Math.round(performance.now() - before), summary });
    }
    const durationMs = Math.round(performance.now() - started);
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "google-task-delete", results, durationMs }) : `${results.map(item => `PASS ${item.id}`).join("\n")}\n${results.length} scenarios passed (${durationMs}ms).`);
    return 0;
  } catch (error) {
    const failure = error instanceof ScenarioFailure ? error : new ScenarioFailure("suite-unavailable", "The scenario run could not be completed.");
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "google-task-delete", error: { code: failure.code, message: failure.message, ...(scenarioId ? { scenarioId } : {}) } }) : `FAIL ${scenarioId ? `${scenarioId} ` : ""}${failure.code}: ${failure.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2));
