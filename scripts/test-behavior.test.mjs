import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseArguments, runBehavior, runCli } from "./test-behavior.mjs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { executeChild } from "./test-behavior.mjs";

const manifests = {
  "oauth-scopes": "packages/db/src/queries/behavior/oauth-scopes.json",
  "wire-timestamps": "packages/types/src/behavior/wire-timestamps.json",
  "api-json-body": "apps/api/src/behavior/api-json-body.json",
  "app-links": "apps/api/src/behavior/app-links.json",
  "postgres-restore": "ops/behavior/postgres-restore.json",
  "web-edge": "apps/web/src/tests/behavior/web-edge.json",
  "project-news": "apps/api/src/behavior/project-news.json",
  "federation-transport": "apps/api/src/behavior/federation-transport.json",
  "read-attempt": "apps/api/src/sync/behavior/read-attempt.json",
  "sync-outcome": "apps/api/src/sync/behavior/sync-outcome.json",
  "collection-reads": "apps/api/src/sync/behavior/collection-reads.json",
  "dav-response": "apps/api/src/sync/behavior/dav-response.json",
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

test("release boundaries use fixed CLIs and reject another boundary's report", async t => {
  const root = await fixture(t);
  for (const [suite, prefix, file] of [
    ["oauth-scopes", ["--import", "tsx"], "packages/db/src/queries/behavior/oauth-scopes-cli.ts"],
    ["wire-timestamps", ["--import", "tsx"], "packages/types/src/behavior/wire-timestamps-cli.ts"],
    ["api-json-body", ["--import", "tsx"], "apps/api/src/behavior/api-json-body-cli.ts"],
    ["app-links", ["--import", "tsx"], "apps/api/src/behavior/app-links-cli.ts"],
    ["federation-transport", ["--import", "tsx"], "apps/api/src/behavior/federation-transport-cli.ts"],
    ["postgres-restore", [], "ops/behavior/postgres-restore-cli.mjs"],
  ]) {
    const selected = await runBehavior(["--suite", suite, "--scenario", "first"], {
      root, execute: async (command, args) => {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, [...prefix, join(root, file), "--json", "--scenario", "first"]);
        return runtime([scenarios[0]], { suite });
      },
    });
    assert.equal(selected.passed, 1);
    const wrong = await runBehavior(["--suite", suite], { root, execute: async () => runtime() });
    assert.equal(wrong.failed, scenarios.length);
  }
});

test("web edge uses its own production-route test with the selected scenario filter", async t => {
  const root = await fixture(t);
  const report = await runBehavior(["--suite", "web-edge", "--scenario", "second"], {
    root, execute: async (_command, args, { env }) => {
      assert.ok(args.includes("src/tests/behavior/web-edge.scenarios.test.ts"));
      assert.ok(!args.includes("src/tests/behavior/task-inspector.scenarios.test.tsx"));
      assert.equal(env.MUSUBI_SCENARIO, "second");
      await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(uiReport([scenarios[1]])));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(report.passed, 1);
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

test("read attempt selection uses only its fixed production timer-port CLI", async t => {
  const root = await fixture(t), args = ["--suite", "read-attempt", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "apps/api/src/sync/behavior/read-attempt-cli.ts"), "--json", "--scenario", "second"]);
    assert.equal(options.cwd, root);
    return runtime([scenarios[1]], { suite: "read-attempt" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "fair-work" }) });
  assert.equal(wrong.failed, 1);
});

test("Google event UPDATE uses its fixed production-kernel CLI and rejects another action", async t => {
  const root = await fixture(t), args = ["--suite", "google-update", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/google-update-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "google-update" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "google-delete" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
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

test("Google task DELETE uses its own fixed CLI and refuses an UPDATE report", async t => {
  const root = await fixture(t), args = ["--suite", "google-task-delete", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/google-task-delete-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "google-task-delete" });
  } });
  assert.equal(report.passed, 1); assert.equal(report.errors, 0);
  const wrong = await runBehavior(args, { root, execute: async () => runtime([scenarios[1]], { suite: "google-task-update" }) });
  assert.equal(wrong.failed, 1); assert.equal(wrong.suites[0].results[0].status, "failed");
});

