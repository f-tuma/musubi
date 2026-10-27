import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const SUITES = {
  "project-news": "apps/api/src/behavior/project-news.json",
  "read-attempt": "apps/api/src/sync/behavior/read-attempt.json",
  "fair-work": "packages/sync-runtime/src/behavior/fair-work.json",
  "caldav-discovery": "apps/api/src/sync/behavior/caldav-discovery.json",
  "google-delete": "packages/sync-runtime/src/behavior/google-delete.json",
  "google-update": "packages/sync-runtime/src/behavior/google-update.json",
  "google-create": "packages/sync-runtime/src/behavior/google-create.json",
  "google-task-update": "packages/sync-runtime/src/behavior/google-task-update.json",
  "google-task-delete": "packages/sync-runtime/src/behavior/google-task-delete.json",
  "google-task-create": "packages/sync-runtime/src/behavior/google-task-create.json",
  "microsoft-delete": "packages/sync-runtime/src/behavior/microsoft-delete.json",
  "microsoft-create": "packages/sync-runtime/src/behavior/microsoft-create.json",
  "caldav-delete": "packages/sync-runtime/src/behavior/caldav-delete.json",
  "caldav-create": "packages/sync-runtime/src/behavior/caldav-create.json",
  "google-rsvp-delivery": "apps/api/src/sync/behavior/google-rsvp-delivery.json",
  "task-delivery": "apps/api/src/sync/behavior/task-delivery.json",
  "event-delivery": "apps/api/src/sync/behavior/event-delivery.json",
  "task-inspector": "apps/web/src/tests/behavior/task-inspector.json",
};
const validDuration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

class BehaviorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

export function parseArguments(args) {
  const options = { json: false, list: false, suite: undefined, scenario: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--suite", "--scenario", "--list", "--json"].includes(flag) || seen.has(flag)) {
      throw new BehaviorError("Use --suite <name>, --scenario <id>, --list and --json without duplicate flags.");
    }
    seen.add(flag);
    if (flag === "--list" || flag === "--json") options[flag.slice(2)] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new BehaviorError(`${flag} requires a value.`);
      options[flag.slice(2)] = value;
    }
  }
  if (options.suite && !Object.hasOwn(SUITES, options.suite)) {
    throw new BehaviorError(`Unknown suite. Choose ${Object.keys(SUITES).join(", ")}.`);
  }
  if (options.scenario && !options.suite) throw new BehaviorError("--scenario requires --suite.");
  if (options.list && options.scenario) throw new BehaviorError("Choose either --list or --scenario.");
  return options;
}

async function selectScenarios(options, root) {
  const selection = [];
  for (const name of options.suite ? [options.suite] : Object.keys(SUITES)) {
    let data;
    try { data = JSON.parse(await readFile(join(root, SUITES[name]), "utf8")); }
    catch { throw new BehaviorError(`Cannot read the ${name} scenario manifest.`); }
    const ids = new Set();
    if (data.schemaVersion !== 1 || !Array.isArray(data.scenarios) || !data.scenarios.length) {
      throw new BehaviorError(`Invalid or empty ${name} scenario manifest.`);
    }
    for (const item of data.scenarios) {
      if (!item || typeof item.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id) || ids.has(item.id) ||
          typeof item.title !== "string" || !item.title.trim()) {
        throw new BehaviorError(`Invalid or duplicate scenario metadata in ${name}.`);
      }
      ids.add(item.id);
    }
    const scenarios = data.scenarios.filter(item => !options.scenario || item.id === options.scenario)
      .map(({ id, title }) => ({ id, title }));
    if (!scenarios.length) throw new BehaviorError(`Unknown scenario in ${name}. Use --list to see available ids.`);
    selection.push({ name, scenarios });
  }
  return selection;
}

export function executeChild(command, args, { cwd, env }) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, env, shell: false, timeout: 120_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", overflow = false;
    const collect = channel => chunk => {
      if (overflow) return;
      if (stdout.length + stderr.length + chunk.length > 2_000_000) {
        overflow = true;
        child.kill("SIGKILL");
      } else if (channel === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", () => resolveResult({ code: null, stdout: "", stderr: "Runner could not start." }));
    child.on("close", code => resolveResult({ code: overflow ? null : code, stdout, stderr }));
  });
}

