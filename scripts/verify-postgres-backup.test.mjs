import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRestoreSuite, runRestoreCli, runRestoreScenario } from "../ops/behavior/postgres-restore-cli.mjs";

const suite = await loadRestoreSuite();
for (const scenario of suite.scenarios) {
  test(`postgres-restore/${scenario.id}: ${scenario.title}`, { timeout: 20_000 }, async () => {
    await runRestoreScenario(scenario);
  });
}

test("restore fixture rejects malformed metadata, unexpected environment and unbounded stalls", async () => {
  const valid = suite.scenarios[0];
  for (const invalid of [
    { ...valid, id: undefined }, { ...valid, id: "$(touch /tmp/never)" }, { ...valid, title: "" },
    { ...valid, env: { HOME: "/not-an-allowed-port" } }, { ...valid, ports: [{ command: "prune" }] },
    { ...valid, ports: [{ command: "restore", hang: true }] },
    { ...valid, ports: [{ command: "ready", signal: "SIGKILL" }] },
  ]) {
    await assert.rejects(loadRestoreSuite({ ...suite, scenarios: [invalid] }), error => error.code === "invalid-suite");
  }
  await assert.rejects(loadRestoreSuite({ ...suite, scenarios: [valid, valid] }), error => error.code === "invalid-suite");
});

test("restore CLI rejects unknown and duplicate arguments and unknown scenario IDs", async () => {
  for (const args of [["--shell"], ["--scenario"], ["--scenario", "$(touch /tmp/never)"], ["--list", "--scenario", "create-failure"]]) {
    const lines = [];
    assert.equal(await runRestoreCli([...args, "--json"], value => lines.push(value)), 1);
    assert.equal(JSON.parse(lines[0]).error.code, "invalid-arguments");
  }
  const lines = [];
  assert.equal(await runRestoreCli(["--scenario", "unknown", "--json"], value => lines.push(value)), 1);
  assert.equal(JSON.parse(lines[0]).error.code, "unknown-scenario");
  const duplicates = [];
  assert.equal(await runRestoreCli(["--json", "--json"], value => duplicates.push(value)), 1);
  assert.equal(JSON.parse(duplicates[0]).error.code, "invalid-arguments");
});

test("restore CLI inventory matches each declared scenario without contacting Docker", async () => {
  const lines = [];
  assert.equal(await runRestoreCli(["--list", "--json"], value => lines.push(value)), 0);
  assert.deepEqual(JSON.parse(lines[0]), { schemaVersion: 1, suite: suite.suite,
    scenarios: suite.scenarios.map(({ id, title }) => ({ id, title })) });
});

test("unused command receipts fail even when the shell exits with its expected status", async () => {
  const scenario = { ...suite.scenarios[0], ports: [...suite.scenarios[0].ports, { command: "ready" }] };
  await assert.rejects(runRestoreScenario(scenario), /receipts unused/);
});

test("a forbidden name-based removal fails the command port even if the shell exits nonzero", async t => {
  const directory = await mkdtemp(join(tmpdir(), "musubi-restore-unsafe-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, "unsafe-helper.sh");
  await writeFile(helper, "#!/bin/sh\ndocker rm --force musubi-restore-check-existing\nexit 1\n");
  await assert.rejects(runRestoreScenario(suite.scenarios[0], { helper }), /unexpected command boundary/);
});