test("Google task CREATE uses its generated-address CLI and refuses an event CREATE report", async t => {
  const root = await fixture(t), args = ["--suite", "google-task-create", "--scenario", "second"];
  const report = await runBehavior(args, { root, execute: async (command, childArgs) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(childArgs, ["--import", "tsx", join(root, "packages/sync-runtime/src/behavior/google-task-create-cli.ts"), "--json", "--scenario", "second"]);
    return runtime([scenarios[1]], { suite: "google-task-create" });
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
    if (args.some(arg => arg.endsWith("/postgres-restore-cli.mjs"))) return runtime(scenarios, { suite: "postgres-restore" });
    if (args.includes("--import")) return runtime(scenarios, { suite: args.some(arg => arg.endsWith("/oauth-scopes-cli.ts")) ? "oauth-scopes" : args.some(arg => arg.endsWith("/wire-timestamps-cli.ts")) ? "wire-timestamps" : args.some(arg => arg.endsWith("/api-json-body-cli.ts")) ? "api-json-body" : args.some(arg => arg.endsWith("/app-links-cli.ts")) ? "app-links" : args.some(arg => arg.endsWith("/project-news-cli.ts")) ? "project-news" : args.some(arg => arg.endsWith("/federation-transport-cli.ts")) ? "federation-transport" : args.some(arg => arg.endsWith("/read-attempt-cli.ts")) ? "read-attempt" : args.some(arg => arg.endsWith("/sync-outcome-cli.ts")) ? "sync-outcome" : args.some(arg => arg.endsWith("/fair-work-cli.ts")) ? "fair-work" : args.some(arg => arg.endsWith("/caldav-discovery-cli.ts")) ? "caldav-discovery" : args.some(arg => arg.endsWith("/google-rsvp-delivery-cli.ts")) ? "google-rsvp-delivery" : args.some(arg => arg.endsWith("/event-delivery-cli.ts")) ? "event-delivery" : args.some(arg => arg.endsWith("/task-delivery-cli.ts")) ? "task-delivery" :
      args.some(arg => arg.endsWith("/collection-reads-cli.ts")) ? "collection-reads" :
      args.some(arg => arg.endsWith("/dav-response-cli.ts")) ? "dav-response" :
      args.some(arg => arg.endsWith("/google-task-create-cli.ts")) ? "google-task-create" :
      args.some(arg => arg.endsWith("/google-task-delete-cli.ts")) ? "google-task-delete" :
      args.some(arg => arg.endsWith("/google-task-update-cli.ts")) ? "google-task-update" :
      args.some(arg => arg.endsWith("/google-update-cli.ts")) ? "google-update" :
      args.some(arg => arg.endsWith("/caldav-create-cli.ts")) ? "caldav-create" :
      args.some(arg => arg.endsWith("/microsoft-create-cli.ts")) ? "microsoft-create" :
      args.some(arg => arg.endsWith("/caldav-delete-cli.ts")) ? "caldav-delete" :
      args.some(arg => arg.endsWith("/microsoft-delete-cli.ts")) ? "microsoft-delete" :
      args.some(arg => arg.endsWith("/create-cli.ts")) ? "google-create" : "google-delete" });
    await writeFile(args.at(-1).slice("--outputFile=".length), JSON.stringify(uiReport()));
    return { code: 0, stdout: "NOISY CHILD STDOUT", stderr: "NOISY CHILD STDERR" };
  } });
  assert.equal(code, 0);
  assert.equal(launches, Object.keys(manifests).length);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.passed, Object.keys(manifests).length * scenarios.length);
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

// CP02 2.1a: the real root entry, one real production driver per runSuite branch, and a real child error through the root glue.
const repository = fileURLToPath(new URL("../", import.meta.url));
const representatives = [
  ["google-delete", "already-absent"], // sync-runtime CLI via --import tsx
  ["oauth-scopes", "reordered-grant"], // db query CLI
  ["wire-timestamps", "availability-minute-utc"], // public types CLI
  ["app-links", "unconfigured-is-not-associated"], // apps/api behavior CLI
  ["postgres-restore", "create-failure"], // shipped ops .mjs without tsx
  ["read-attempt", "steady-large-pagination"], // apps/api sync CLI
  ["task-delivery", "ack-signal-forwarded"], // module-mock CLI
  ["web-edge", "worker-response-bypasses-caches"], // Vitest UI project
];
const validDuration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

async function realManifest(suite) {
  return JSON.parse(await readFile(join(repository, manifests[suite]), "utf8"));
}

async function realScenario(suite, id) {
  const item = (await realManifest(suite)).scenarios.find(scenario => scenario.id === id);
  assert.ok(item, `${suite}/${id} is missing from ${manifests[suite]}; choose a current representative id`);
  return { id: item.id, title: item.title };
}

function rootEntry(args) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [join(repository, "scripts/test-behavior.mjs"), ...args],
      { cwd: repository, shell: false, timeout: 120_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => resolveResult({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", code => resolveResult({ code, stdout, stderr }));
  });
}