function runtimeResults(output, selection) {
  let report;
  try { report = JSON.parse(output); } catch { throw new BehaviorError("Runner did not return a valid JSON report."); }
  const errorCodes = new Set(["invalid-arguments", "unknown-scenario", "invalid-suite", "suite-unavailable",
    "exchange-mismatch", "unconsumed-exchange", "unexpected-port", "unconsumed-port", "concurrent-run", "expectation-mismatch"]);
  if (report?.schemaVersion === 1 && report.suite === selection.name && report.error && !Object.hasOwn(report, "results") &&
      errorCodes.has(report.error.code) && (report.error.scenarioId === undefined ||
        selection.scenarios.some(item => item.id === report.error.scenarioId))) {
    const { code, scenarioId } = report.error;
    throw new BehaviorError(`${selection.name}${scenarioId ? `/${scenarioId}` : ""}: ${code}. Run the selected suite directly for assertion details.`,
      { errorCode: code, ...(scenarioId ? { scenarioId } : {}) });
  }
  if (report.schemaVersion !== 1 || report.suite !== selection.name || !validDuration(report.durationMs) ||
      !Array.isArray(report.results) || report.results.length !== selection.scenarios.length) {
    throw new BehaviorError("Runner report does not match the selected scenarios.");
  }
  const results = selection.scenarios.map(scenario => {
    const matching = report.results.filter(item => item?.id === scenario.id);
    const result = matching[0];
    if (matching.length !== 1 || result.title !== scenario.title || !["passed", "failed"].includes(result.status) || !validDuration(result.durationMs)) {
      throw new BehaviorError("Runner report has missing, duplicate or invalid scenario results.");
    }
    return { ...scenario, status: result.status, durationMs: result.durationMs };
  });
  return results;
}

function uiResults(report, selection) {
  const assertions = report.testResults?.flatMap(file => file.assertionResults ?? []);
  if (!Array.isArray(assertions) || !assertions.length || report.numTotalTests !== assertions.length ||
      report.numPassedTests !== assertions.filter(item => item.status === "passed").length ||
      report.numFailedTests !== assertions.filter(item => item.status === "failed").length ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
      assertions.some(item => !["passed", "failed"].includes(item.status)) || report.success !== (report.numFailedTests === 0)) {
    throw new BehaviorError("UI report is incomplete, skipped or inconsistent.");
  }
  const selectedTitles = new Set(selection.scenarios.map(item => `${item.id}: ${item.title}`));
  if (assertions.some(item => /^[a-z][a-z0-9-]{0,79}: /.test(item.title) && !selectedTitles.has(item.title))) {
    throw new BehaviorError("UI runner executed a scenario outside the requested selection.");
  }
  const results = selection.scenarios.map(scenario => {
    const matching = assertions.filter(item => item.title === `${scenario.id}: ${scenario.title}`);
    const result = matching[0];
    if (matching.length !== 1 || !validDuration(result.duration)) {
      throw new BehaviorError("UI report does not contain every selected scenario exactly once.");
    }
    const context = result.status === "failed" && Array.isArray(result.failureMessages)
      ? result.failureMessages.filter(item => typeof item === "string").join("\n")
        .match(new RegExp(`${scenario.id}, step ([1-9]\\d{0,3}) \\((click|fill|expect|expect-value)\\)`)) : null;
    return { ...scenario, status: result.status, durationMs: result.duration,
      ...(result.status === "failed" ? { errorCode: "assertion-failed" } : {}),
      ...(context ? { step: Number(context[1]), action: context[2] } : {}) };
  });
  return { results, ancillaryFailed: assertions.some(item => item.status === "failed" && !selectedTitles.has(item.title)) };
}

