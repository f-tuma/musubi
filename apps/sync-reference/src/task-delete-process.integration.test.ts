import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import { REFERENCE_TASK_UPDATE_PROFILE } from "./task-admission.js";
import type { ReferenceTaskContent } from "./task-model.js";
import type { ReferenceTaskDeleteAdmission } from "./task-delete-model.js";
const key = "ab".repeat(32), scope = "https://www.googleapis.com/auth/tasks", token = "synthetic-task-delete-token";
const content: ReferenceTaskContent = { name: "Independent native task", notes: null, state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const baseline = { title: content.name, notes: null, due: "2026-10-26T00:00:00.000Z", status: "needsAction" as const };
const deferred = () => { let resolve!: () => void, reject!: (e: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); assert(adminUrl, "Explicit disposable DB required");
  const name = referenceTestDatabaseName("reference_task_delete_process_"), url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: url.href, max: 4 }), events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key), children = new Set<ChildProcess>();
  let operationId = "", taskId = "", taskListId = "", mode = "healthy", exists = true, deletes = 0, patches = 0, methods: string[] = [], failures: unknown[] = [], metrics = 0, remote: Record<string, unknown> = {}, acceptedEtag = '"original"', passed = 0;
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method!); assert.equal(req.headers.authorization, `Bearer ${token}`); assert.equal(req.url, `/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`);
      const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.method === "GET") {
        if (mode === "partial404") { res.setHeader("content-range", "bytes 0-1/2"); return json({}, 404); }
        if (mode === "initial410") return json({}, 410);
        if (mode === "verification-failed" && deletes) return json({}, 503);
        if (mode === "vanish-preflight" && methods.filter(value => value === "GET").length >= 2 || mode === "vanish-writer" && methods.filter(value => value === "GET").length >= 3) exists = false;
        if (!exists) return json({}, 404);
        if (mode === "assigned") return json({ ...remote, assignmentInfo: {} });
        if (mode === "deleted200") return json({ ...remote, deleted: true });
        if (mode === "weak") return json({ ...remote, etag: 'W/"weak"' });
        if (mode === "changed-tag") return json({ ...remote, etag: '"changed"' });
        if (mode === "changed-content") return json({ ...remote, notes: "Concurrent native notes" });
        return json(remote);
      }
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      assert.equal(req.headers["if-match"], acceptedEtag);
      if (req.method === "PATCH") { patches++; const row = (await pool.query("SELECT saved_projection FROM reference_task_operations WHERE id=$1", [operationId])).rows[0]; assert.deepEqual(JSON.parse(bytes), row.saved_projection.patch); remote = { ...remote, ...JSON.parse(bytes), etag: '"updated"' }; return json(remote); }
      assert.equal(req.method, "DELETE"); deletes++; assert.equal(bytes, "", "Task DELETE never serializes an UPDATE body or a canonical task");
      if (mode === "429") { res.setHeader("retry-after", "7"); return json({}, 429); }
      if (mode === "412") return json({}, 412);
      if (mode === "lost-unapplied") return res.destroy();
      exists = mode === "accepted-retained" || mode === "delete404-retained";
      if (mode === "lost") return res.destroy();
      const status = mode === "delete404" || mode === "delete404-retained" ? 404 : mode === "delete410" ? 410 : mode === "accepted202" ? 202 : mode === "accepted226" ? 226 : 204;
      res.writeHead(status); res.end();
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned Task DELETE fixture failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  function child(pause?: string, admission?: unknown, family: "update" | "delete" = "delete") {
    const checkpoint = deferred(); let stdout = "", stderr = "";
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./task-process-fixture.child.ts", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"] }); children.add(proc);
    const timer = setTimeout(() => { checkpoint.reject(new Error("Owned Task DELETE child timed out")); proc.kill("SIGKILL"); }, 30_000);
    proc.stdout!.on("data", value => stdout += value); proc.stderr!.on("data", value => stderr += value); proc.on("message", (value: any) => { if (value.type === "checkpoint") checkpoint.resolve(); if (value.type === "metric") metrics++; });
    const exited = once(proc, "exit").then(([code, signal]) => { clearTimeout(timer); children.delete(proc); return { code, signal, stdout, stderr }; });
    proc.stdin!.end(JSON.stringify({ operationId, fixtureOrigin: origin, pause, family, ...(admission ? { action: "admit", admission } : {}) })); return { proc, checkpoint: checkpoint.promise, exited };
  }
  async function run(family: "update" | "delete" = "delete") { const result = await child(undefined, undefined, family).exited; assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.stdout.includes(token), false); return JSON.parse(result.stdout); }
  async function kill(value: ReturnType<typeof child>) { await value.checkpoint; value.proc.kill("SIGKILL"); assert.equal((await value.exited).signal, "SIGKILL"); }
  const expire = () => pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [operationId]);
  async function fixture(label: string, body: (input: ReferenceTaskDeleteAdmission, ids: { objectId: string; bindingId: string; connectionId: string }) => Promise<void>, admit = true) {
    const id = randomUUID(), ids = { objectId: `delete-process-object:${id}`, bindingId: `delete-process-binding:${id}`, connectionId: `delete-process-connection:${id}` };
    operationId = randomUUID(); taskId = `native-task/${id}?`; taskListId = `native-list/${id}?`; mode = "healthy"; exists = true; deletes = 0; patches = 0; methods = []; failures = []; metrics = 0; acceptedEtag = '"original"'; remote = { id: taskId, ...baseline, etag: acceptedEtag };
    await store.seedBinding({ ...ids, taskId, taskListId, provider: "google", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, accessToken: token, scope, expiresAt: "2099-01-01T00:00:00.000Z", content, baseline, etag: acceptedEtag });
    const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId }; if (admit) await store.admitDelete(input);
    await body(input, ids); assert.deepEqual(failures, []); assert.equal(metrics, methods.length); passed++; console.log(`Reference Task DELETE process: ${label}: PASS`);
  }
  async function ack(provider: string, acceptedStatus: number | null = null, responseAbsenceStatus: 404 | 410 | null = null) {
    const op = await store.inspectDeleteOperation(operationId), raw = (await pool.query("SELECT accepted_etag,delete_accepted_baseline FROM reference_task_operations WHERE id=$1", [operationId])).rows[0];
    assert.equal(op.status, "acked"); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.receipt.remote.kind, "confirmed"); assert.deepEqual(op.deleteResponse, { acceptedStatus, responseAbsenceStatus });
    assert.equal(op.binding.destinationLifecycle, "absent"); assert.equal(op.binding.active, true); assert.equal(op.binding.sourceGeneration, op.capture.sourceGeneration); assert.equal(op.binding.etag, raw.accepted_etag); assert.deepEqual(op.binding.baseline, raw.delete_accepted_baseline);
    assert.equal(op.canonical.lifecycle, "tombstoned"); assert.equal(op.canonical.content.state, "doing"); assert.equal(op.canonical.content.dueAt, content.dueAt); assert.equal(op.canonical.content.importance, "high");
    const start = methods.length; assert.equal((await run()).status, "unclaimed"); assert.equal(methods.length, start);
  }
  try {
    await events.migrate();
    await fixture("fresh-exact-native-guard-DELETE-then-GETabsence", async () => { assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET", "GET", "GET", "DELETE", "GET"]); assert.equal(deletes, 1); await ack("accepted", 204); });
    for (const status of [404, 410]) await fixture(`fresh-GET${status}-ACK-no-dispatch-no-response-facts`, async () => { if (status === 404) exists = false; else mode = "initial410"; assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET"]); assert.equal(deletes, 0); await ack("not-dispatched"); });
    for (const disappear of ["vanish-preflight", "vanish-writer"]) await fixture(`${disappear}-writerGETabsence-is-not-DELETE-response`, async () => { mode = disappear; assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET", "GET", "GET"]); assert.equal(deletes, 0); await ack("not-dispatched"); });
    for (const status of [404, 410]) await fixture(`DELETE${status}-fulfills-response-but-separate-GETconfirms`, async () => { mode = status === 404 ? "delete404" : "delete410"; assert.equal((await run()).status, "acked"); assert.deepEqual(methods, ["GET", "GET", "GET", "DELETE", "GET"]); await ack("accepted", null, status as 404 | 410); });
    for (const status of [202, 226]) await fixture(`raw-accepted${status}-persists-without-widening-UPDATE-status`, async () => { mode = status === 202 ? "accepted202" : "accepted226"; assert.equal((await run()).status, "acked"); await ack("accepted", status); });
    await fixture("SIGKILL-real-tombstone-admission-rolls-back-all-local-changes", async (input, ids) => { await kill(child("admissionCanonical", input)); assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE id=$1", [operationId])).rows[0].count, "0"); assert.equal((await pool.query("SELECT canonical_lifecycle FROM reference_task_objects WHERE id=$1", [ids.objectId])).rows[0].canonical_lifecycle, "active"); await store.admitDelete(input); assert.equal((await run()).status, "acked"); }, false);
    await fixture("kill-after-durable-marker-before-DELETE-retries-original-version", async () => { await kill(child("beforeDispatch")); assert.equal(deletes, 0); await expire(); assert.equal((await run()).status, "acked"); assert.equal(deletes, 1); await ack("accepted", 204); });
    await fixture("accepted2xx-then-SIGKILL-restarts-GETonly", async () => { await kill(child("afterAcceptance")); const op = await store.inspectDeleteOperation(operationId); assert.equal(op.deleteResponse.acceptedStatus, 204); const offset = methods.length; await expire(); assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset, offset + 1), ["GET"]); assert.equal(deletes, 1); await ack("accepted", 204); });
    await fixture("DELETE404-response-then-SIGKILL-retains-absence-only-fact", async () => { mode = "delete404"; await kill(child("afterAcceptance")); const op = await store.inspectDeleteOperation(operationId); assert.deepEqual(op.deleteResponse, { acceptedStatus: null, responseAbsenceStatus: 404 }); await expire(); mode = "healthy"; const offset = methods.length; assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset, offset + 1), ["GET"]); assert.equal(deletes, 1); await ack("accepted", null, 404); });
    await fixture("lost-applied-DELETE-then-SIGKILL-ACKs-GETonly-as-uncertain", async () => { mode = "lost"; await kill(child("afterUncertain")); await expire(); mode = "healthy"; const offset = methods.length; assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset, offset + 1), ["GET"]); assert.equal(deletes, 1); await ack("uncertain"); });
    await fixture("lost-unapplied-DELETE-then-SIGKILL-may-retry-only-original-tag", async () => { mode = "lost-unapplied"; await kill(child("afterUncertain")); await expire(); mode = "healthy"; assert.equal((await run()).status, "acked"); assert.equal(deletes, 2); await ack("accepted", 204); });
    await fixture("inherited-unknown-current429-keeps-uncertainty-and-RetryAfter", async () => { mode = "lost-unapplied"; await kill(child("afterUncertain")); await expire(); mode = "429"; assert.equal((await run()).status, "hold"); assert.equal((await store.inspectDeleteOperation(operationId)).receipt.provider.kind, "uncertain"); assert.equal((await run()).status, "unclaimed"); exists = false; mode = "healthy"; await expire(); assert.equal((await run()).status, "acked"); assert.equal(deletes, 2); await ack("uncertain"); });
    await fixture("known429-new-dispatch-lost-response-retains-new-uncertainty", async () => { mode = "429"; assert.equal((await run()).status, "hold"); assert.equal((await store.inspectDeleteOperation(operationId)).receipt.provider.kind, "rejected"); await expire(); mode = "lost"; await kill(child("afterUncertain")); await expire(); mode = "healthy"; assert.equal((await run()).status, "acked"); assert.equal(deletes, 2); await ack("uncertain"); });
    for (const retained of ["accepted-retained", "delete404-retained"]) await fixture(`${retained}-known-response-present-recovery-observe-only`, async () => { mode = retained; assert.equal((await run()).status, "hold"); await expire(); const offset = methods.length; mode = "healthy"; assert.equal((await run()).status, "hold"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(deletes, 1); exists = false; await expire(); assert.equal((await run()).status, "acked"); await ack("accepted", retained === "accepted-retained" ? 204 : null, retained === "delete404-retained" ? 404 : null); });
    await fixture("accepted-response-verification-failure-restarts-GETonly", async () => { mode = "verification-failed"; assert.equal((await run()).status, "hold"); assert.equal((await store.inspectDeleteOperation(operationId)).deleteResponse.acceptedStatus, 204); await expire(); mode = "healthy"; const offset = methods.length; assert.equal((await run()).status, "acked"); assert.deepEqual(methods.slice(offset), ["GET"]); assert.equal(deletes, 1); });
    await fixture("kill-after-confirmed-absence-before-ACK-preserves-paired-history", async () => { await kill(child("afterReadback")); assert.equal((await store.inspectDeleteOperation(operationId)).receipt.remote.kind, "confirmed"); await expire(); assert.equal((await run()).status, "acked"); assert.equal(deletes, 1); await ack("accepted", 204); });
    for (const refusal of ["assigned", "deleted200", "weak", "changed-tag", "changed-content", "partial404", "412"]) await fixture(`${refusal}-refuses-ACK-without-unrelated-mutation`, async () => { mode = refusal; assert.notEqual((await run()).status, "acked"); assert.equal(deletes, refusal === "412" ? 1 : 0); const op = await store.inspectDeleteOperation(operationId); assert.equal(op.binding.destinationLifecycle, "present"); assert.equal(op.binding.active, true); if (refusal === "412") { await expire(); assert.equal((await run()).status, "unclaimed"); } });
    await fixture("Calendar-only-scope-refuses-before-native-HTTP", async (_input, ids) => { await pool.query("UPDATE reference_connections SET scope='https://www.googleapis.com/auth/calendar.events' WHERE id=$1", [ids.connectionId]); assert.equal((await run()).status, "hold"); assert.deepEqual(methods, []); });
    await fixture("serial-real-native-UPDATE-then-DELETE-keeps-confirmed-version-history", async (input, ids) => {
      const updateId = randomUUID(); operationId = updateId; await store.admitUpdate({ bindingId: ids.bindingId, commandId: randomUUID(), operationId: updateId, expectedRevision: 1, patch: { name: "Serial native title" } }); assert.equal((await run("update")).status, "acked");
      operationId = input.operationId; await store.admitDelete({ ...input, expectedRevision: 2 }); acceptedEtag = '"updated"'; assert.equal((await run()).status, "acked"); assert.equal(patches, 1); assert.equal(deletes, 1); const op = await store.inspectDeleteOperation(operationId); assert.equal(op.binding.etag, '"updated"'); assert.equal(op.binding.baseline.title, "Serial native title"); assert.equal(op.binding.sourceGeneration, 1);
    }, false);
    await fixture("actual-production-CLI-deliver-task-dispatches-DELETE-profile", async () => {
      const preload = `const raw=globalThis.fetch;globalThis.fetch=async(url,init)=>{const u=new URL(url);if(u.origin!=='https://tasks.googleapis.com'||!u.pathname.startsWith('/tasks/v1/lists/'))throw Error('Nonfixture network');const r=await raw(${JSON.stringify(origin)}.slice(0,-1)+u.pathname+u.search,init);Object.defineProperty(r,'url',{value:u.href});return r};`;
      const proc = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL("./cli.ts", import.meta.url)), "deliver-task"], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: url.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = ""; proc.stdout.on("data", value => stdout += value); proc.stderr.on("data", value => stderr += value); proc.stdin.end(JSON.stringify({ operationId })); assert.equal((await once(proc, "exit"))[0], 0, stderr); assert.equal(JSON.parse(stdout).status, "acked"); metrics += stderr.split("\n").filter(line => line.includes('"type":"provider-http"')).length; assert.equal(stdout.includes(token), false); await ack("accepted", 204);
    });
    console.log(`Reference Task DELETE process: ${passed} cases passed`);
  } finally { for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => once(child, "exit").catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
