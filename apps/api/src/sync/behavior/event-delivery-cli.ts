import { pathToFileURL } from "node:url";
import { loadEventDeliverySuite, runEventDeliveryScenario, EventDeliveryScenarioFailure } from "./event-delivery-driver";

export async function runEventDeliveryCli(args: string[], write: (line: string) => void = line => process.stdout.write(`${line}\n`)): Promise<number> {
  const json = args.includes("--json"), started = performance.now();
  let scenarioId: string | undefined;
  try {
    const seen = new Set<string>(); let selected: string | undefined, list = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (!["--json", "--list", "--scenario"].includes(flag) || seen.has(flag)) throw new EventDeliveryScenarioFailure("invalid-arguments", "Use --list or --scenario <id>, and optional --json.");
      seen.add(flag);
      if (flag === "--list") list = true;
      if (flag === "--scenario") { selected = args[++index]; if (!selected || !/^[a-z][a-z0-9-]{0,79}$/.test(selected)) throw new EventDeliveryScenarioFailure("invalid-arguments", "Use one valid scenario id."); }
    }
    if (list && selected) throw new EventDeliveryScenarioFailure("invalid-arguments", "Choose either --list or --scenario.");
    const suite = await loadEventDeliverySuite();
    if (list) { const scenarios = suite.scenarios.map(({ id, title }) => ({ id, title })); write(json ? JSON.stringify({ schemaVersion: 1, suite: "event-delivery", scenarios }) : scenarios.map(item => `${item.id}: ${item.title}`).join("\n")); return 0; }
    const selectedScenarios = suite.scenarios.filter(item => !selected || item.id === selected);
    if (!selectedScenarios.length) throw new EventDeliveryScenarioFailure("unknown-scenario", "The requested scenario id is not in this suite.");
    const results = [];
    for (const scenario of selectedScenarios) { scenarioId = scenario.id; const before = performance.now(), summary = await runEventDeliveryScenario(scenario); results.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs: Math.round(performance.now() - before), summary }); }
    const durationMs = Math.round(performance.now() - started);
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "event-delivery", results, durationMs }) : `${results.map(item => `PASS ${item.id}`).join("\n")}\n${results.length} scenarios passed (${durationMs}ms).`); return 0;
  } catch (error) {
    const failure = error instanceof EventDeliveryScenarioFailure ? error : new EventDeliveryScenarioFailure("suite-unavailable", "The scenario run could not be completed.");
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "event-delivery", error: { code: failure.code, message: failure.message, ...(scenarioId ? { scenarioId } : {}) } }) : `FAIL ${scenarioId ?? ""} ${failure.code}: ${failure.message}`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runEventDeliveryCli(process.argv.slice(2));
