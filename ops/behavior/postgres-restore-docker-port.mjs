// Test-only command port. It returns ordered JSON receipts to the real shell
// helper; it does not implement a container or a restore state machine.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.MUSUBI_RESTORE_FIXTURE_DIRECTORY;
const statePath = join(directory, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const scenario = JSON.parse(readFileSync(join(directory, "scenario.json"), "utf8"));
const args = process.argv.slice(2), ownedID = "a".repeat(64), database = "musubi_restore_check";
const stdin = args[0] === "exec" && args[1] === "-i" ? readFileSync(0) : null;
let command;
try {
  if (args[0] === "create") {
    command = "create";
    const labelIndex = args.indexOf("--label"), label = args[labelIndex + 1];
    assert.match(label, /^musubi\.restore-check=musubi-restore-check\.[a-zA-Z0-9]+$/);
    const normalized = [...args]; normalized[labelIndex + 1] = "musubi.restore-check=<owned-nonce>";
    assert.deepEqual(normalized, ["create", "--network", "none", "--label", "musubi.restore-check=<owned-nonce>",
      "--tmpfs", "/var/lib/postgresql/data", "--env", "PGDATA=/var/lib/postgresql/data",
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", `POSTGRES_DB=${database}`,
      scenario.env?.MUSUBI_RESTORE_IMAGE ?? "postgres:17-alpine"]);
  } else if (args[0] === "start") {
    command = "start"; assert.deepEqual(args, ["start", ownedID]);
  } else if (args[0] === "stop") {
    command = "stop"; assert.deepEqual(args, ["stop", "-t", "10", ownedID]);
  } else if (args[0] === "rm") {
    command = "remove"; assert.deepEqual(args, ["rm", "--volumes", ownedID]);
  } else if (args[0] === "exec") {
    const start = args[1] === "-i" ? 3 : 2;
    assert.equal(args[start - 1], ownedID);
    const executable = args[start];
    if (executable === "pg_isready") {
      command = "ready";
      assert.deepEqual(args, ["exec", ownedID, "pg_isready", "-h", "127.0.0.1", "-t", "1", "-U", "postgres", "-d", database]);
    } else if (executable === "pg_restore") {
      command = "restore";
      assert.deepEqual(args, ["exec", "-i", ownedID, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "-U", "postgres", "-d", database]);
      assert.equal(stdin.toString(), "PGDMPsynthetic-custom-dump\n");
    } else if (executable === "psql" && args.includes("-Atc")) {
      command = "tables";
      assert.deepEqual(args, ["exec", ownedID, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-Atc",
        "select count(*) from information_schema.tables where table_schema = 'public';"]);
    } else if (executable === "psql") {
      command = "counts";
      assert.deepEqual(args, ["exec", "-i", ownedID, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "-U", "postgres", "-d", database]);
      assert.equal(stdin.toString(), "BEGIN READ ONLY; SELECT 7 AS preserved; COMMIT;\n");
    } else throw new Error("Unexpected executable.");
  } else throw new Error("Unexpected Docker command.");
  const receipt = scenario.ports[state.index];
  assert.ok(receipt, `Unconsumed command ${command}.`);
  assert.equal(command, receipt.command);
  state.index++; state.commands.push(command);
  writeFileSync(statePath, JSON.stringify(state));
  if (receipt.writeOutput !== undefined) writeFileSync(join(directory, "restored-counts.txt"), receipt.writeOutput);
  if (receipt.signal) process.kill(state.helperPID, receipt.signal);
  if (receipt.hang) await new Promise(resolve => setTimeout(resolve, 60_000));
  writeSync(1, receipt.stdout ?? (command === "create" ? `${ownedID}\n` : command === "tables" ? "12\n" : ""));
  writeSync(2, receipt.stderr ?? "");
  process.exitCode = receipt.exitCode ?? 0;
} catch (error) {
  state.errors.push({ command: command ?? "unknown", message: error.message });
  writeFileSync(statePath, JSON.stringify(state));
  writeSync(2, "Unexpected command-port invocation.\n");
  process.exitCode = 93;
}
