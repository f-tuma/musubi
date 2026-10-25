import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseArguments, runBehavior, runCli } from "./test-behavior.mjs";

const manifests = {
  "google-delete": "packages/sync-runtime/src/behavior/google-delete.json",
  "google-create": "packages/sync-runtime/src/behavior/google-create.json",
  "google-task-update": "packages/sync-runtime/src/behavior/google-task-update.json",
  "microsoft-delete": "packages/sync-runtime/src/behavior/microsoft-delete.json",
  "microsoft-create": "packages/sync-runtime/src/behavior/microsoft-create.json",
  "caldav-delete": "packages/sync-runtime/src/behavior/caldav-delete.json",
  "caldav-create": "packages/sync-runtime/src/behavior/caldav-create.json",
  "task-delivery": "apps/api/src/sync/behavior/task-delivery.json",
  "task-inspector": "apps/web/src/tests/behavior/task-inspector.json",
};
const scenarios = [{ id: "first", title: "First behavior" }, { id: "second", title: "Second behavior" }];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "musubi-behavior-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of Object.values(manifests)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify({ schemaVersion: 1, scenarios }));
  }
  return root;
}

const runtime = (items = scenarios, extra = {}) => ({
  code: 0, stdout: JSON.stringify({ schemaVersion: 1, suite: "google-delete", durationMs: 5,
    results: items.map(item => ({ ...item, status: "passed", durationMs: 1 })), ...extra }), stderr: "",
});
const uiReport = (items = scenarios) => ({
  success: true, numTotalTests: items.length + 1, numPassedTests: items.length + 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: [{ assertionResults: [
    ...items.map(item => ({ title: `${item.id}: ${item.title}`, status: "passed", duration: 2 })),
    { title: "rejects malformed scenario input", status: "passed", duration: 1 },
  ] }],
});

test("invalid arguments are rejected before any suite starts", async t => {
  const root = await fixture(t);
  let launches = 0;
  for (const args of [
    ["--shell"], ["--suite"], ["--suite", "unknown"], ["--scenario", "first"],
    ["--suite", "google-delete", "--list", "--scenario", "first"], ["--json", "--json"],
    ["--suite", "google-delete", "--scenario", "$(touch /tmp/never)"],
  ]) {
    await assert.rejects(runBehavior(args, { root, execute: () => { launches++; } }));
  }
  assert.equal(launches, 0);
  assert.deepEqual(parseArguments(["--suite", "task-inspector", "--scenario", "first", "--json"]),
    { suite: "task-inspector", scenario: "first", list: false, json: true });
});

test("all manifests are preflighted, so an empty second suite starts no child", async t => {
  const root = await fixture(t);
  let launches = 0;
  for (const data of [{ schemaVersion: 1, scenarios: [] }, { schemaVersion: 1, scenarios: [scenarios[0], scenarios[0]] }, { schemaVersion: 2, scenarios }]) {
    await writeFile(join(root, manifests["task-inspector"]), JSON.stringify(data));
    await assert.rejects(runBehavior([], { root, execute: () => { launches++; } }));
  }
  assert.equal(launches, 0);
});

test("list returns only manifest ids/titles without booting either runner", async t => {
  const root = await fixture(t);
  const report = await runBehavior(["--list", "--json"], { root, execute: () => { throw new Error("must not launch"); } });
  assert.deepEqual(report, { schemaVersion: 1, suites: Object.keys(manifests).map(suite => ({ suite, scenarios })) });
});

test("runtime filtering uses a fixed executable and arguments, and strips arbitrary output fields", async t => {
  const root = await fixture(t);
  let launched;
  const report = await runBehavior(["--suite", "google-delete", "--scenario", "second"], {
    root, execute: async (command, args, options) => {
      launched = { command, args, options };
      return runtime([scenarios[1]], { privateDebug: "do not include" });
    },
  });
  assert.equal(launched.command, process.execPath);
  assert.deepEqual(launched.args, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/cli.ts"), "--json", "--scenario", "second"]);
  assert.equal(launched.options.cwd, root);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.suites[0].results, [{ ...scenarios[1], status: "passed", durationMs: 1 }]);
  assert.ok(!JSON.stringify(report).includes("privateDebug"));
});

