import { pathToFileURL } from "node:url";
import {
  loadCollectionReadsSuite,
  runCollectionReadsScenario,
} from "./collection-reads-driver";

export async function runCli(args: string[]) {
  const started = performance.now();
  let selected: string | undefined;
  try {
    const seen = new Set<string>();
    let list = false;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (seen.has(flag) || !["--json", "--list", "--scenario"].includes(flag))
        throw Error("invalid-arguments");
      seen.add(flag);
      if (flag === "--list") list = true;
      if (flag === "--scenario") {
        selected = args[++i];
        if (!selected || !/^[a-z][a-z0-9-]{0,79}$/.test(selected))
          throw Error("invalid-arguments");
      }
    }
    if (list && selected) throw Error("invalid-arguments");
    const suite = await loadCollectionReadsSuite();
    if (list) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          suite: suite.suite,
          scenarios: suite.scenarios.map(({ id, title }) => ({ id, title })),
        }),
      );
      return 0;
    }
    const chosen = suite.scenarios.filter(
      (s) => !selected || s.id === selected,
    );
    if (!chosen.length) throw Error("unknown-scenario");
    const results = [];
    for (const s of chosen) {
      const at = performance.now(),
        summary = await runCollectionReadsScenario(s);
      results.push({
        id: s.id,
        title: s.title,
        status: "passed",
        durationMs: Math.round(performance.now() - at),
        summary,
      });
    }
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        suite: suite.suite,
        results,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    return 0;
  } catch (error) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        suite: "collection-reads",
        error: {
          code:
            error instanceof Error &&
            ["invalid-arguments", "unknown-scenario"].includes(error.message)
              ? error.message
              : "expectation-mismatch",
          scenarioId: selected,
        },
      }),
    );
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
