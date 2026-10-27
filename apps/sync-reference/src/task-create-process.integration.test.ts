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
import type { ReferenceTaskCreateAdmission } from "./task-create-model.js";

async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); if (!adminUrl) throw new Error("Explicit disposable DB required");
  const name = referenceTestDatabaseName("reference_task_create_process_"), url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.href, max: 6 }), key = "ad".repeat(32), events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key), children = new Set<ChildProcess>();
  const content = { name: "Independent native task", notes: null, state: "doing" as const, dueAt: "2026-10-26T14:45:30.123Z", importance: "high" as const }, token = "synthetic-native-create-token";
  let operationId = "", listId = "", taskId = "", mode = "healthy", posts = 0, patches = 0, deletes = 0, metrics = 0, passed = 0, exists = false, etag = '"created"', native: Record<string, unknown> = {}, methods: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`); methods.push(req.method!);
    const path = new URL(req.url!, "http://fixture").pathname, listPath = `/tasks/v1/users/@me/lists/${encodeURIComponent(listId)}`, tasksPath = `/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && path === listPath) { json(200, { id: mode === "wrong-list" ? "different-list" : listId }); return; }
    if (req.method === "POST" && path === tasksPath) {
      posts++; let body = ""; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body); assert.deepEqual(Object.keys(parsed).sort(), ["due", "notes", "status", "title"]); assert.equal(parsed.title, content.name); assert.equal(parsed.due, "2026-10-26T00:00:00.000Z");
      if (mode === "429") { json(429, { error: "fixture" }, { "retry-after": "17" }); return; }
      native = { ...parsed, id: taskId, etag }; exists = true;
      if (mode === "lost") { req.socket.destroy(); return; }
      if (mode === "bad-json") { res.writeHead(200, { "content-type": "application/json" }); res.end("not-json"); return; }
      if (mode === "no-id") { json(201, { etag }); return; }
      if (mode === "missing-tag") { json(200, { id: taskId }); return; }
      if (mode === "weak-tag") { json(201, { id: taskId, etag: 'W/"weak"' }); return; }
      json(200, { id: taskId, etag }); return;
    }
    if (path === `${tasksPath}/${encodeURIComponent(taskId)}`) {
      if (req.method === "GET") {
        if (mode === "read-failed") { json(503, { error: "fixture" }); return; }
        if (!exists || mode === "absent") { json(404, { error: "fixture" }); return; }
        const body = { ...native, etag, ...(mode === "assigned" ? { assignmentInfo: { source: "DOCUMENT" } } : {}), ...(mode === "deleted" ? { deleted: true } : {}), ...(mode === "changed" ? { notes: "Other actor" } : {}), ...(mode === "weak-read" ? { etag: 'W/"weak"' } : {}) };
        json(200, body, mode === "partial" ? { "content-range": "bytes 0-1/2" } : {}); return;
      }
      if (req.method === "PATCH") { patches++; assert.equal(req.headers["if-match"], etag); let body = ""; for await (const chunk of req) body += chunk; native = { ...native, ...JSON.parse(body) }; etag = '"updated"'; json(200, { id: taskId, etag }); return; }
      if (req.method === "DELETE") { deletes++; assert.equal(req.headers["if-match"], etag); exists = false; res.writeHead(204); res.end(); return; }
    }
    json(500, { unexpected: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}/`;
  const ports = { http: { async fetch(value: string, init: RequestInit) { const u = new URL(value); assert.equal(u.origin, "https://tasks.googleapis.com"); const result = await globalThis.fetch(`${origin.slice(0, -1)}${u.pathname}${u.search}`, init); Object.defineProperty(result, "url", { value: u.href }); return result; } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() { metrics++; } } };
  const run = () => deliverReferenceTaskCreate(store, operationId, ports);
  const expire = () => pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [operationId]);
  async function fixture(label: string, body: (input: ReferenceTaskCreateAdmission, ids: { connectionId: string; objectId: string; bindingId: string }) => Promise<void>, admit = true, useCLI = false) {
    operationId = randomUUID(); listId = `native-list/${operationId}?`; taskId = `assigned-task/${operationId}?`; mode = "healthy"; posts = 0; patches = 0; deletes = 0; exists = false; etag = '"created"'; native = {}; methods = [];
    const ids = { connectionId: `create-c:${operationId}`, objectId: `create-o:${operationId}`, bindingId: `create-b:${operationId}` }, input = { bindingId: ids.bindingId, commandId: randomUUID(), operationId, expectedRevision: 1 };
    const seed = { provider: "google" as const, endpointProfile: "google-task-create-v1" as const, ...ids, taskListId: listId, operationId, accessToken: token, scope: "https://www.googleapis.com/auth/tasks", expiresAt: "2099-01-01T00:00:00.000Z", content };
    if (useCLI) { assert.equal((await cli("seed-task-create", seed)).status, "reserved"); if (admit) assert.equal((await cli("admit-task-create", input)).status, "pending"); }
    else { await store.seedCreateBinding(seed); if (admit) await store.admitCreate(input); }
    await body(input, ids); passed++; console.log(`PASS ${label}`);
  }
  function child(pause: string, admission?: ReferenceTaskCreateAdmission) {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./task-create-process-fixture.child.ts", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    children.add(proc); proc.on("exit", () => children.delete(proc)); proc.on("message", (value: any) => { if (value?.type === "metric") metrics++; }); proc.stdin!.end(JSON.stringify({ operationId, fixtureOrigin: origin, pause, ...(admission ? { action: "admit", admission } : {}) })); return proc;
  }
  async function kill(proc: ChildProcess) {
    await Promise.race([new Promise<void>((resolve, reject) => { proc.on("message", (value: any) => { if (value?.type === "checkpoint") resolve(); }); proc.once("exit", () => reject(new Error("Child exited before checkpoint"))); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Child checkpoint timeout")), 20_000); timer.unref(); })]);
    proc.kill("SIGKILL"); const [, signal] = await once(proc, "exit"); assert.equal(signal, "SIGKILL");
  }
  async function cli(command: string, value: object) {
    const preload = `const raw=globalThis.fetch;globalThis.fetch=async(url,init)=>{const u=new URL(url);if(u.origin!=='https://tasks.googleapis.com'||!u.pathname.startsWith('/tasks/v1/'))throw Error('Nonfixture network');const r=await raw(${JSON.stringify(origin)}.slice(0,-1)+u.pathname+u.search,init);Object.defineProperty(r,'url',{value:u.href});return r};`;
    const proc = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("./cli.ts", import.meta.url)), command], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; proc.stdout.on("data", value => stdout += value); proc.stderr.on("data", value => stderr += value); proc.stdin.end(JSON.stringify(value)); assert.equal((await once(proc, "exit"))[0], 0, stderr); assert.equal(stdout.includes(token), false); metrics += stderr.split("\n").filter(line => line.includes('"type":"provider-http"')).length; return JSON.parse(stdout);
  }
  async function ack() {
    const op = await store.inspectCreateOperation(operationId); assert.equal(op.status, "acked"); assert.equal(op.binding.taskId, taskId); assert.equal(op.binding.etag, '"created"'); assert.equal(op.binding.sourceGeneration, 2); assert.deepEqual(op.canonical.content, content); assert.equal((op.payload as any).operationEnvelope.locator.resourceId, null); assert.equal(posts, 1); const before = methods.length; assert.equal((await run()).status, "unclaimed"); assert.equal(methods.length, before);
  }
  try {
    await events.migrate();
    await fixture("fresh-native-CREATE-and-exact-GET-adoption", async () => { assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET", "POST", "GET"]); await ack(); });
    for (const modeValue of ["missing-tag", "weak-tag"]) await fixture(`${modeValue}-captures-ID-before-validator-and-adopts-fresh-GET`, async () => { mode = modeValue; assert.equal((await run()).status, "acked"); assert.equal((await store.inspectCreateOperation(operationId)).createResponse.responseAddress?.validator, null); await ack(); });
    for (const modeValue of ["bad-json", "no-id", "lost"]) await fixture(`${modeValue}-no-address-HOLD-never-search-or-second-POST`, async () => { mode = modeValue; assert.equal((await run()).status, "hold"); const op = await store.inspectCreateOperation(operationId); assert.equal(op.createResponse.acceptedStatus, modeValue === "lost" ? null : modeValue === "no-id" ? 201 : 200); assert.equal(op.createResponse.responseAddress, null); const offset = methods.length; await expire(); mode = "healthy"; assert.equal((await run()).status, "hold"); assert.deepEqual(methods.slice(offset), []); assert.equal(posts, 1); });
    await fixture("known429-sticky-marker-HOLD-without-second-POST", async () => { mode = "429"; assert.equal((await run()).status, "hold"); assert.equal((await run()).status, "unclaimed"); const offset = methods.length; await expire(); mode = "healthy"; assert.equal((await run()).status, "hold"); assert.deepEqual(methods.slice(offset), []); assert.equal(posts, 1); assert.equal((await store.inspectCreateOperation(operationId)).receipt.provider.kind, "rejected"); });
    await fixture("SIGKILL-canonical-admission-rolls-back-reservation-command", async input => { await kill(child("admissionCanonical", input)); assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE id=$1", [operationId])).rows[0].count, "0"); await store.admitCreate(input); assert.equal((await run()).status, "acked"); }, false);
    await fixture("SIGKILL-durable-marker-before-POST-stays-HOLD", async () => { await kill(child("beforeDispatch")); assert.equal(posts, 0); await expire(); assert.equal((await run()).status, "hold"); assert.equal(posts, 0); });
    await fixture("SIGKILL-after-raw-status-before-JSON-preserves-status-no-address", async () => { await kill(child("afterAcceptance")); const op = await store.inspectCreateOperation(operationId); assert.equal(op.createResponse.acceptedStatus, 200); assert.equal(op.createResponse.responseAddress, null); const offset = methods.length; await expire(); assert.equal((await run()).status, "hold"); assert.deepEqual(methods.slice(offset), []); assert.equal(posts, 1); });
    for (const point of ["afterResponseAddress", "afterReadback", "adoptionMapping"]) await fixture(`SIGKILL-${point}-recovers-exact-GET-without-rePOST`, async () => { await kill(child(point)); const op = await store.inspectCreateOperation(operationId); assert.equal(op.createResponse.responseAddress?.taskId, taskId); assert.equal(op.binding.destinationLifecycle, "reserved"); const offset = methods.length; await expire(); assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); await ack(); });
    await fixture("verification503-retains-candidate-and-recovers-GETonly", async () => { mode = "read-failed"; assert.equal((await run()).status, "hold"); const offset = methods.length; mode = "healthy"; await expire(); assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); await ack(); });
    for (const refusal of ["assigned", "deleted", "changed", "weak-read", "partial", "absent", "wrong-list"]) await fixture(`${refusal}-refuses-adoption-and-preserves-reservation`, async () => { mode = refusal; assert.notEqual((await run()).status, "acked"); assert.equal((await store.inspectCreateOperation(operationId)).binding.destinationLifecycle, "reserved"); assert.equal(posts, refusal === "wrong-list" ? 0 : 1); });
    await fixture("Calendar-only-scope-refuses-before-native-HTTP", async (_input, ids) => { await pool.query("UPDATE reference_connections SET scope='https://www.googleapis.com/auth/calendar.events' WHERE id=$1", [ids.connectionId]); assert.equal((await run()).status, "hold"); assert.deepEqual(methods, []); });
    await fixture("serial-native-CREATE-UPDATE-DELETE-keeps-paired-address-epoch", async (_input, ids) => {
      assert.equal((await run()).status, "acked"); const createId = operationId, updateId = randomUUID(); await store.admitUpdate({ bindingId: ids.bindingId, commandId: randomUUID(), operationId: updateId, expectedRevision: 2, patch: { name: "Serial native title" } }); assert.equal((await deliverReferenceTaskUpdate(store, updateId, ports)).status, "acked");
      const deleteId = randomUUID(); await store.admitDelete({ bindingId: ids.bindingId, commandId: randomUUID(), operationId: deleteId, expectedRevision: 3 }); assert.equal((await deliverReferenceTaskDelete(store, deleteId, ports)).status, "acked"); const deleted = await store.inspectDeleteOperation(deleteId); assert.equal(deleted.binding.destinationLifecycle, "absent"); assert.equal(deleted.binding.sourceGeneration, 2); assert.equal(deleted.binding.taskId, taskId); assert.equal(deleted.binding.etag, '"updated"'); assert.equal(patches, 1); assert.equal(deletes, 1); assert.equal((await store.inspectCreateOperation(createId)).createResponse.responseAddress?.taskId, taskId);
    });
    await fixture("actual-CLI-seed-admit-show-deliver-route-CREATE-profile", async () => {
      const pending = await cli("show-task", { operationId }); assert.equal(pending.action, "create"); assert.equal(pending.binding.taskId, null); assert.equal(pending.binding.etag, null); assert.equal(pending.binding.baseline, null);
      assert.equal((await cli("deliver-task", { operationId })).status, "acked"); await ack();
    }, true, true);
    const before = (await pool.query("SELECT id,payload,receipt,create_candidate_id,create_candidate_validator,create_acceptance_status FROM reference_task_operations ORDER BY id")).rows; await events.migrate(); await events.migrate(); assert.deepEqual((await pool.query("SELECT id,payload,receipt,create_candidate_id,create_candidate_validator,create_acceptance_status FROM reference_task_operations ORDER BY id")).rows, before);
    console.log(`Reference Task CREATE process: ${passed} cases passed; ${metrics} native metrics`);
  } finally { for (const proc of children) proc.kill("SIGKILL"); await Promise.all([...children].map(proc => once(proc, "exit").catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
