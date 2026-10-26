import { pathToFileURL } from "node:url";
import { loadFairWorkSuite, runFairWorkScenario } from "./fair-work";

export async function runCli(args: string[], write = (line: string) => process.stdout.write(`${line}\n`)) {
  const started = performance.now(), json = args.includes("--json");
  let scenarioId: string | undefined;
  try {
    const seen = new Set<string>(); let list = false, selected: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!; if (seen.has(flag) || !["--json", "--list", "--scenario"].includes(flag)) throw new Error("Invalid arguments.");
      seen.add(flag); if (flag === "--list") list = true;
      if (flag === "--scenario") { selected = args[++i]; if (!selected || !/^[a-z][a-z0-9-]{0,79}$/.test(selected)) throw new Error("Invalid scenario."); }
    }
    if (list && selected) throw new Error("Choose list or scenario.");
    const suite = await loadFairWorkSuite();
    if (list) { write(JSON.stringify({ schemaVersion: 1, suite: "fair-work", scenarios: suite.scenarios.map(({ id, title }) => ({ id, title })) })); return 0; }
    const scenarios = suite.scenarios.filter(s => !selected || s.id === selected); if (!scenarios.length) throw new Error("Unknown scenario.");
    const results = [];
    for (const scenario of scenarios) { scenarioId = scenario.id; const at = performance.now(); const summary = await runFairWorkScenario(scenario);
      results.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs: Math.round(performance.now() - at), summary }); }
    write(json ? JSON.stringify({ schemaVersion: 1, suite: "fair-work", results, durationMs: Math.round(performance.now() - started) }) : results.map(r => `PASS ${r.id}`).join("\n")); return 0;
  } catch (error) {
    write(JSON.stringify({ schemaVersion: 1, suite: "fair-work", error: { code: "expectation-mismatch", message: error instanceof Error ? error.message : "Scenario failed.", scenarioId } })); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2));
