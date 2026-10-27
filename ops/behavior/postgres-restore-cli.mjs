import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../../", import.meta.url));
const idPattern = /^[a-z][a-z0-9-]{0,79}$/;
const commandNames = new Set(["create", "start", "ready", "restore", "tables", "counts", "stop", "remove"]);
export class RestoreScenarioFailure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const requireThat = (condition, message) => { if (!condition) throw new RestoreScenarioFailure("invalid-suite", message); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

export async function loadRestoreSuite(value) {
  if (value === undefined) {
    try { value = JSON.parse(await readFile(new URL("./postgres-restore.json", import.meta.url), "utf8")); }
    catch { throw new RestoreScenarioFailure("suite-unavailable", "The restore suite is unavailable."); }
  }
  requireThat(value?.schemaVersion === 1 && value.suite === "postgres-restore" && value.driver === "postgres-restore" &&
    Array.isArray(value.scenarios) && value.scenarios.length > 0 && value.scenarios.length <= 100, "Invalid restore suite.");
  const ids = new Set();
  for (const scenario of value.scenarios) {
    requireThat(record(scenario) && typeof scenario.id === "string" && idPattern.test(scenario.id) && !ids.has(scenario.id) &&
      typeof scenario.title === "string" && scenario.title.trim(), "Invalid scenario metadata."); ids.add(scenario.id);
    requireThat(["custom", "gzip", "corrupt-gzip", "invalid", "empty", "missing"].includes(scenario.input) &&
      Array.isArray(scenario.ports) && scenario.ports.length <= 60 && scenario.ports.every(port =>
        record(port) && commandNames.has(port.command) && (port.exitCode === undefined || Number.isInteger(port.exitCode) && port.exitCode >= 0 && port.exitCode <= 255) &&
        (port.stdout === undefined || typeof port.stdout === "string") && (port.stderr === undefined || typeof port.stderr === "string") &&
        (port.signal === undefined || ["SIGTERM", "SIGINT", "SIGHUP"].includes(port.signal)) && (port.hang === undefined || typeof port.hang === "boolean") &&
        (port.writeOutput === undefined || port.command === "counts" && typeof port.writeOutput === "string")), "Invalid command receipts.");
    requireThat(record(scenario.expected) && Number.isInteger(scenario.expected.exitCode) && scenario.expected.exitCode >= 0 && scenario.expected.exitCode <= 255 &&
      Array.isArray(scenario.expected.stdoutIncludes) && scenario.expected.stdoutIncludes.every(x => typeof x === "string") &&
      Array.isArray(scenario.expected.stderrIncludes) && scenario.expected.stderrIncludes.every(x => typeof x === "string"), "Invalid expectations.");
    requireThat(scenario.env === undefined || record(scenario.env) && Object.entries(scenario.env).every(([key, item]) =>
      ["MUSUBI_RESTORE_IMAGE", "MUSUBI_RESTORE_TIMEOUT_SECONDS"].includes(key) && typeof item === "string"), "Invalid fixture environment.");
    requireThat(scenario.ports.every(port => !port.hang || port.command === "restore" && scenario.env?.MUSUBI_RESTORE_TIMEOUT_SECONDS === "1"), "A stalled fixture must use the one-second restore deadline.");
    requireThat(scenario.counts === undefined || record(scenario.counts) && typeof scenario.counts.expected === "string" &&
      (scenario.counts.output === undefined || typeof scenario.counts.output === "string") &&
      (scenario.counts.omit === undefined || ["sql", "expected"].includes(scenario.counts.omit)) &&
      (scenario.counts.outputMode === undefined || ["file", "symlink", "dangling-symlink"].includes(scenario.counts.outputMode)), "Invalid count fixture.");
  }
  return value;
}

/** Execute the shipped shell script, replacing Docker and sleep at PATH ports.
 * All dump, SQL and count bytes are synthetic and all output stays in an owned
 * temporary directory; no Docker daemon or existing container is contacted. */
export async function runRestoreScenario(scenario, { helper = join(root, "ops/verify-postgres-backup.sh") } = {}) {
  await loadRestoreSuite({ schemaVersion: 1, suite: "postgres-restore", driver: "postgres-restore", scenarios: [scenario] });
  const directory = await mkdtemp(join(tmpdir(), "musubi-restore-scenario-"));
  try {
    const bin = join(directory, "bin"), ownedTemp = join(directory, "temporary");
    await mkdir(bin); await mkdir(ownedTemp);
    await writeFile(join(directory, "scenario.json"), JSON.stringify(scenario));
    const statePath = join(directory, "state.json");
    const state = { index: 0, commands: [], errors: [] };
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(join(bin, "docker"), '#!/bin/sh\nexec "$MUSUBI_RESTORE_FIXTURE_NODE" "$MUSUBI_RESTORE_FIXTURE_PORT" "$@"\n', { mode: 0o700 });
    await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const dump = join(directory, "fixture.dump"), bytes = Buffer.from("PGDMPsynthetic-custom-dump\n");
    if (scenario.input !== "missing") {
      let input = scenario.input === "gzip" || scenario.input === "corrupt-gzip" ? gzipSync(bytes) :
        scenario.input === "invalid" ? Buffer.from("Not a PostgreSQL archive\n") : scenario.input === "empty" ? Buffer.alloc(0) : bytes;
      if (scenario.input === "corrupt-gzip") { input = Buffer.from(input); input[input.length - 1] ^= 255; }
      await writeFile(dump, input, { mode: 0o600 });
    }
    const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: ownedTemp,
      MUSUBI_RESTORE_FIXTURE_NODE: process.execPath,
      MUSUBI_RESTORE_FIXTURE_PORT: fileURLToPath(new URL("./postgres-restore-docker-port.mjs", import.meta.url)),
      MUSUBI_RESTORE_FIXTURE_DIRECTORY: directory, ...scenario.env };
    if (scenario.counts) {
      const sql = join(directory, "preservation.sql"), expected = join(directory, "source-counts.txt");
      await writeFile(sql, "BEGIN READ ONLY; SELECT 7 AS preserved; COMMIT;\n");
      await writeFile(expected, scenario.counts.expected);
      if (scenario.counts.omit !== "sql") env.MUSUBI_RESTORE_COUNTS_SQL = sql;
      if (scenario.counts.omit !== "expected") env.MUSUBI_RESTORE_EXPECTED_COUNTS = expected;
      env.MUSUBI_RESTORE_COUNTS_OUTPUT = join(directory, "restored-counts.txt");
      if (scenario.counts.outputMode === "file") await writeFile(env.MUSUBI_RESTORE_COUNTS_OUTPUT, "protected-output\n");
      if (["symlink", "dangling-symlink"].includes(scenario.counts.outputMode)) {
        const target = join(directory, "protected-output.txt");
        if (scenario.counts.outputMode === "symlink") await writeFile(target, "protected-output\n");
        await symlink(target, env.MUSUBI_RESTORE_COUNTS_OUTPUT);
      }
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", [helper, dump], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, killSignal: "SIGKILL" });
      let stdout = "", stderr = "";
      state.helperPID = child.pid;
      // The helper performs filesystem preflight before reaching the mock port.
      writeFileSync(statePath, JSON.stringify(state));
      child.stdout.on("data", value => { stdout += value; });
      child.stderr.on("data", value => { stderr += value; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const actual = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(actual.errors, [], "The production script crossed an unexpected command boundary.");
    assert.equal(actual.index, scenario.ports.length, "The production script left declared command receipts unused.");
    assert.equal(result.signal, null, "The scenario exceeded its process boundary.");
    assert.equal(result.code, scenario.expected.exitCode, result.stderr);
    for (const value of scenario.expected.stdoutIncludes) assert.ok(result.stdout.includes(value), `Missing stdout: ${value}`);
    for (const value of scenario.expected.stderrIncludes) assert.ok(result.stderr.includes(value), `Missing stderr: ${value}; actual: ${result.stderr}`);
    assert.deepEqual(await readdir(ownedTemp), [], "The helper leaked its temporary directory.");
    if (scenario.counts?.output !== undefined) assert.equal(await readFile(env.MUSUBI_RESTORE_COUNTS_OUTPUT, "utf8"), scenario.counts.output);
    if (scenario.counts?.outputMode === "dangling-symlink") assert.equal(await readlink(env.MUSUBI_RESTORE_COUNTS_OUTPUT), join(directory, "protected-output.txt"));
    return { exitCode: result.code, commands: actual.commands, temporaryDirectoryRemoved: true };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function runRestoreCli(args, write = line => process.stdout.write(`${line}\n`)) {
  const started = performance.now(); let scenarioId;
  try {
    const seen = new Set(); let selected, list = false, json = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!["--list", "--json", "--scenario"].includes(flag) || seen.has(flag)) throw new RestoreScenarioFailure("invalid-arguments", "Use --list or --scenario <id>, and optional --json.");
      seen.add(flag);
      if (flag === "--list") list = true;
      if (flag === "--json") json = true;
      if (flag === "--scenario") { selected = args[++index]; if (!selected || !idPattern.test(selected)) throw new RestoreScenarioFailure("invalid-arguments", "Use one valid scenario id."); }
    }
    if (list && selected) throw new RestoreScenarioFailure("invalid-arguments", "Choose list or scenario.");
    const suite = await loadRestoreSuite();
    if (list) {
      const scenarios = suite.scenarios.map(({ id, title }) => ({ id, title }));
      write(json ? JSON.stringify({ schemaVersion: 1, suite: suite.suite, scenarios }) : scenarios.map(x => `${x.id}: ${x.title}`).join("\n")); return 0;
    }
    const selectedScenarios = suite.scenarios.filter(x => !selected || x.id === selected);
    if (!selectedScenarios.length) throw new RestoreScenarioFailure("unknown-scenario", "The requested restore scenario does not exist.");
    const results = [];
    for (const scenario of selectedScenarios) {
      scenarioId = scenario.id; const before = performance.now();
      const summary = await runRestoreScenario(scenario);
      results.push({ id: scenario.id, title: scenario.title, status: "passed", durationMs: Math.round(performance.now() - before), summary });
    }
    const durationMs = Math.round(performance.now() - started);
    write(json ? JSON.stringify({ schemaVersion: 1, suite: suite.suite, results, durationMs }) : `${results.map(x => `PASS ${x.id}`).join("\n")}\n${results.length} scenarios passed (${durationMs}ms).`); return 0;
  } catch (error) {
    const code = error instanceof RestoreScenarioFailure ? error.code : "expectation-mismatch";
    write(args.includes("--json") ? JSON.stringify({ schemaVersion: 1, suite: "postgres-restore", error: { code, message: error.message, ...(scenarioId ? { scenarioId } : {}) } }) : `FAIL ${scenarioId ?? ""} ${code}: ${error.message}`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runRestoreCli(process.argv.slice(2));