test("CREATE selection launches only its fixed CLI and refuses DELETE evidence or unknown ids", async t => {
  const root = await fixture(t);
  let launches = 0;
  const args = ["--suite", "google-create", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs, options) => {
    launches++;
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/create-cli.ts"), "--json", "--scenario", "second"]);
    assert.equal(options.cwd, root);
    return runtime([scenarios[1]], { suite: "google-create" });
  } });
  assert.equal(launches, 1); assert.equal(report.passed, 1); assert.equal(report.suites[0].suite, "google-create");
  const wrongSuite = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]]) });
  assert.equal(wrongSuite.failed, 1);
  await assert.rejects(runBehavior(["--suite", "google-create", "--scenario", "missing"], {
    root, execute: async () => { throw new Error("Unknown id must not launch a process"); },
  }), /Unknown scenario/);
});

test("task delivery runs only its fixed module-port CLI and rejects another boundary's report", async t => {
  const root = await fixture(t), args = ["--suite", "task-delivery", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--experimental-test-module-mocks", "--experimental-default-type=module", "--import", "tsx",
      join(root, "apps/api/src/sync/behavior/task-delivery-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "task-delivery" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "google-create" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
  const portFailure = await runBehavior(args, { root, execute: async () => ({ code: 1, stderr: "PRIVATE PORT DETAIL",
    stdout: JSON.stringify({ schemaVersion: 1, suite: "task-delivery", error: { code: "unexpected-port", scenarioId: "second", message: "PRIVATE PORT DETAIL" } }) }) });
  assert.equal(portFailure.suites[0].errorCode, "unexpected-port"); assert.equal(portFailure.suites[0].scenarioId, "second");
  assert.ok(!JSON.stringify(portFailure).includes("PRIVATE"));
});

test("Google task UPDATE uses its fixed shared-kernel CLI and rejects an event suite report", async t => {
  const root = await fixture(t), args = ["--suite", "google-task-update", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/google-task-update-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "google-task-update" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "google-create" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
});

test("Graph selection uses its fixed CLI and rejects another provider's report", async t => {
  const root = await fixture(t);
  const args = ["--suite", "microsoft-delete", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/microsoft-delete-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "microsoft-delete" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]]) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
});

test("Graph CREATE selection uses only its action-specific CLI and evidence", async t => {
  const root = await fixture(t), args = ["--suite", "microsoft-create", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/microsoft-create-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "microsoft-create" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "microsoft-delete" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
});

test("DAV selection uses only its native CLI and rejects another provider's evidence", async t => {
  const root = await fixture(t);
  const args = ["--suite", "caldav-delete", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/caldav-delete-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "caldav-delete" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "microsoft-delete" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
});

test("DAV CREATE selection uses only its action-specific CLI and evidence", async t => {
  const root = await fixture(t), args = ["--suite", "caldav-create", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/caldav-create-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "caldav-create" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "caldav-delete" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
});

test("missing, duplicated, skipped, malformed or wrong-scope runtime evidence fails closed", async t => {
  const root = await fixture(t);
  const invalid = [
    { code: 0, stdout: "banner\n" + runtime().stdout },
    runtime([], {}), runtime([scenarios[0], scenarios[0]]), runtime(scenarios, { suite: "other" }),
    runtime(scenarios, { schemaVersion: 2 }), runtime(scenarios, { durationMs: -1 }),
    runtime(scenarios, { results: scenarios.map(item => ({ ...item, status: "skipped", durationMs: 1 })) }),
    runtime(scenarios, { results: scenarios.map(item => ({ ...item, title: "different", status: "passed", durationMs: 1 })) }),
    { ...runtime(), code: 1 },
  ];
  for (const output of invalid) {
    const report = await runBehavior(["--suite", "google-delete"], { root, execute: async () => output });
    assert.equal(report.passed, 0);
    assert.equal(report.failed, scenarios.length);
    assert.ok(report.suites[0].error);
  }
});

test("recognized runtime failures retain the selected id and bounded reason without provider text", async t => {
  const root = await fixture(t);
  const failure = { schemaVersion: 1, suite: "google-delete", error: {
    code: "expectation-mismatch", scenarioId: "second", message: "PRIVATE PROVIDER BODY", stack: "PRIVATE STACK",
  } };
  const report = await runBehavior(["--suite", "google-delete"], {
    root, execute: async () => ({ code: 1, stdout: JSON.stringify(failure), stderr: "PRIVATE STDERR" }),
  });
  assert.equal(report.failed, 2);
  assert.equal(report.suites[0].scenarioId, "second");
  assert.equal(report.suites[0].errorCode, "expectation-mismatch");
  assert.match(report.suites[0].error, /^google-delete\/second: expectation-mismatch\./);
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
  for (const invalid of [
    { ...failure, error: { ...failure.error, code: "PRIVATE UNKNOWN CODE" } },
    { ...failure, error: { ...failure.error, scenarioId: "PRIVATE UNKNOWN ID" } },
    { ...failure, suite: "other" },
  ]) {
    const rejected = await runBehavior(["--suite", "google-delete"], {
      root, execute: async () => ({ code: 1, stdout: JSON.stringify(invalid), stderr: "" }),
    });
    assert.equal(rejected.suites[0].errorCode, undefined);
    assert.equal(rejected.suites[0].scenarioId, undefined);
    assert.ok(!JSON.stringify(rejected).includes("PRIVATE"));
  }
});

test("UI receives an exact scenario filter, verifies the native report, and removes its temporary directory", async t => {
  const root = await fixture(t);
  let reportPath;
  const report = await runBehavior(["--suite", "task-inspector", "--scenario", "first"], {
    root, env: { MUSUBI_SCENARIO: "inherited-wrong-id", TEST_SETTING: "kept" },
    execute: async (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(args[0], join(root, "node_modules/vitest/vitest.mjs"));
      assert.equal(options.cwd, join(root, "apps/web"));
      assert.equal(options.env.MUSUBI_SCENARIO, "first");
      assert.equal(options.env.TEST_SETTING, "kept");
      reportPath = args.find(arg => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
      await writeFile(reportPath, JSON.stringify(uiReport([scenarios[0]])));
      return { code: 0, stdout: "Vitest output is not JSON", stderr: "" };
    },
  });
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 0);
  await assert.rejects(access(dirname(reportPath)));
});

test("UI resets an inherited filter when all scenarios are requested", async t => {
  const root = await fixture(t);
  const report = await runBehavior(["--suite", "task-inspector"], {
    root, env: { MUSUBI_SCENARIO: "first" }, execute: async (_command, args, options) => {
      assert.equal(options.env.MUSUBI_SCENARIO, "");
      await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(uiReport()));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(report.passed, 2);
});

test("UI cannot report success after ignoring the requested scenario filter", async t => {
  const root = await fixture(t);
  const report = await runBehavior(["--suite", "task-inspector", "--scenario", "first"], {
    root, execute: async (_command, args) => {
      await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(uiReport()));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 1);
  assert.match(report.suites[0].error, /outside the requested selection/);
});

test("valid failing UI evidence preserves passing scenarios and a bounded failing step", async t => {
  const root = await fixture(t);
  const evidence = uiReport();
  evidence.success = false;
  evidence.numPassedTests--;
  evidence.numFailedTests++;
  evidence.testResults[0].assertionResults[0] = {
    title: "first: First behavior", status: "failed", duration: 3,
    failureMessages: ["Error: first, step 3 (click)\nPRIVATE DOM AND NETWORK CONTENT"],
  };
  const output = [];
  const code = await runCli(["--suite", "task-inspector", "--json"], line => output.push(line), {
    root, execute: async (_command, args) => {
      await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(evidence));
      return { code: 1, stdout: "PRIVATE LOG", stderr: "" };
    },
  });
  assert.equal(code, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.errors, 0);
  assert.deepEqual(report.suites[0].results, [
    { ...scenarios[0], status: "failed", durationMs: 3, errorCode: "assertion-failed", step: 3, action: "click" },
    { ...scenarios[1], status: "passed", durationMs: 2 },
  ]);
  assert.ok(!output[0].includes("PRIVATE"));
});

test("a failed ancillary UI harness assertion fails the suite while preserving scenario successes", async t => {
  const root = await fixture(t);
  const evidence = uiReport();
  evidence.success = false;
  evidence.numPassedTests--;
  evidence.numFailedTests++;
  evidence.testResults[0].assertionResults.at(-1).status = "failed";
  const output = [];
  const code = await runCli(["--suite", "task-inspector", "--json"], line => output.push(line), {
    root, execute: async (_command, args) => {
      await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(evidence));
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(code, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.errors, 1);
  assert.equal(report.suites[0].errorCode, "harness-assertion-failed");
  assert.ok(report.suites[0].results.every(item => item.status === "passed"));
});

test("skipped, missing and false-green UI reports fail and still clean up", async t => {
  const root = await fixture(t);
  const skipped = uiReport();
  skipped.testResults[0].assertionResults[0].status = "pending";
  const missing = uiReport([scenarios[1]]);
  const failedGuard = uiReport();
  failedGuard.testResults[0].assertionResults.at(-1).status = "failed";
  const invalid = [skipped, missing, failedGuard, { ...uiReport(), success: false }, { ...uiReport(), numTotalTests: 0 }, null];
  for (const evidence of invalid) {
    let reportPath;
    const report = await runBehavior(["--suite", "task-inspector"], { root, execute: async (_command, args) => {
      reportPath = args.at(-1).slice("--outputFile=".length);
      if (evidence !== null) await writeFile(reportPath, JSON.stringify(evidence));
      return { code: 0, stdout: "", stderr: "" };
    } });
    assert.equal(report.passed, 0);
    assert.equal(report.failed, 2);
    await assert.rejects(access(dirname(reportPath)));
  }
});

test("default runs every fixed suite and emits one clean aggregate JSON document", async t => {
  const root = await fixture(t);
  let launches = 0;
  const output = [];
  const code = await runCli(["--json"], line => output.push(line), { root, execute: async (_command, args) => {
    launches++;
    if (args.includes("--import")) return runtime(scenarios, { suite: args.some(arg => arg.endsWith("/task-delivery-cli.ts")) ? "task-delivery" :
      args.some(arg => arg.endsWith("/google-task-update-cli.ts")) ? "google-task-update" :
      args.some(arg => arg.endsWith("/caldav-create-cli.ts")) ? "caldav-create" :
      args.some(arg => arg.endsWith("/microsoft-create-cli.ts")) ? "microsoft-create" :
      args.some(arg => arg.endsWith("/caldav-delete-cli.ts")) ? "caldav-delete" :
      args.some(arg => arg.endsWith("/microsoft-delete-cli.ts")) ? "microsoft-delete" :
      args.some(arg => arg.endsWith("/create-cli.ts")) ? "google-create" : "google-delete" });
    await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(uiReport()));
    return { code: 0, stdout: "NOISY CHILD STDOUT", stderr: "NOISY CHILD STDERR" };
  } });
  assert.equal(code, 0);
  assert.equal(launches, 9);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.passed, 18);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.suites.map(item => item.suite), Object.keys(manifests));
  assert.ok(!output[0].includes("NOISY"));
});

test("JSON preflight and subprocess failures stay parseable without leaking raw errors", async t => {
  const root = await fixture(t);
  for (const args of [["--json", "--unknown"], ["--json", "--suite", "google-delete"]]) {
    const output = [];
    const code = await runCli(args, line => output.push(line), { root, execute: async () => { throw new Error("PRIVATE CHILD DATA"); } });
    assert.equal(code, 1);
    assert.equal(output.length, 1);
    assert.equal(JSON.parse(output[0]).failed > 0, true);
    assert.ok(!output[0].includes("PRIVATE CHILD DATA"));
  }
});