function singleJsonDocument(stdout) {
  const lines = stdout.split("\n").filter(line => line.length);
  assert.equal(lines.length, 1, `expected exactly one JSON line on stdout, got ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

test("T-A root entry: the package script's real process emits one JSON document with real exit codes", async () => {
  const pkg = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  assert.equal(pkg.scripts["test:behavior"], "node scripts/test-behavior.mjs");
  const expected = await realScenario("google-delete", "already-absent");

  const positive = await rootEntry(["--suite", "google-delete", "--scenario", "already-absent", "--json"]);
  assert.equal(positive.code, 0, positive.stderr);
  const report = singleJsonDocument(positive.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual([report.passed, report.failed, report.errors], [1, 0, 0]);
  assert.equal(report.suites.length, 1);
  assert.equal(report.suites[0].suite, "google-delete");
  assert.equal(report.suites[0].results.length, 1);
  const [result] = report.suites[0].results;
  assert.deepEqual({ id: result.id, title: result.title, status: result.status }, { ...expected, status: "passed" });
  assert.ok(validDuration(result.durationMs) && validDuration(report.suites[0].durationMs) && validDuration(report.durationMs));

  const unknownScenario = await rootEntry(["--suite", "google-delete", "--scenario", "no-such-id", "--json"]);
  assert.equal(unknownScenario.code, 1);
  const unknownScenarioReport = singleJsonDocument(unknownScenario.stdout);
  assert.equal(unknownScenarioReport.failed, 1);
  assert.deepEqual(unknownScenarioReport.suites, []);
  assert.match(unknownScenarioReport.error, /^Unknown scenario in google-delete/);

  const unknownSuite = await rootEntry(["--suite", "no-such-suite", "--json"]);
  assert.equal(unknownSuite.code, 1);
  assert.equal(singleJsonDocument(unknownSuite.stdout).failed, 1);

  const list = await rootEntry(["--list", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  const suites = [];
  for (const suite of Object.keys(manifests)) {
    suites.push({ suite, scenarios: (await realManifest(suite)).scenarios.map(({ id, title }) => ({ id, title })) });
  }
  assert.deepEqual(singleJsonDocument(list.stdout), { schemaVersion: 1, suites });
});

for (const [suite, id] of representatives) {
  test(`T-B ${suite}: its runSuite branch runs the real production driver for ${id}`, async () => {
    const expected = await realScenario(suite, id);
    const report = await runBehavior(["--suite", suite, "--scenario", id]);
    assert.deepEqual([report.passed, report.failed, report.errors], [1, 0, 0], JSON.stringify(report));
    assert.equal(report.suites.length, 1);
    const [run] = report.suites;
    assert.equal(run.suite, suite);
    assert.ok(!Object.hasOwn(run, "error") && !Object.hasOwn(run, "errorCode"));
    assert.deepEqual(run.results.map(item => ({ id: item.id, title: item.title, status: item.status })), [{ ...expected, status: "passed" }]);
    assert.ok(run.results.every(item => validDuration(item.durationMs)));
    assert.ok(validDuration(run.durationMs) && validDuration(report.durationMs));
  });
}

for (const [suite, id] of [["google-delete", "already-absent"], ["task-delivery", "ack-signal-forwarded"]]) {
  test(`T-C ${suite}: a real child's unknown-scenario error reaches the root as a bounded code without child text`, async () => {
    const expected = await realScenario(suite, id);
    let child;
    const execute = async (command, args, options) => {
      const index = args.indexOf("--scenario");
      assert.equal(args[index + 1], id);
      child = await executeChild(command, args.with(index + 1, "no-such-id"), options);
      return child;
    };
    const report = await runBehavior(["--suite", suite, "--scenario", id], { execute });
    assert.ok(child, "the real child did not run");
    assert.equal(child.code, 1);
    const childMessage = JSON.parse(child.stdout).error.message;
    assert.ok(typeof childMessage === "string" && childMessage.length > 0);
    assert.deepEqual([report.passed, report.failed, report.errors], [0, 1, 0]);
    const [run] = report.suites;
    assert.equal(run.suite, suite);
    assert.equal(run.errorCode, "unknown-scenario");
    assert.ok(!Object.hasOwn(run, "scenarioId"));
    assert.equal(run.error, `${suite}: unknown-scenario. Run the selected suite directly for assertion details.`);
    assert.deepEqual(run.results, [{ ...expected, status: "failed", durationMs: 0 }]);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(childMessage) && !serialized.includes("no-such-id"));
  });
}
