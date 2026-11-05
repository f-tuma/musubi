import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refreshedOAuthScope } from "../oauth-scopes";

const suite = JSON.parse(readFileSync(new URL("./oauth-scopes.json", import.meta.url), "utf8")) as {
  scenarios: Array<{ id: string; title: string; previous: string | null; next?: string; expected: string | null }>;
};
const started = performance.now();
let scenarioId: string | undefined;
try {
  const args = process.argv.slice(2), seen = new Set<string>();
  let selected: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    assert.ok(["--json", "--list", "--scenario"].includes(flag) && !seen.has(flag), "Invalid arguments");
    seen.add(flag);
    if (flag === "--scenario") { selected = args[++i]; assert.match(selected ?? "", /^[a-z][a-z0-9-]{0,79}$/); }
  }
  assert.ok(!seen.has("--list") || !selected, "Choose list or scenario");
  const scenarios = suite.scenarios.filter(s => !selected || s.id === selected);
  assert.ok(scenarios.length, "Unknown scenario");
  if (seen.has("--list")) console.log(JSON.stringify({ schemaVersion: 1, suite: "oauth-scopes", scenarios: scenarios.map(({ id, title }) => ({ id, title })) }));
  else {
    const results = scenarios.map(s => {
      scenarioId = s.id;
      const before = performance.now();
      assert.equal(refreshedOAuthScope(s.previous, s.next) ?? null, s.expected);
      return { id: s.id, title: s.title, status: "passed", durationMs: performance.now() - before };
    });
    console.log(JSON.stringify({ schemaVersion: 1, suite: "oauth-scopes", results, durationMs: performance.now() - started }));
  }
} catch {
  console.log(JSON.stringify({ schemaVersion: 1, suite: "oauth-scopes", error: { code: "expectation-mismatch", ...(scenarioId ? { scenarioId } : {}) } }));
  process.exitCode = 1;
}
