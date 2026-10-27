import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import { deliverReferenceTaskCreate } from "./task-create-runner.js";
import { deliverReferenceTaskUpdate } from "./task-runner.js";
import { deliverReferenceTaskDelete } from "./task-delete-runner.js";

async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); if (!adminUrl) throw new Error("Explicit disposable DB required");
  const name = referenceTestDatabaseName("reference_task_intent_process_"), url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.href, max: 6 }), key = "b2".repeat(32), events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key), children = new Set<ChildProcess>();
  const token = "synthetic-native-intent-token", content = { name: "Queued native task", notes: null, state: "doing" as const, dueAt: "2026-10-26T14:45:30.123Z", importance: "high" as const };
  let createId = "", updateId = "", deleteId = "", listId = "", taskId = "", mode = "healthy", exists = false, native: Record<string, unknown> = {}, etag = '"created"', posts = 0, patches = 0, deletes = 0, passed = 0, metrics = 0, methods: string[] = [], failures: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`); methods.push(req.method!);
      const path = new URL(req.url!, "http://fixture").pathname, listPath = `/tasks/v1/users/@me/lists/${encodeURIComponent(listId)}`, collection = `/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`, resource = `${collection}/${encodeURIComponent(taskId)}`;
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.method === "GET" && path === listPath) { json(200, { id: listId }); return; }
      if (req.method === "POST" && path === collection) {
        posts++; assert.equal(posts, 1, "A deferred successor can never manufacture another CREATE"); let bytes = ""; for await (const chunk of req) bytes += chunk;
        const parsed = JSON.parse(bytes); assert.deepEqual(parsed, { title: content.name, notes: null, due: "2026-10-26T00:00:00.000Z", status: "needsAction" });
        native = { ...parsed, id: taskId }; exists = true;
        if (mode === "lost-create") { res.destroy(); return; }
        if (mode === "create-no-id") { json(200, { etag }); return; }
        json(200, { id: taskId, etag }); return;
      }
      assert.equal(path, resource, "Only the exact response address in the original physical list is readable/writable");
      if (req.method === "GET") { if (!exists) { json(404, {}); return; } json(200, { ...native, etag }); return; }
      assert.equal(req.headers["if-match"], etag, "Successors must use the matched predecessor version");
      if (req.method === "PATCH") { patches++; let bytes = ""; for await (const chunk of req) bytes += chunk; assert.deepEqual(JSON.parse(bytes), { title: "Queued native successor" }); native = { ...native, ...JSON.parse(bytes) }; etag = '"updated"'; if (mode === "lost-update") { res.destroy(); return; } json(200, { id: taskId, etag }); return; }
      assert.equal(req.method, "DELETE"); deletes++; exists = false; if (mode === "lost-delete") { res.destroy(); return; } res.writeHead(204); res.end();
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end("Owned native intent fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}/`;
  const ports = { http: { async fetch(url: string, init: RequestInit) { const u = new URL(url); assert.equal(u.origin, "https://tasks.googleapis.com"); const response = await globalThis.fetch(`${origin.slice(0, -1)}${u.pathname}${u.search}`, init); Object.defineProperty(response, "url", { value: u.href }); return response; } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() { metrics++; } } };
  const runCreate = () => deliverReferenceTaskCreate(store, createId, ports), runUpdate = () => deliverReferenceTaskUpdate(store, updateId, ports), runDelete = () => deliverReferenceTaskDelete(store, deleteId, ports);
  const expire = (id: string) => pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [id]);
  async function fixture(label: string, body: (ids: { bindingId: string; objectId: string; connectionId: string }, update: ReturnType<typeof updateInput>, deletion: ReturnType<typeof deleteInput>) => Promise<void>, queue = true) {
    createId = randomUUID(); updateId = randomUUID(); deleteId = randomUUID(); listId = `intent-list/${createId}?`; taskId = `assigned/${createId}?`; mode = "healthy"; exists = false; native = {}; etag = '"created"'; posts = 0; patches = 0; deletes = 0; methods = []; failures = [];
    const ids = { bindingId: `native-intent-b:${createId}`, objectId: `native-intent-o:${createId}`, connectionId: `native-intent-c:${createId}` };
    await store.seedCreateBinding({ ...ids, provider: "google", endpointProfile: "google-task-create-v1", taskListId: listId, operationId: createId, accessToken: token, expiresAt: "2099-01-01T00:00:00.000Z", scope: "https://www.googleapis.com/auth/tasks", content });
    await store.admitCreate({ bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: createId });
    const update = updateInput(ids.bindingId), deletion = deleteInput(ids.bindingId); if (queue) { await store.queueUpdate(update); await store.queueDelete(deletion); }
    await body(ids, update, deletion); assert.deepEqual(failures, []); passed++; console.log(`Reference Task intent process: ${label}: PASS`);
  }
  function updateInput(bindingId: string) { return { bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: updateId, predecessorOperationId: createId, patch: { name: "Queued native successor" } }; }
  function deleteInput(bindingId: string) { return { bindingId, expectedRevision: 3, commandId: randomUUID(), operationId: deleteId, predecessorOperationId: updateId }; }
  function child(family: "create" | "update" | "delete", pause: string, action?: "queue-update" | "queue-delete", admission?: unknown) {
    const operationId = family === "create" ? createId : family === "delete" ? deleteId : updateId, proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./task-intent-process-fixture.child.ts", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    children.add(proc); proc.once("exit", () => children.delete(proc)); proc.on("message", (message: any) => { if (message?.type === "metric") metrics++; }); proc.stdin!.end(JSON.stringify({ operationId, family, pause, action, admission, fixtureOrigin: origin })); return proc;
  }
  async function stopped(proc: ChildProcess) {
    await Promise.race([new Promise<void>((resolve, reject) => { proc.on("message", (value: any) => { if (value?.type === "checkpoint") resolve(); }); proc.once("exit", () => reject(new Error("Child exited before checkpoint"))); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Owned intent child checkpoint timeout")), 25_000); timer.unref(); })]);
  }
  async function kill(proc: ChildProcess) { await stopped(proc); proc.kill("SIGKILL"); assert.equal((await once(proc, "exit"))[1], "SIGKILL"); }
  async function cli(command: string, input: object) {
    const preload = `const raw=globalThis.fetch;globalThis.fetch=async(url,init)=>{const u=new URL(url);if(u.origin!=='https://tasks.googleapis.com'||!u.pathname.startsWith('/tasks/v1/'))throw Error('Nonfixture network');const r=await raw(${JSON.stringify(origin)}.slice(0,-1)+u.pathname+u.search,init);Object.defineProperty(r,'url',{value:u.href});return r};`;
    const proc = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("./cli.ts", import.meta.url)), command], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; proc.stdout.on("data", value => stdout += value); proc.stderr.on("data", value => stderr += value); proc.stdin.end(JSON.stringify(input)); assert.equal((await once(proc, "exit"))[0], 0, stderr); assert.equal((stdout + stderr).includes(token), false); metrics += stderr.split("\n").filter(line => line.includes('"type":"provider-http"')).length; return JSON.parse(stdout);
  }
  async function finished(ids: { objectId: string }) {
    const root = await store.inspectCreateOperation(createId), update = await store.inspectOperation(updateId), deletion = await store.inspectDeleteOperation(deleteId), local = (await pool.query("SELECT * FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0];
    assert.equal(root.status, "acked"); assert.equal(update.status, "acked"); assert.equal(deletion.status, "acked"); assert.equal(deletion.binding.destinationLifecycle, "absent"); assert.equal(deletion.binding.sourceGeneration, 2); assert.equal(deletion.binding.active, true); assert.equal(deletion.binding.taskId, taskId); assert.equal(deletion.binding.etag, '"updated"'); assert.equal(Number(local.revision), 4); assert.equal(local.canonical_lifecycle, "tombstoned"); assert.equal(Number(local.lifecycle_generation), 2); assert.equal(local.content.state, "doing"); assert.equal(local.content.dueAt, content.dueAt); assert.equal(local.content.importance, "high");
    assert.equal(deletion.resolution?.evidenceOperationId, updateId);
    for (const id of [createId, updateId, deleteId]) { const row = (await pool.query("SELECT payload,source_generation,task_id FROM reference_task_operations WHERE id=$1", [id])).rows[0]; assert.equal(row.task_id, null); assert.equal(Number(row.source_generation), 1); assert.equal(row.payload.operationEnvelope.locator.resourceId, null); }
    assert.equal(posts, 1); assert.equal(patches, 1); assert.equal(deletes, 1);
  }
  try {
    await events.migrate();
    await fixture("queued-before-CREATE-delivers-one-POST-sparse-PATCH-then-paired-DELETE", async ids => {
      assert.equal((await runUpdate()).status, "unclaimed"); assert.equal((await runDelete()).status, "unclaimed"); assert.deepEqual(methods, []); assert.equal(Number((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].revision), 2);
      assert.equal((await runCreate()).status, "acked"); const offset = methods.length; assert.equal((await runDelete()).status, "unclaimed"); assert.equal(methods.length, offset); assert.equal((await runUpdate()).status, "acked"); assert.equal((await runDelete()).status, "acked"); await finished(ids);
    });
    await fixture("queue-during-live-CREATE-response-does-not-invalidate-its-owned-ACK", async (ids, update, deletion) => {
      const proc = child("create", "afterAcceptance"); await stopped(proc); await store.queueUpdate(update); await store.queueDelete(deletion); assert.equal(Number((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].revision), 2); proc.send!({ type: "resume" }); assert.equal((await once(proc, "exit"))[0], 0); assert.equal((await store.inspectCreateOperation(createId)).status, "acked"); assert.equal((await runUpdate()).status, "acked"); assert.equal((await runDelete()).status, "acked"); await finished(ids);
    }, false);
    await fixture("rich-only-queued-UPDATE-keeps-no-dispatch-and-feeds-DELETE-a-real-read-pair", async (ids, update, deletion) => {
      await store.queueUpdate({ ...update, patch: { importance: "low" } }); await store.queueDelete(deletion); assert.equal((await runCreate()).status, "acked"); assert.equal((await runUpdate()).status, "acked"); const updateOp = await store.inspectOperation(updateId); assert.equal(updateOp.receipt.provider.kind, "not-dispatched"); assert.equal(updateOp.acceptedStatus, null); assert.deepEqual(updateOp.saved.patch, {}); assert.equal((await runDelete()).status, "acked"); const final = await store.inspectDeleteOperation(deleteId); assert.equal(final.binding.sourceGeneration, 2); assert.equal(final.binding.etag, '"created"'); assert.equal(final.canonical.content.importance, "low"); assert.equal(posts, 1); assert.equal(patches, 0); assert.equal(deletes, 1);
    }, false);
    for (const disappear of [false, true]) await fixture(`direct-queued-DELETE-${disappear ? "observed-GETabsence" : "native-conditional-delete"}`, async ids => {
      await store.queueDelete({ bindingId: ids.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: deleteId, predecessorOperationId: createId }); assert.equal((await runCreate()).status, "acked"); if (disappear) exists = false; const offset = methods.length; assert.equal((await runDelete()).status, "acked"); const final = await store.inspectDeleteOperation(deleteId); assert.equal(final.binding.sourceGeneration, 2); assert.equal(final.canonical.revision, 3); assert.equal(final.canonical.lifecycle, "tombstoned"); assert.equal(posts, 1); assert.equal(patches, 0); assert.equal(deletes, disappear ? 0 : 1);
      if (disappear) { assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(final.receipt.provider.kind, "not-dispatched"); assert.deepEqual(final.deleteResponse, { acceptedStatus: null, responseAbsenceStatus: null }); }
    }, false);
    for (const rootMode of ["lost-create", "create-no-id"]) await fixture(`${rootMode}-keeps-every-successor-waiting-with-zero-successor-HTTP`, async ids => {
      mode = rootMode; assert.equal((await runCreate()).status, "hold"); const offset = methods.length; assert.equal((await runUpdate()).status, "unclaimed"); assert.equal((await runDelete()).status, "unclaimed"); assert.equal(methods.length, offset); assert.equal(posts, 1); assert.equal(patches, 0); assert.equal(deletes, 0); const local = (await pool.query("SELECT revision,canonical_lifecycle FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0]; assert.equal(Number(local.revision), 2); assert.equal(local.canonical_lifecycle, "active");
    });
    await fixture("SIGKILL-inside-queued-intent-insert-rolls-back-without-touching-CREATE", async (ids, update, deletion) => {
      await kill(child("update", "queueInserted", "queue-update", update)); assert.equal((await pool.query("SELECT count(*) FROM reference_task_intents WHERE id=$1", [updateId])).rows[0].count, "0"); assert.equal(Number((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].revision), 2); await store.queueUpdate(update); await store.queueDelete(deletion); assert.equal((await runCreate()).status, "acked"); assert.equal((await runUpdate()).status, "acked"); assert.equal((await runDelete()).status, "acked"); await finished(ids);
    }, false);
    for (const point of ["activationCanonical", "activationOperation"]) await fixture(`SIGKILL-${point}-rolls-back-canonical-materialization-and-execution-row`, async ids => {
      assert.equal((await runCreate()).status, "acked"); await kill(child("update", point)); assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE id=$1", [updateId])).rows[0].count, "0"); assert.equal(Number((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].revision), 2); assert.equal(patches, 0); assert.equal((await runUpdate()).status, "acked"); assert.equal((await runDelete()).status, "acked"); await finished(ids);
    });
    await fixture("SIGKILL-after-activation-claim-keeps-one-materialization-and-frozen-basis", async ids => {
      assert.equal((await runCreate()).status, "acked"); await kill(child("update", "claim")); const before = (await pool.query("SELECT payload,resolution_basis FROM reference_task_operations WHERE id=$1", [updateId])).rows[0]; assert.equal(Number((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].revision), 3); await expire(updateId); assert.equal((await runUpdate()).status, "acked"); const after = (await pool.query("SELECT payload,resolution_basis FROM reference_task_operations WHERE id=$1", [updateId])).rows[0]; assert.deepEqual(after, before); assert.equal((await runDelete()).status, "acked"); await finished(ids);
    });
    for (const point of ["afterAcceptance", "afterReadback", "ackWritten"]) await fixture(`SIGKILL-deferred-UPDATE-${point}-recovers-paired-GET-only`, async ids => {
      assert.equal((await runCreate()).status, "acked"); await kill(child("update", point)); const offset = methods.length; assert.equal(patches, 1); await expire(updateId); assert.equal((await runUpdate()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal((await runDelete()).status, "acked"); await finished(ids);
    });
    for (const point of ["afterAcceptance", "afterReadback", "ackWritten"]) await fixture(`SIGKILL-deferred-DELETE-${point}-recovers-scoped-GETabsence-only`, async ids => {
      assert.equal((await runCreate()).status, "acked"); assert.equal((await runUpdate()).status, "acked"); await kill(child("delete", point)); const offset = methods.length; assert.equal(deletes, 1); await expire(deleteId); assert.equal((await runDelete()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); await finished(ids);
    });
    await fixture("native-change-after-predecessor-ACK-never-rebases-or-creates-again", async ids => {
      assert.equal((await runCreate()).status, "acked"); native.notes = "Concurrent native edit"; etag = '"external"'; assert.notEqual((await runUpdate()).status, "acked"); assert.equal((await runDelete()).status, "unclaimed"); assert.equal(posts, 1); assert.equal(patches, 0); assert.equal(deletes, 0); assert.equal(Number((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].revision), 3);
    });
    await fixture("actual-CLI-queues-before-CREATE-and-routes-original-null-successors", async (ids, update, deletion) => {
      await cli("queue-task-update", update); await cli("queue-task-delete", deletion); const waiting = await cli("show-task", { operationId: updateId }); assert.equal(waiting.payload.operationEnvelope.locator.resourceId, null); assert.equal((await cli("deliver-task", { operationId: updateId })).status, "unclaimed"); assert.equal((await cli("deliver-task", { operationId: createId })).status, "acked"); assert.equal((await cli("deliver-task", { operationId: updateId })).status, "acked"); assert.equal((await cli("deliver-task", { operationId: deleteId })).status, "acked"); await finished(ids);
    }, false);
    const before = (await pool.query("SELECT id,payload,resolution_basis,completion_evidence FROM reference_task_operations ORDER BY id")).rows; await events.migrate(); await events.migrate(); assert.deepEqual((await pool.query("SELECT id,payload,resolution_basis,completion_evidence FROM reference_task_operations ORDER BY id")).rows, before);
    console.log(`Reference Task intent process: ${passed} cases passed; ${metrics} native metrics`);
  } finally { for (const proc of children) proc.kill("SIGKILL"); await Promise.all([...children].map(proc => once(proc, "exit").catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
