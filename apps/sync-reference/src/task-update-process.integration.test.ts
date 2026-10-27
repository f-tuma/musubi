import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import { REFERENCE_TASK_UPDATE_PROFILE } from "./task-admission.js";
import type { ReferenceTaskContent, ReferenceTaskAdmission, ReferenceTaskPatch } from "./task-model.js";
const key = "ab".repeat(32), scope = "https://www.googleapis.com/auth/tasks";
const content: ReferenceTaskContent = { name: "Original task", notes: "Exact original notes", state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const baseline = { title: content.name, notes: content.notes, status: "needsAction", due: "2026-10-26T00:00:00.000Z" };
const deferred = () => { let resolve!: () => void, reject!: (reason: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); assert(adminUrl, "Explicit disposable database required");
  const name = referenceTestDatabaseName("reference_task_process_"), url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.href, max: 4 }), store = new ReferenceTaskStore(pool, key), events = new ReferenceStore(pool, key), children = new Set<ChildProcess>();
  let taskListId = "", taskId = "", operationId = "", mode = "healthy", remote: Record<string, unknown> = {}, methods: string[] = [], bodies: string[] = [], failures: unknown[] = [], metrics = 0, passed = 0;
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method!); assert.equal(req.headers.authorization, "Bearer synthetic-task-token");
      assert.equal(req.url, `/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`);
      const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "GET") {
        if (mode === "absent404" || mode === "absent410") return json({}, mode === "absent404" ? 404 : 410);
        if (mode === "verification-failed" && bodies.length) return json({}, 503);
        if (mode === "assigned") return json({ ...remote, assignmentInfo: {} });
        if (mode === "deleted") return json({ ...remote, deleted: true });
        if (mode === "weak") return json({ ...remote, etag: 'W/"weak"' });
        if (mode === "changed-tag") return json({ ...remote, etag: '"different"' });
        return json(remote);
      }
      assert.equal(req.method, "PATCH"); assert.equal(req.headers["if-match"], '"before"');
      let body = ""; for await (const chunk of req) body += chunk; bodies.push(body); assert.deepEqual(JSON.parse(body), { title: "New admitted title" });
      if (mode === "reject429") { res.setHeader("retry-after", "7"); return json({}, 429); }
      if (mode === "reject412") return json({}, 412);
      if (mode === "lost-unapplied") return res.destroy();
      remote = { ...remote, ...JSON.parse(body), etag: '"after"' };
      if (mode === "untouched-changed") remote.notes = "Concurrent untouched notes";
      if (mode === "lost") return res.destroy();
      if (mode === "malformed-accepted") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{"); }
      if (mode === "missing-tag-accepted") { const { etag: _etag, ...withoutTag } = remote; return json(withoutTag); }
      if (mode === "accepted204") { res.writeHead(204); return res.end(); }
      return json(remote);
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned native task fixture failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  function child(pause?: string, admission?: unknown) {
    const checkpoint = deferred(); let stdout = "", stderr = "";
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./task-process-fixture.child.ts", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"] }); children.add(proc);
    const timer = setTimeout(() => { checkpoint.reject(new Error("Owned task child timeout")); proc.kill("SIGKILL"); }, 30_000);
    proc.stdout!.on("data", value => stdout += value); proc.stderr!.on("data", value => stderr += value);
    proc.on("message", (value: any) => { if (value.type === "checkpoint") checkpoint.resolve(); if (value.type === "metric") metrics++; });
    const exited = once(proc, "exit").then(([code, signal]) => { clearTimeout(timer); children.delete(proc); return { code, signal, stdout, stderr }; });
    proc.stdin!.end(JSON.stringify({ operationId, fixtureOrigin: origin, pause, ...(admission ? { action: "admit", admission } : {}) })); return { proc, checkpoint: checkpoint.promise, exited };
  }
  async function run() { const result = await child().exited; assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.stdout.includes("synthetic-task-token"), false); return JSON.parse(result.stdout); }
  async function kill(value: ReturnType<typeof child>) { await value.checkpoint; value.proc.kill("SIGKILL"); assert.equal((await value.exited).signal, "SIGKILL"); }
  const expire = () => pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [operationId]);
  async function fixture(label: string, body: (input: ReferenceTaskAdmission, ids: { connectionId: string; objectId: string; bindingId: string }) => Promise<void>, admit = true, patch: ReferenceTaskPatch = { name: "New admitted title" }) {
    const id = randomUUID(), ids = { connectionId: `process-task-conn:${id}`, objectId: `process-task-object:${id}`, bindingId: `process-task-binding:${id}` };
    operationId = randomUUID(); taskListId = `native-list/${id}?`; taskId = `native-task/${id}?`; methods = []; bodies = []; failures = []; metrics = 0; mode = "healthy"; remote = { id: taskId, ...baseline, etag: '"before"' };
    await store.seedBinding({ ...ids, provider: "google", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, taskListId, taskId, accessToken: "synthetic-task-token", scope, expiresAt: "2099-01-01T00:00:00.000Z", content, baseline: baseline as any, etag: '"before"' });
    const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId, patch };
    if (admit) await store.admitUpdate(input); await body(input, ids); assert.deepEqual(failures, []); assert.equal(metrics, methods.length); passed++; console.log(`Reference Task process: ${label}: PASS`);
  }
  async function ack(provider: string) {
    const op = await store.inspectOperation(operationId); assert.equal(op.status, "acked"); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.receipt.remote.kind, "confirmed"); assert.equal(op.binding.etag, '"after"');
    assert.deepEqual(op.canonical.content, { ...content, name: "New admitted title" }); assert.deepEqual(op.binding.baseline, { ...baseline, title: "New admitted title" });
  }
  try {
    await events.migrate();
    await fixture("native-five-calls-title-only-original-condition-rich-canonical", async () => { assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET", "GET", "GET", "PATCH", "GET"]); await ack("accepted"); });
    await fixture("empty-mask-real-native-reads-no-PATCH-no-invented-acceptance", async () => {
      assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET", "GET"]); assert.equal(bodies.length, 0);
      const op = await store.inspectOperation(operationId); assert.equal(op.receipt.provider.kind, "not-dispatched"); assert.equal(op.dispatchPossible, false); assert.equal(op.acceptedStatus, null); assert.equal(op.binding.etag, '"before"'); assert.deepEqual(op.binding.baseline, baseline); assert.deepEqual(op.canonical.content, { ...content, importance: "low" });
    }, true, { importance: "low" });
    await fixture("Calendar-only-grant-refuses-before-credentials-and-HTTP", async (_input, ids) => {
      await pool.query("UPDATE reference_connections SET scope='https://www.googleapis.com/auth/calendar.events' WHERE id=$1", [ids.connectionId]);
      assert.equal((await run()).status, "hold"); assert.deepEqual(methods, []); assert.equal((await store.inspectOperation(operationId)).dispatchPossible, false);
    });
    await fixture("SIGKILL-inside-real-admission-rolls-back-canonical-and-intent", async (input, ids) => {
      await kill(child("admissionCanonical", input)); assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE id=$1", [operationId])).rows[0].count, "0");
      assert.deepEqual((await pool.query("SELECT content FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].content, content); await store.admitUpdate(input); assert.equal((await run()).status, "acked");
    }, false);
    await fixture("kill-after-durable-beforeDispatch-restarts-same-conditional-body", async () => {
      await kill(child("beforeDispatch")); assert.equal(bodies.length, 0); assert.equal((await store.inspectOperation(operationId)).dispatchPossible, true); await expire(); assert.equal((await run()).status, "acked"); assert.equal(bodies.length, 1); await ack("accepted");
    });
    await fixture("accepted-status-before-body-parse-kill-restarts-GET-only", async () => {
      await kill(child("afterAcceptance")); const prior = await store.inspectOperation(operationId); assert.equal(prior.receipt.provider.kind, "accepted"); assert.equal(prior.acceptedStatus, 200); if (prior.receipt.provider.kind === "accepted") assert.equal(prior.receipt.provider.validator, undefined);
      const offset = methods.length; await expire(); assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(bodies.length, 1); await ack("accepted");
    });
    await fixture("lost-applied-reply-kill-restarts-GET-only-preserving-uncertain", async () => {
      mode = "lost"; await kill(child("afterUncertain")); mode = "healthy"; const offset = methods.length; await expire(); assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(bodies.length, 1); await ack("uncertain");
    });
    await fixture("unapplied-lost-reply-retries-only-original-body-and-validator", async () => {
      mode = "lost-unapplied"; await kill(child("afterUncertain")); mode = "healthy"; await expire(); assert.equal((await run()).status, "acked"); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); await ack("accepted");
    });
    await fixture("inherited-uncertain-current429-then-target-read-ACK-retains-uncertain", async () => {
      mode = "lost-unapplied"; await kill(child("afterUncertain")); await expire(); mode = "reject429"; assert.equal((await run()).status, "hold"); const op = await store.inspectOperation(operationId); assert.equal(op.receipt.provider.kind, "uncertain"); assert.equal(bodies.length, 2);
      assert.equal((await pool.query("SELECT not_before>clock_timestamp() AS delayed FROM reference_task_operations WHERE id=$1", [operationId])).rows[0].delayed, true);
      remote = { ...remote, title: "New admitted title", etag: '"after"' }; mode = "healthy"; await expire(); const offset = methods.length; assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(bodies.length, 2); await ack("uncertain");
    });
    await fixture("known429-new-conditional-dispatch-lost-reply-becomes-uncertain", async () => {
      mode = "reject429"; assert.equal((await run()).status, "hold"); assert.equal((await store.inspectOperation(operationId)).receipt.provider.kind, "rejected"); await expire(); mode = "lost"; await kill(child("afterUncertain"));
      await expire(); mode = "healthy"; assert.equal((await run()).status, "acked"); assert.equal(bodies.length, 2); await ack("uncertain");
    });
    for (const accepted of ["malformed-accepted", "missing-tag-accepted", "accepted204"]) await fixture(`${accepted}-preserves-real-acceptance-and-verifies-strong-target`, async () => {
      mode = accepted; assert.equal((await run()).status, "acked"); await ack("accepted"); assert.equal((await store.inspectOperation(operationId)).acceptedStatus, accepted === "accepted204" ? 204 : 200); assert.equal(bodies.length, 1);
    });
    await fixture("prior-accepted-current429-retains-accepted-and-current-rejection", async () => {
      await kill(child("afterAcceptance")); remote = { id: taskId, ...baseline, etag: '"before"' }; await expire(); mode = "reject429";
      assert.equal((await run()).status, "hold"); const op = await store.inspectOperation(operationId); assert.equal(op.receipt.provider.kind, "accepted"); assert.equal(op.acceptedStatus, 200); assert.equal(bodies.length, 2);
      assert.equal((await pool.query("SELECT not_before>clock_timestamp() AS delayed FROM reference_task_operations WHERE id=$1", [operationId])).rows[0].delayed, true);
      assert.equal(op.binding.etag, '"before"'); assert.deepEqual(op.binding.baseline, baseline);
    });
    await fixture("accepted-then-failed-verification-restarts-GET-only", async () => {
      mode = "verification-failed"; assert.equal((await run()).status, "hold"); assert.equal((await store.inspectOperation(operationId)).receipt.provider.kind, "accepted"); await expire(); mode = "healthy"; const offset = methods.length; assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(bodies.length, 1);
    });
    await fixture("after-readback-kill-retains-paired-confirmation-and-restarts-readonly", async () => {
      await kill(child("afterReadback")); assert.equal((await store.inspectOperation(operationId)).receipt.remote.kind, "confirmed"); await expire(); const offset = methods.length; assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(bodies.length, 1);
    });
    await fixture("strict-untouched-notes-change-refuses-ACK-no-fake-baseline", async () => {
      mode = "untouched-changed"; assert.equal((await run()).status, "hold"); const op = await store.inspectOperation(operationId); assert.equal(op.receipt.provider.kind, "accepted"); assert.equal(op.binding.etag, '"before"'); assert.deepEqual(op.binding.baseline, baseline); assert.equal(bodies.length, 1);
      await expire(); mode = "healthy"; assert.equal((await run()).status, "conflict"); assert.equal(bodies.length, 1);
    });
    for (const refusal of ["absent404", "absent410", "assigned", "deleted", "weak", "changed-tag", "reject412"]) await fixture(`${refusal}-refuses-ACK-without-extra-mutations`, async () => {
      mode = refusal; assert.notEqual((await run()).status, "acked"); assert.equal(bodies.length, refusal === "reject412" ? 1 : 0); assert.equal((await store.inspectOperation(operationId)).binding.etag, '"before"');
      if (refusal === "reject412") { await expire(); assert.equal((await run()).status, "unclaimed"); assert.equal(bodies.length, 1); }
    });
    await fixture("actual-CLI-commands-and-delivery-use-task-namespace", async (_input, ids) => {
      // Test-only preload routes only fixed Tasks HTTPS to the owned HTTP server;
      // production CLI has no test URL/config switch and no network fallback.
      const preload = `const raw=globalThis.fetch;globalThis.fetch=async(url,init)=>{const u=new URL(url);if(u.origin!=='https://tasks.googleapis.com'||!u.pathname.startsWith('/tasks/v1/lists/'))throw Error('Nonfixture network');const r=await raw(${JSON.stringify(origin)}.slice(0,-1)+u.pathname+u.search,init);Object.defineProperty(r,'url',{value:u.href});return r};`;
      const cli = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("./cli.ts", import.meta.url)), "deliver-task"], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = ""; cli.stdout.on("data", value => stdout += value); cli.stderr.on("data", value => stderr += value); cli.stdin.end(JSON.stringify({ operationId })); assert.equal((await once(cli, "exit"))[0], 0, stderr); assert.equal(JSON.parse(stdout).status, "acked");
      metrics += stderr.split("\n").filter(line => line.includes('"type":"provider-http"')).length; await ack("accepted"); assert.equal(stdout.includes("synthetic-task-token"), false); assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1", [operationId])).rows[0].count, "0"); assert(ids.bindingId);
    });
    console.log(`Reference Task process: ${passed} cases passed`);
  } finally {
    for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => once(child, "exit").catch(() => {})));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
