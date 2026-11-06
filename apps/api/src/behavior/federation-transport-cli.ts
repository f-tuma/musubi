import { pathToFileURL } from "node:url";
import {
  FederationTransportScenarioFailure,
  federationTransportUnhandledRejections,
  installFederationTransportIsolation,
  loadFederationTransportSuite,
  runFederationTransportScenario,
} from "./federation-transport-driver";

export async function runFederationTransportCli(args: string[], write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
  const started = performance.now(), json = args.includes("--json");
  let scenarioId: string | undefined;
  try {
    const seen = new Set<string>(); let selected: string | undefined, list = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (!["--json", "--list", "--scenario"].includes(flag) || seen.has(flag))
        throw new FederationTransportScenarioFailure("invalid-arguments", "Use --list or --scenario <id>, and optional --json.");
      seen.add(flag);
      if (flag === "--list") list = true;
      if (flag === "--scenario") {
        selected = args[++index];
        if (!selected || !/^[a-z][a-z0-9-]{0,79}$/.test(selected))
          throw new FederationTransportScenarioFailure("invalid-arguments", "Use one valid scenario id.");
      }
    }
    if (list && selected) throw new FederationTransportScenarioFailure("invalid-arguments", "Choose either list or scenario.");
    const suite = await loadFederationTransportSuite();
    if (list) {
      const scenarios = suite.scenarios.map(({ id, title }) => ({ id, title }));
      write(json ? JSON.stringify({ schemaVersion: 1, suite: suite.suite, scenarios }) : scenarios.map((item) => `${item.id}: ${item.title}`).join("\n"));
      return 0;
    }
    const selectedScenarios = suite.scenarios.filter((item) => !selected || item.id === selected);
    if (!selectedScenarios.length) throw new FederationTransportScenarioFailure("unknown-scenario", "The requested scenario is not in this suite.");
    installFederationTransportIsolation();
    const results = [];
    for (const scenario of selectedScenarios) {
      scenarioId = scenario.id;
      const before = performance.now(), summary = await runFederationTransportScenario(scenario);
      results.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs: Math.round(performance.now() - before), summary });
    }
    scenarioId = undefined;
    if (federationTransportUnhandledRejections() > 0)
      throw new FederationTransportScenarioFailure("expectation-mismatch", "An unhandled rejection reached the driver process.");
    const durationMs = Math.round(performance.now() - started);
    write(json ? JSON.stringify({ schemaVersion: 1, suite: suite.suite, results, durationMs })
      : `${results.map((item) => `PASS ${item.id}`).join("\n")}\n${results.length} scenarios passed (${durationMs}ms).`);
    return 0;
  } catch (error) {
    const failure = error instanceof FederationTransportScenarioFailure ? error
      : new FederationTransportScenarioFailure("expectation-mismatch", `The federation transport scenario failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "federation-transport", error: { code: failure.code, message: failure.message, ...(scenarioId ? { scenarioId } : {}) } })
      : `FAIL ${scenarioId ?? ""} ${failure.code}: ${failure.message}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runFederationTransportCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
