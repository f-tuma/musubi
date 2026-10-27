// Dedicated harness boundary probe; run directly with an explicit disposable
// admin URL after GO, outside the instrumented profile-module lane.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceFixture } from "./database-fixture.mjs";
import { executeOwned, installOwnedShutdown } from "./process-group.mjs";
test("successful real CREATE before journal resolution stays failed and cleans only its owned namespace after timeout", async () => {
  assert.equal(process.env.ENVIRONMENT, "test"); assert.ok(process.env.REFERENCE_DATABASE_URL);
  const shutdown = installOwnedShutdown();
  const directory = await mkdtemp(join(tmpdir(), "sync-allocation-crash-")); let fixture, cleanup;
  try {
    fixture = await referenceFixture(process.env, directory);
    const journalURL = new URL("./db-journal.mjs", import.meta.url).href, nameURL = new URL("./database-name.ts", import.meta.url).href;
    const script = `import {spawn} from 'node:child_process';import {Pool} from 'pg';import {installDatabaseJournal} from ${JSON.stringify(journalURL)};import {referenceTestDatabaseName} from ${JSON.stringify(nameURL)};
const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const pool=new Pool({connectionString:process.env.REFERENCE_DATABASE_URL,max:1});
process.on('SIGTERM',()=>{worker.kill('SIGKILL');worker.once('exit',async()=>{await pool.end();process.exit(0);});});
installDatabaseJournal(process.env.SYNC_CONFORMANCE_DB_JOURNAL,{afterCreate:async name=>{console.log(JSON.stringify({created:name,parent:process.pid,worker:worker.pid}));await new Promise(()=>{});}});
const name=referenceTestDatabaseName('reference_cleanup_probe_');await pool.query('CREATE DATABASE "'+name+'"');`;
    const result = await executeOwned(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, ...fixture.env }, timeoutMs: 5000,
    });
    assert.equal(result.exitCode, null); assert.equal(result.terminationReason, "timeout"); assert.equal(result.groupReaped, true);
    const native = JSON.parse(result.stdout.trim()); assert.match(native.created, /^reference_c10_[a-f0-9]{16}_[a-f0-9]{32}$/);
    for (const pid of [native.parent, native.worker]) assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
    cleanup = await fixture.cleanup(); assert.equal(cleanup.completed, false, "Recovery cannot convert the interrupted allocation into a normal PASS");
    const facts = JSON.parse(await readFile(join(directory, "cleanup-facts.json"), "utf8"));
    assert.equal(facts.issuerSessionsZero, true); assert.equal(facts.journalValid, true); assert.equal(facts.recovered, true);
    assert.equal(facts.outerPlainDrop, true); assert.equal(facts.outerAbsent, true); assert.equal(facts.intents[0].state, "intent");
    assert.equal(facts.databases.length, 1); assert.equal(facts.databases[0].name, native.created); assert.equal(facts.databases[0].sessionsZero, true);
    assert.equal(facts.databases[0].plainDrop, true); assert.equal(facts.databases[0].absent, true);
  } finally { if (fixture && !cleanup) await fixture.cleanup(); await rm(directory, { recursive: true, force: true }); shutdown.dispose(); }
});
test("lost outer CREATE response reconciles only its exact own name after the original issuer closes", async () => {
  assert.equal(process.env.ENVIRONMENT, "test"); assert.ok(process.env.REFERENCE_DATABASE_URL);
  const { Pool } = await import("pg"), original = Pool.prototype.query, directory = await mkdtemp(join(tmpdir(), "sync-outer-create-loss-"));
  let created, observed;
  Pool.prototype.query = async function(...args) {
    const statement = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const outer = /^CREATE DATABASE "(reference_c10_outer_[a-f0-9]{32})"$/.exec(statement ?? "");
    const result = await original.apply(this, args);
    if (outer && !created) { created = outer[1]; throw new Error("Owned lost response after committed outer CREATE"); }
    return result;
  };
  try {
    await assert.rejects(referenceFixture(process.env, directory), error => {
      observed = error; return error.code === "db-bootstrap-allocation-failed";
    });
    assert.ok(created); const facts = observed.cleanupEvidence;
    assert.equal(facts.name, created); assert.equal(facts.absentBefore, true); assert.equal(facts.createAttempted, true);
    assert.equal(facts.issuerGone, true); assert.equal(facts.sessionsZero, true); assert.equal(facts.plainDrop, true); assert.equal(facts.absent, true); assert.equal(facts.reconciled, true);
    assert.deepEqual(observed.cleanup, { required: true, completed: false }, "A recovered failed allocation remains failed");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "bootstrap-cleanup-facts.json"), "utf8")), facts);
    await rm(directory, { recursive: true, force: true });
    assert.equal(JSON.parse(JSON.stringify(observed.cleanupEvidence)).absent, true, "Evidence survives removal of the temporary journal directory");
  } finally { Pool.prototype.query = original; await rm(directory, { recursive: true, force: true }); }
});
