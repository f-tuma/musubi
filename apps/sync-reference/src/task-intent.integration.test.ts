import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import type { ReferenceTaskContent } from "./task-model.js";
import type { ReferenceTaskCreateClaim } from "./task-create-model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit disposable DB required");
const name = referenceTestDatabaseName("reference_task_intent_"), url = new URL(adminUrl); url.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: url.href, max: 7 }), key = "b1".repeat(32), events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key);
const scope = "https://www.googleapis.com/auth/tasks", content: ReferenceTaskContent = { name: "Queued rich task", notes: null, state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const projection = { title: content.name, notes: null, status: "needsAction" as const, due: "2026-10-26T00:00:00.000Z" }, updatedProjection = { ...projection, title: "Queued successor title" };
const oldTables = ["reference_connections", "reference_objects", "reference_bindings", "reference_operations", "reference_attempts", "reference_task_objects", "reference_task_bindings", "reference_task_operations", "reference_task_attempts"];
const causalColumns = new Set(["predecessor_operation_id", "queued_intent_id", "resolution_basis", "completion_evidence"]);
const op = async (id: string) => (await pool.query("SELECT * FROM reference_task_operations WHERE id=$1", [id])).rows[0];
const intent = async (id: string) => (await pool.query("SELECT * FROM reference_task_intents WHERE id=$1", [id])).rows[0];
const canonical = async (id: string) => (await pool.query("SELECT * FROM reference_task_objects WHERE id=$1", [id])).rows[0];
const oids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relname LIKE 'reference_%' AND relkind IN ('r','i') ORDER BY relname")).rows;
async function oldRows(strip = false) { const result: Record<string, unknown> = {}; for (const table of oldTables) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows.map(row => strip && table === "reference_task_operations" ? Object.fromEntries(Object.entries(row).filter(([k]) => !causalColumns.has(k))) : row); return result; }
async function fixture() {
  const id = randomUUID(), ids = { connectionId: `intent-c:${id}`, objectId: `intent-o:${id}`, bindingId: `intent-b:${id}`, taskListId: `intent-list/${id}?`, operationId: id };
  await store.seedCreateBinding({ ...ids, provider: "google", endpointProfile: "google-task-create-v1", accessToken: "synthetic-intent-token", scope, expiresAt: "2099-01-01T00:00:00.000Z", content });
  await store.admitCreate({ bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id });
  return ids;
}
async function queuePair() {
  const f = await fixture(), update = { bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), predecessorOperationId: f.operationId, patch: { name: updatedProjection.title } }, deletion = { bindingId: f.bindingId, expectedRevision: 3, commandId: randomUUID(), operationId: randomUUID(), predecessorOperationId: update.operationId };
  await store.queueUpdate(update); await store.queueDelete(deletion); return { ...f, update, deletion };
}
function present(taskId: string, etag: string, value = projection) { return { kind: "present" as const, etag, task: { ...value, id: taskId, etag } }; }
async function completeCreate(f: Awaited<ReturnType<typeof fixture>>) {
  const claim = await store.claimCreate(f.operationId, randomUUID()); assert(claim); const taskId = `assigned/${f.operationId}?`, read = present(taskId, '"created"');
  await store.markCreateDispatch(claim); await store.recordCreateEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 200, possibleDispatch: true, responseAddress: { taskId, validator: '"response"' }, remote: { kind: "confirmed", observationId: randomUUID(), read, projection } });
  assert.equal(await store.completeCreate(claim, { kind: "exact-readback", taskId, validator: read.etag, projection, read }), true); return { claim, taskId };
}
async function completeUpdate(id: string, taskId: string) {
  const claim = await store.claim(id, randomUUID()); assert(claim); const prepared = await store.prepare(claim), read = present(taskId, '"updated"', updatedProjection);
  await store.markDispatch(claim); await store.recordEvidence(claim, { provider: { kind: "accepted", validator: read.etag }, acceptedStatus: 200, possibleDispatch: true, remote: { kind: "confirmed", observationId: randomUUID(), read, projection: updatedProjection } });
  assert.equal(await store.completeUpdate(claim, { validator: read.etag, projection: updatedProjection, read, saved: prepared.saved }), true); return claim;
}
let previousRows: unknown, previousOids: { relname: string; oid: number }[];
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const file of ["schema.sql", "schema-delete.sql", "schema-create.sql", "schema-graph-delete.sql", "schema-caldav-delete.sql", "schema-graph-create.sql", "schema-caldav-create.sql", "schema-google-task-update.sql", "schema-google-task-delete.sql", "schema-google-task-create.sql"]) await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const oldContent = { name: "Old event", notes: null, place: "Room", beginsAt: "2026-10-26T08:00:00.000Z", endsAt: "2026-10-26T09:00:00.000Z" };
  for (const family of ["google-update", "google-delete", "google-create", "microsoft-delete", "microsoft-create", "caldav-delete", "caldav-create"]) {
    const id = randomUUID(), base = { connectionId: `old-c:${id}`, objectId: `old-o:${id}`, bindingId: `old-b:${id}`, calendarId: `old-calendar:${id}`, accessToken: "synthetic-old-token", scope: "https://www.googleapis.com/auth/calendar.events", expiresAt: "2099-01-01T00:00:00.000Z", content: oldContent }, input = { bindingId: base.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id };
    if (family === "google-update" || family === "google-delete") { await events.seedBinding({ ...base, eventId: `old-native:${id}`, etag: '"old"' }); if (family === "google-update") await events.admitUpdate({ ...input, patch: { name: "Old pending title" } }); else await events.admitDelete(input); }
    else if (family === "google-create") { await events.seedCreateBinding({ ...base, operationId: id }); await events.admitCreate(input); }
    else if (family === "microsoft-delete") { await events.seedGraphDeleteBinding({ ...base, provider: "microsoft", endpointProfile: "microsoft-personal-event-delete-v1", scope: "Calendars.ReadWrite", eventId: `old-graph:${id}`, etag: 'W/"old"' }); await events.admitGraphDelete(input); }
    else if (family === "microsoft-create") { await events.seedGraphCreateBinding({ ...base, provider: "microsoft", endpointProfile: "microsoft-personal-event-create-v1", scope: "Calendars.ReadWrite", operationId: id }); await events.admitGraphCreate(input); }
    else { const dav = { provider: "caldav" as const, connectionId: base.connectionId, objectId: base.objectId, bindingId: base.bindingId, calendarUrl: `https://dav.example.test/${id}/`, username: "owned", password: "synthetic-dav", expiresAt: base.expiresAt, content: oldContent };
      if (family === "caldav-delete") { await events.seedCaldavDeleteBinding({ ...dav, endpointProfile: "caldav-personal-event-delete-v1", resourceUrl: dav.calendarUrl + "native.ics", uid: `uid:${id}`, etag: '"old"' }); await events.admitCaldavDelete(input); }
      else { await events.seedCaldavCreateBinding({ ...dav, endpointProfile: "caldav-personal-event-create-v1", operationId: id }); await events.admitCaldavCreate(input); }
    }
    const claim = await events.claim(id, randomUUID()); assert(claim); await events.markDispatch(claim);
    if (family === "microsoft-create") await events.recordGraphCreateEvidence(claim, { provider: "accepted", candidateEventId: `assigned:${id}`, createAcceptance: { status: 201, validator: "raw-native-version" }, remote: "unobserved" });
    else if (family === "caldav-create") await events.recordCaldavCreateEvidence(claim, { provider: "accepted", createAcceptanceStatus: 201, remote: "unobserved" });
    else await events.recordEvidence(claim, { provider: "uncertain", remote: "unobserved" });
  }
  for (const action of ["update", "delete"] as const) {
    const id = randomUUID(), bindingId = `old-task-b:${id}`;
    await store.seedBinding({ provider: "google", endpointProfile: "google-task-update-v1", connectionId: `old-task-c:${id}`, objectId: `old-task-o:${id}`, bindingId, taskListId: `old-list:${id}`, taskId: `old-task:${id}`, accessToken: "old-task-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content, baseline: projection, etag: '"old"' });
    const input = { bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id };
    if (action === "update") { await store.admitUpdate({ ...input, patch: { name: "Old Task UPDATE" } }); const claim = await store.claim(id, randomUUID()); assert(claim); await store.markDispatch(claim); await store.recordEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 200, possibleDispatch: true, remote: { kind: "unobserved" } }); }
    else { await store.admitDelete(input); const claim = await store.claimDelete(id, randomUUID()); assert(claim); await store.markDeleteDispatch(claim); await store.recordDeleteEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 226, responseAbsenceStatus: 410, possibleDispatch: true, remote: { kind: "unobserved" } }); }
  }
  const oldCreate = await fixture(), claim = await store.claimCreate(oldCreate.operationId, randomUUID()); assert(claim); await store.markCreateDispatch(claim); await store.recordCreateEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 200, possibleDispatch: true, responseAddress: { taskId: "old-assigned", validator: null }, remote: { kind: "unobserved" } });
  previousRows = await oldRows(); previousOids = await oids(); await events.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("causal migration retains ten populated profiles, full history/epochs/sidecars and every old28OID", async () => {
  assert.equal(previousOids.length, 28); await events.migrate(); await events.migrate(); assert.deepEqual(await oldRows(true), previousRows);
  const after = new Map((await oids()).map(row => [row.relname, row.oid])); for (const row of previousOids) assert.equal(after.get(row.relname), row.oid, row.relname);
});
test("queued UPDATE and DELETE retain null envelopes and leave pending CREATE canonical authority intact", async () => {
  const f = await queuePair(), root = await op(f.operationId), local = await canonical(f.objectId);
  assert.equal(Number(local.revision), 2); assert.equal(local.canonical_lifecycle, "active"); assert.equal(Number(local.lifecycle_generation), 1); assert.deepEqual(local.content, content);
  for (const [id, predecessor, revision] of [[f.update.operationId, f.operationId, 3], [f.deletion.operationId, f.update.operationId, 4]] as const) {
    const row = await intent(id), inspected = await store.inspectIntent(id); assert(inspected); assert.equal(row.payload.operationEnvelope.locator.resourceId, null); assert.equal(row.payload.operationEnvelope.predecessorOperationId, predecessor); assert.equal(row.payload.operationEnvelope.sourceEpoch.generation, 1); assert.equal(row.payload.operationEnvelope.acceptedRevision, revision); assert.equal(await op(id), undefined);
  }
  const claim = await store.claimCreate(f.operationId, randomUUID()); assert(claim); assert.equal((await store.prepareCreate(claim)).dispatchAllowed, true); assert.deepEqual((await op(f.operationId)).payload, root.payload);
});
test("queue CAS, idempotency and terminal DELETE prevent forks without materializing canonical edits", async () => {
  const f = await fixture(), input = { bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), predecessorOperationId: f.operationId, patch: { name: "First queued" } };
  const competing = { ...input, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "Competing" } }, results = await Promise.allSettled([store.queueUpdate(input), store.queueUpdate(competing)]); assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const winner = results[0].status === "fulfilled" ? input : competing;
  await store.queueUpdate(winner); await assert.rejects(store.queueUpdate({ ...winner, patch: { name: "Different reused command" } }));
  const del = { bindingId: f.bindingId, expectedRevision: 3, commandId: randomUUID(), operationId: randomUUID(), predecessorOperationId: winner.operationId }; await store.queueDelete(del);
  await assert.rejects(store.queueUpdate({ ...winner, expectedRevision: 4, commandId: randomUUID(), operationId: randomUUID(), predecessorOperationId: del.operationId }));
  assert.equal(Number((await canonical(f.objectId)).revision), 2);
});
test("waiting successors cannot claim, create an attempt or bypass CREATE with an addressed command", async () => {
  const f = await queuePair(); assert.equal(await store.claim(f.update.operationId, randomUUID()), null); assert.equal(await store.claimDelete(f.deletion.operationId, randomUUID()), null);
  assert.equal((await pool.query("SELECT count(*) FROM reference_task_attempts WHERE operation_id IN ($1,$2)", [f.update.operationId, f.deletion.operationId])).rows[0].count, "0");
  await completeCreate(f); await assert.rejects(store.admitUpdate({ bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "Bypass queue" } }));
  await assert.rejects(store.admitDelete({ bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID() }));
});
test("queue admission refuses foreign lineage and intent bytes cannot be rewritten or deleted", async () => {
  const f = await fixture(), foreign = await fixture(), input = { bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), predecessorOperationId: foreign.operationId, patch: { name: "Foreign predecessor" } };
  await assert.rejects(store.queueUpdate(input)); const { patch: _patch, ...foreignDelete } = input; await assert.rejects(store.queueDelete(foreignDelete));
  await store.queueUpdate({ ...input, predecessorOperationId: f.operationId });
  await assert.rejects(pool.query("UPDATE reference_task_intents SET content='{}'::jsonb WHERE id=$1", [input.operationId]), /immutable/);
  await assert.rejects(pool.query("DELETE FROM reference_task_intents WHERE id=$1", [input.operationId]), /immutable/);
  assert.equal(Number((await canonical(f.objectId)).revision), 2);
});
test("SQL rejects NULL predecessor alternatives instead of accepting an unknown CHECK result", async () => {
  const f = await queuePair();
  await assert.rejects(pool.query(`INSERT INTO reference_task_intents
    SELECT (jsonb_populate_record(NULL::reference_task_intents,to_jsonb(i)||jsonb_build_object(
      'id',$2::text,'command_id',$3::text,'predecessor_intent_id',NULL::text,'predecessor_operation_id',$4::text,
      'expected_revision',4,'accepted_revision',5))).* FROM reference_task_intents i WHERE id=$1`,
  [f.update.operationId, randomUUID(), randomUUID(), f.deletion.operationId]), /check constraint/);
  await completeCreate(f); const claim = await store.claim(f.update.operationId, randomUUID()); assert(claim);
  await assert.rejects(pool.query(`INSERT INTO reference_task_operations
    SELECT (jsonb_populate_record(NULL::reference_task_operations,to_jsonb(o)||jsonb_build_object(
      'id',$2::text,'command_id',$3::text,'queued_intent_id',NULL::text,'status','acked',
      'lease_attempt_id',NULL::text,'lease_until',NULL::text))).* FROM reference_task_operations o WHERE id=$1`,
  [f.update.operationId, randomUUID(), randomUUID()]), /check constraint/);
});
test("activation pairs actual predecessor completion while original intent/address/capture remain immutable", async () => {
  const f = await queuePair(), before = await intent(f.update.operationId), created = await completeCreate(f), claim = await store.claim(f.update.operationId, randomUUID()); assert(claim);
  const raw = await op(claim.operationId), prepared = await store.prepare(claim), address = prepared.predecessorAddress; assert(address && address.kind === "predecessor-task-reference");
  assert.equal(address.operationId, claim.operationId); assert.equal(address.attemptId, claim.attemptId); assert.equal(address.predecessorOperationId, f.operationId); assert.equal(address.evidenceOperationId, f.operationId); assert.equal(address.taskId, created.taskId); assert.equal(address.validator, '"created"'); assert.deepEqual(address.projectionBaseline, projection); assert(address.witness);
  assert.equal(raw.task_id, null); assert.equal(Number(raw.source_generation), 1); assert.equal(raw.payload.operationEnvelope.locator.resourceId, null); assert.equal(raw.payload.operationEnvelope.sourceEpoch.generation, 1); assert.deepEqual(prepared.saved.baseline, projection); assert.deepEqual(prepared.saved.patch, { title: updatedProjection.title });
  const completion = (await op(f.operationId)).completion_evidence; assert.equal(completion.kind, "present"); assert.equal(completion.taskId, created.taskId); assert.equal(completion.validator, '"created"'); assert.deepEqual(completion.projectionBaseline, projection); assert.equal(completion.sourceGeneration, 2); assert.deepEqual(completion.adoption, { operationId: f.operationId, from: 1, to: 2 });
  await assert.rejects(pool.query("UPDATE reference_task_operations SET completion_evidence='{}'::jsonb WHERE id=$1", [f.operationId]), /immutable/);
  assert.equal(Number((await canonical(f.objectId)).revision), 3); assert.equal((await canonical(f.objectId)).canonical_lifecycle, "active"); assert.deepEqual(await intent(f.update.operationId), before);
  assert.equal((await store.inspectCreateOperation(f.operationId)).binding.sourceGeneration, 2); assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE binding_id=$1 AND status<>'acked'", [f.bindingId])).rows[0].count, "1");
  for (const column of ["resolution_basis", "completion_evidence"]) { if (raw[column] !== null) await assert.rejects(pool.query(`UPDATE reference_task_operations SET ${column}='{}'::jsonb WHERE id=$1`, [claim.operationId]), /immutable/); }
});
test("queued UPDATE ACK feeds DELETE one real matched ID/tag/baseline at epoch2", async () => {
  const f = await queuePair(), created = await completeCreate(f); await completeUpdate(f.update.operationId, created.taskId); const claim = await store.claimDelete(f.deletion.operationId, randomUUID()); assert(claim);
  const prepared = await store.prepareDelete(claim), address = prepared.predecessorAddress; assert(address && address.kind === "predecessor-task-reference"); assert.equal(address.predecessorOperationId, f.update.operationId); assert.equal(address.evidenceOperationId, f.update.operationId); assert.equal(address.validator, '"updated"'); assert.deepEqual(address.projectionBaseline, updatedProjection);
  const local = await canonical(f.objectId); assert.equal(Number(local.revision), 4); assert.equal(local.canonical_lifecycle, "tombstoned"); assert.equal(Number(local.lifecycle_generation), 2); assert.equal(local.content.state, "doing"); assert.equal(local.content.dueAt, content.dueAt); assert.equal(local.content.importance, "high");
  await store.markDeleteDispatch(claim); await store.recordDeleteEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 204, possibleDispatch: true, remote: { kind: "absent", source: "readback", observationId: randomUUID(), read: { kind: "absent", status: 404 } } });
  assert.equal(await store.completeDelete(claim, { kind: "exact-absence", source: "readback", read: { kind: "absent", status: 404 } }), true);
  const final = await store.inspectDeleteOperation(claim.operationId); assert.equal(final.binding.destinationLifecycle, "absent"); assert.equal(final.binding.sourceGeneration, 2); assert.equal(final.binding.active, true); assert.equal(final.binding.etag, '"updated"'); assert.deepEqual(final.binding.baseline, updatedProjection);
});
test("unknown CREATE leaves every successor waiting without materialization or fictitious no-resource ACK", async () => {
  const f = await queuePair(), root = await store.claimCreate(f.operationId, randomUUID()); assert(root); await store.markCreateDispatch(root); await store.recordCreateEvidence(root, { provider: { kind: "uncertain" }, possibleDispatch: true, remote: { kind: "unobserved" } }); await store.finish(root, "hold");
  assert.equal(await store.claim(f.update.operationId, randomUUID()), null); assert.equal(await store.claimDelete(f.deletion.operationId, randomUUID()), null); assert.equal(await op(f.update.operationId), undefined); assert.equal(await op(f.deletion.operationId), undefined); assert.equal(Number((await canonical(f.objectId)).revision), 2); assert.equal((await canonical(f.objectId)).canonical_lifecycle, "active");
});
test("ancestor receipt ownership and truthful CREATE provider are required before activation", async () => {
  for (const mode of ["operation", "attempt", "object", "revision", "provider"] as const) {
    const f = await queuePair(); await completeCreate(f); const root = await op(f.operationId), receipt = structuredClone(root.receipt);
    if (mode === "operation") receipt.operationId = randomUUID();
    if (mode === "attempt") receipt.attemptId = randomUUID();
    if (mode === "object") receipt.local.hostObjectId = "foreign-canonical-object";
    if (mode === "revision") receipt.local.revision = "foreign-revision";
    if (mode === "provider") receipt.provider = { kind: "not-dispatched" };
    await pool.query("UPDATE reference_task_operations SET receipt=$2 WHERE id=$1", [root.id, receipt]);
    await pool.query("UPDATE reference_task_attempts SET receipt=$2 WHERE id=$1", [root.completion_evidence.attemptId, receipt]);
    await assert.rejects(store.claim(f.update.operationId, randomUUID()), mode);
    assert.equal(await op(f.update.operationId), undefined); assert.equal(Number((await canonical(f.objectId)).revision), 2);
  }
});
test("ancestor receipt history and owned attempt are revalidated before credentials, dispatch and ACK", async () => {
  for (const mode of ["receipt-history", "attempt-history"] as const) {
    const f = await queuePair(), created = await completeCreate(f), claim = await store.claim(f.update.operationId, randomUUID()); assert(claim);
    const saved = (await store.prepare(claim)).saved, root = await op(f.operationId), receipt = { ...root.receipt, provider: { kind: "uncertain" } };
    if (mode === "receipt-history") await pool.query("UPDATE reference_task_operations SET receipt=$2 WHERE id=$1", [root.id, receipt]);
    await pool.query("UPDATE reference_task_attempts SET receipt=$2 WHERE id=$1", [root.completion_evidence.attemptId, receipt]);
    await assert.rejects(store.prepare(claim)); await assert.rejects(store.getSession(claim)); await assert.rejects(store.markDispatch(claim));
    const read = present(created.taskId, '\"updated\"', updatedProjection);
    assert.equal(await store.completeUpdate(claim, { validator: read.etag, projection: updatedProjection, read, saved }), false);
    assert.equal((await op(claim.operationId)).dispatch_possible, false); assert.equal((await store.inspectCreateOperation(root.id)).binding.etag, '\"created\"');
  }
});
test("truthful rejected UPDATE recovery remains a paired predecessor without inventing acceptance", async () => {
  const f = await queuePair(), created = await completeCreate(f), rejected = { kind: "rejected" as const, error: { code: "rate-limited" as const, retry: "after-delay" as const, retryAfterMs: 0 } };
  const first = await store.claim(f.update.operationId, randomUUID()); assert(first); await store.markDispatch(first);
  await store.recordEvidence(first, { provider: rejected, possibleDispatch: true, remote: { kind: "unobserved" } }); await store.finish(first, "hold");
  const recovered = await store.claim(f.update.operationId, randomUUID()); assert(recovered); assert.equal(recovered.recovery, true);
  const saved = (await store.prepare(recovered)).saved, read = present(created.taskId, '\"updated\"', updatedProjection);
  await store.recordEvidence(recovered, { provider: rejected, possibleDispatch: true, remote: { kind: "confirmed", observationId: randomUUID(), read, projection: updatedProjection } });
  assert.equal(await store.completeUpdate(recovered, { validator: read.etag, projection: updatedProjection, read, saved }), true);
  const claim = await store.claimDelete(f.deletion.operationId, randomUUID()); assert(claim); const prepared = await store.prepareDelete(claim);
  assert.equal(prepared.predecessorAddress?.evidenceOperationId, f.update.operationId); assert.equal((await op(f.update.operationId)).receipt.provider.kind, "rejected"); assert.equal((await op(f.update.operationId)).native_acceptance_status, null);
});
for (const mode of ["scope", "source-ABA", "connection-ABA", "privacy-ABA", "native-pair"] as const) test(`activated predecessor ${mode} change refuses prepare/dispatch/ACK`, async () => {
  const f = await queuePair(), created = await completeCreate(f), claim = await store.claim(f.update.operationId, randomUUID()); assert(claim); const saved = (await store.prepare(claim)).saved;
  if (mode === "scope") await pool.query("UPDATE reference_connections SET scope='https://www.googleapis.com/auth/tasks.readonly' WHERE id=$1", [f.connectionId]);
  if (mode === "source-ABA") { await pool.query("UPDATE reference_task_bindings SET active=false WHERE id=$1", [f.bindingId]); await pool.query("UPDATE reference_task_bindings SET active=true WHERE id=$1", [f.bindingId]); }
  if (mode === "connection-ABA") { await pool.query("UPDATE reference_connections SET status='retired' WHERE id=$1", [f.connectionId]); await pool.query("UPDATE reference_connections SET status='active' WHERE id=$1", [f.connectionId]); }
  if (mode === "privacy-ABA") { await pool.query("UPDATE reference_task_objects SET privacy_label='changed' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_task_objects SET privacy_label='private' WHERE id=$1", [f.objectId]); }
  if (mode === "native-pair") await pool.query("UPDATE reference_task_bindings SET etag='\"inbound\"',baseline=$2 WHERE id=$1", [f.bindingId, { ...projection, notes: "Inbound actor" }]);
  await assert.rejects(store.prepare(claim)); await assert.rejects(store.markDispatch(claim)); const read = present(created.taskId, '"updated"', updatedProjection);
  assert.equal(await store.completeUpdate(claim, { validator: read.etag, projection: updatedProjection, read, saved }), false); assert.equal((await op(claim.operationId)).dispatch_possible, false);
});
test("current mutable mapping cannot stand in for missing owned CREATE completion evidence", async () => {
  const f = await queuePair(); await pool.query("UPDATE reference_task_bindings SET task_id='unproven',etag='\"unproven\"',baseline=$2,destination_lifecycle='present' WHERE id=$1", [f.bindingId, projection]); await pool.query("UPDATE reference_task_operations SET status='acked' WHERE id=$1", [f.operationId]);
  await assert.rejects(store.claim(f.update.operationId, randomUUID())); assert.equal(await op(f.update.operationId), undefined); assert.equal(Number((await canonical(f.objectId)).revision), 2);
});
for (const mode of ["cancel", "credential", "source-ABA"] as const) test(`activation ${mode} while waiting for binding authority cannot materialize canonical intent`, async () => {
  const f = await queuePair(); await completeCreate(f); const lock = await pool.connect(), controller = new AbortController(), reason = new Error("Cancel waiting intent activation"), before = await intent(f.update.operationId);
  try {
    if (mode === "credential") await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.connectionId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    const claim = store.claim(f.update.operationId, randomUUID(), mode === "cancel" ? controller.signal : undefined), rejected = mode === "cancel" ? assert.rejects(claim, (error: unknown) => error === reason) : assert.rejects(claim);
    let waited = false; for (let n = 0; n < 200; n++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_bindings%FOR UPDATE%') AS waiting")).rows[0].waiting) { waited = true; break; } await pause(10); } assert(waited);
    if (mode === "cancel") controller.abort(reason);
    if (mode === "credential") while (!(await pool.query("SELECT expires_at<clock_timestamp() AS expired FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0].expired) await pause(10);
    if (mode === "source-ABA") { await lock.query("UPDATE reference_task_bindings SET active=false WHERE id=$1", [f.bindingId]); await lock.query("UPDATE reference_task_bindings SET active=true WHERE id=$1", [f.bindingId]); }
    await lock.query("COMMIT"); await rejected; assert.equal(await op(f.update.operationId), undefined); assert.equal(Number((await canonical(f.objectId)).revision), 2); assert.deepEqual(await intent(f.update.operationId), before); assert.equal((await canonical(f.objectId)).canonical_lifecycle, "active");
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
for (const mode of ["cancel", "lease", "credential"] as const) test(`deferred ACK ${mode} after authority-lock wait preserves original resolution and mapping`, async () => {
  const f = await queuePair(), created = await completeCreate(f), claim = await store.claim(f.update.operationId, randomUUID()); assert(claim); const prepared = await store.prepare(claim), read = present(created.taskId, '"updated"', updatedProjection);
  await store.markDispatch(claim); await store.recordEvidence(claim, { provider: { kind: "accepted", validator: read.etag }, acceptedStatus: 200, possibleDispatch: true, remote: { kind: "confirmed", observationId: randomUUID(), read, projection: updatedProjection } });
  const before = await op(claim.operationId), lock = await pool.connect(), controller = new AbortController(), reason = new Error("Deferred ACK cancellation");
  try {
    if (mode === "lease") await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [claim.operationId]);
    if (mode === "credential") await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.connectionId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    const promise = store.completeUpdate(claim, { validator: read.etag, projection: updatedProjection, read, saved: prepared.saved }, mode === "cancel" ? controller.signal : undefined), rejected = mode === "cancel" ? assert.rejects(promise, error => error === reason) : undefined;
    let waited = false; for (let n = 0; n < 200; n++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_bindings%FOR UPDATE%') AS waiting")).rows[0].waiting) { waited = true; break; } await pause(10); } assert(waited);
    if (mode === "cancel") controller.abort(reason); else while (!(await pool.query(mode === "lease" ? "SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1" : "SELECT expires_at<clock_timestamp() AS expired FROM reference_connections WHERE id=$1", [mode === "lease" ? claim.operationId : f.connectionId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); if (mode === "cancel") await rejected; else assert.equal(await promise, false); const after = await op(claim.operationId); assert.equal(after.status, "running"); assert.deepEqual(after.resolution_basis, before.resolution_basis); assert.equal(after.completion_evidence, null); assert.equal((await store.inspectCreateOperation(f.operationId)).binding.etag, '"created"');
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("waiting and active deferred intents plus old histories survive populated whole-chain migration reruns", async () => {
  const waiting = await queuePair(), active = await queuePair(); await completeCreate(active); const claim = await store.claim(active.update.operationId, randomUUID()); assert(claim);
  const before = await oldRows(), intentsBefore = (await pool.query("SELECT * FROM reference_task_intents ORDER BY id")).rows, ids = await oids(); await events.migrate(); await events.migrate(); assert.deepEqual(await oldRows(), before); assert.deepEqual((await pool.query("SELECT * FROM reference_task_intents ORDER BY id")).rows, intentsBefore); assert.deepEqual(await oids(), ids); assert.equal(await op(waiting.update.operationId), undefined);
});
