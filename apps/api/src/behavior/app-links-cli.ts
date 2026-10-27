import { runAppLinksSuite } from "./app-links";

function main() {
  const args = process.argv.slice(2), seen = new Set<string>();
  let filter: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!["--json", "--scenario"].includes(flag) || seen.has(flag)) throw new Error("invalid-arguments");
    seen.add(flag);
    if (flag === "--scenario") {
      filter = args[++index];
      if (!filter || filter.startsWith("--")) throw new Error("invalid-arguments");
    }
  }
  const report = runAppLinksSuite(filter);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.results.some(result => result.status !== "passed")) process.exitCode = 1;
}

try { main(); }
catch (error) {
  const code = error instanceof Error && ["invalid-arguments", "unknown-scenario"].includes(error.message)
    ? error.message : "invalid-suite";
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, suite: "app-links", error: { code } })}\n`);
  process.exitCode = 1;
}
