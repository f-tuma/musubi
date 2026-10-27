import { pathToFileURL } from "node:url";
import { loadWireTimestampSuite, runWireTimestampSuite } from "./wire-timestamps";

export function runWireTimestampCli(args: string[], write = (line: string) => process.stdout.write(`${line}\n`)) {
  try {
    const seen = new Set<string>();
    let filter: string | undefined, list = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (!["--json", "--list", "--scenario"].includes(flag) || seen.has(flag)) throw new Error("invalid-arguments");
      seen.add(flag);
      if (flag === "--list") list = true;
      if (flag === "--scenario") {
        filter = args[++index];
        if (!filter || !/^[a-z][a-z0-9-]{0,79}$/.test(filter)) throw new Error("invalid-arguments");
      }
    }
    if (list && filter) throw new Error("invalid-arguments");
    if (list) {
      const suite = loadWireTimestampSuite();
      write(JSON.stringify({ schemaVersion: 1, suite: suite.suite, scenarios: suite.scenarios.map(({ id, title }) => ({ id, title })) }));
      return 0;
    }
    const report = runWireTimestampSuite(filter);
    write(JSON.stringify(report));
    return report.results.some(result => result.status !== "passed") ? 1 : 0;
  } catch (error) {
    const code = error instanceof Error && ["invalid-arguments", "unknown-scenario"].includes(error.message)
      ? error.message : "invalid-suite";
    write(JSON.stringify({ schemaVersion: 1, suite: "wire-timestamps", error: { code } }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = runWireTimestampCli(process.argv.slice(2));