async function runSuite(selection, options, { root, execute, env }) {
  const started = performance.now();
  let directory;
  try {
    let child, results, ancillaryFailed = false, uiFailed = false;
    if (["fair-work", "google-update", "google-delete", "google-create", "google-task-update", "google-task-delete", "google-task-create", "microsoft-delete", "microsoft-create", "caldav-delete", "caldav-create"].includes(selection.name)) {
      const entry = { "fair-work": "fair-work-cli.ts", "google-update": "google-update-cli.ts", "google-delete": "cli.ts", "google-create": "create-cli.ts", "google-task-update": "google-task-update-cli.ts", "google-task-delete": "google-task-delete-cli.ts", "google-task-create": "google-task-create-cli.ts", "microsoft-delete": "microsoft-delete-cli.ts", "microsoft-create": "microsoft-create-cli.ts", "caldav-delete": "caldav-delete-cli.ts", "caldav-create": "caldav-create-cli.ts" }[selection.name];
      child = await execute(process.execPath, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior", entry), "--json",
        ...(options.scenario ? ["--scenario", options.scenario] : [])], { cwd: root, env });
      results = runtimeResults(child.stdout, selection);
    } else if (selection.name === "project-news") {
      child = await execute(process.execPath, ["--import", "tsx", join(root, "apps/api/src/behavior/project-news-cli.ts"), "--json",
        ...(options.scenario ? ["--scenario", options.scenario] : [])], { cwd: root, env });
      results = runtimeResults(child.stdout, selection);
    } else if (selection.name === "read-attempt") {
      child = await execute(process.execPath, ["--import", "tsx", join(root, "apps/api/src/sync/behavior/read-attempt-cli.ts"), "--json",
        ...(options.scenario ? ["--scenario", options.scenario] : [])], { cwd: root, env });
      results = runtimeResults(child.stdout, selection);
    } else if (["caldav-discovery", "task-delivery", "event-delivery", "google-rsvp-delivery"].includes(selection.name)) {
      child = await execute(process.execPath, ["--experimental-test-module-mocks", "--experimental-default-type=module", "--import", "tsx",
        join(root, `apps/api/src/sync/behavior/${selection.name}-cli.ts`), "--json",
        ...(options.scenario ? ["--scenario", options.scenario] : [])], { cwd: root, env });
      results = runtimeResults(child.stdout, selection);
    } else {
      directory = await mkdtemp(join(tmpdir(), "musubi-behavior-"));
      const reportPath = join(directory, "vitest.json");
      child = await execute(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--project=unit",
        "src/tests/behavior/task-inspector.scenarios.test.tsx", "--reporter=json", `--outputFile=${reportPath}`],
      { cwd: join(root, "apps/web"), env: { ...env, MUSUBI_SCENARIO: options.scenario ?? "" } });
      let report;
      try { report = JSON.parse(await readFile(reportPath, "utf8")); }
      catch { throw new BehaviorError("UI runner did not write a valid JSON report."); }
      ({ results, ancillaryFailed } = uiResults(report, selection));
      uiFailed = report.numFailedTests > 0;
    }
    if (child.code !== 0 && !(selection.name === "task-inspector" && child.code === 1 && uiFailed)) {
      throw new BehaviorError("Runner exited unsuccessfully; run the selected suite directly for assertion details.");
    }
    return { suite: selection.name, results, passed: results.filter(item => item.status === "passed").length,
      failed: results.filter(item => item.status === "failed").length, errors: ancillaryFailed ? 1 : 0,
      durationMs: Math.round(performance.now() - started),
      ...(ancillaryFailed ? { error: "A UI harness assertion failed; run the selected suite directly for details.", errorCode: "harness-assertion-failed" } : {}) };
  } catch (error) {
    return { suite: selection.name, results: selection.scenarios.map(item => ({ ...item, status: "failed", durationMs: 0 })),
      passed: 0, failed: selection.scenarios.length, errors: 0, durationMs: Math.round(performance.now() - started),
      error: error instanceof BehaviorError ? error.message : "The suite could not be completed.",
      ...(error instanceof BehaviorError ? error.details : {}) };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function runBehavior(args, { root = REPOSITORY, execute = executeChild, env = process.env } = {}) {
  const started = performance.now();
  const options = parseArguments(args);
  const selection = await selectScenarios(options, resolve(root));
  if (options.list) return { schemaVersion: 1, suites: selection.map(item => ({ suite: item.name, scenarios: item.scenarios })) };
  const suites = [];
  for (const item of selection) suites.push(await runSuite(item, options, { root: resolve(root), execute, env }));
  return { schemaVersion: 1, suites, passed: suites.reduce((sum, suite) => sum + suite.passed, 0),
    failed: suites.reduce((sum, suite) => sum + suite.failed, 0), errors: suites.reduce((sum, suite) => sum + suite.errors, 0),
    durationMs: Math.round(performance.now() - started) };
}

export async function runCli(args, write = line => process.stdout.write(`${line}\n`), dependencies = {}) {
  try {
    const report = await runBehavior(args, dependencies);
    if (args.includes("--json")) write(JSON.stringify(report));
    else if (args.includes("--list")) {
      write(report.suites.flatMap(suite => suite.scenarios.map(item => `${suite.suite}/${item.id}: ${item.title}`)).join("\n"));
    } else {
      write(report.suites.map(suite => `${suite.failed || suite.errors ? "FAIL" : "PASS"} ${suite.suite}: ${suite.passed} passed, ${suite.failed} failed (${suite.durationMs}ms)${suite.error ? `\n  ${suite.error}` : ""}`).join("\n") +
        `\n${report.passed} scenarios passed, ${report.failed} failed${report.errors ? `, ${report.errors} suite errors` : ""} (${report.durationMs}ms).`);
    }
    return report.failed || report.errors ? 1 : 0;
  } catch (error) {
    const message = error instanceof BehaviorError ? error.message : "The behavior command could not be completed.";
    write(args.includes("--json") ? JSON.stringify({ schemaVersion: 1, suites: [], passed: 0, failed: 1, durationMs: 0, error: message }) : `FAIL ${message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
