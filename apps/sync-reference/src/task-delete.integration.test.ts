import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import { REFERENCE_TASK_UPDATE_PROFILE } from "./task-admission.js";
import type { ReferenceTaskContent } from "./task-model.js";
import type { ReferenceTaskDeleteClaim } from "./task-delete-model.js";
import type { RuntimeTaskDeleteNativeFacts } from "@musubi/sync-runtime";
const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); if (!adminUrl) throw new Error("Explicit disposable DB required");
const name = referenceTestDatabaseName("reference_task_delete_"), url = new URL(adminUrl); url.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: url.href, max: 6 }), key = "ab".repeat(32), events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key);
const content: ReferenceTaskContent = { name: "Independent task", notes: null, state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const baseline = { title: content.name, notes: null, due: "2026-10-26T00:00:00.000Z", status: "needsAction" as const }, scope = "https://www.googleapis.com/auth/tasks";
async function fixture() {
  const id = randomUUID(), ids = { connectionId: `delete-connection:${id}`, objectId: `delete-object:${id}`, bindingId: `delete-binding:${id}`, taskListId: `native-list/${id}?`, taskId: `native-task/${id}?` };
  await store.seedBinding({ ...ids, provider: "google", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, accessToken: "synthetic-task-delete-token", scope, expiresAt: "2099-01-01T00:00:00.000Z", content, baseline, etag: '"original"' });
  return { ...ids, input: { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: randomUUID() } };
}
async function claimed() { const f = await fixture(); await store.admitDelete(f.input); const claim = await store.claimDelete(f.input.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
const show = (claim: ReferenceTaskDeleteClaim) => store.inspectDeleteOperation(claim.operationId);
const absence = { kind: "exact-absence" as const, source: "readback" as const, read: { kind: "absent" as const, status: 404 as const } };
function facts(provider: RuntimeTaskDeleteNativeFacts["provider"], fields: Partial<RuntimeTaskDeleteNativeFacts> = {}): RuntimeTaskDeleteNativeFacts {
  return { provider, possibleDispatch: provider.kind !== "not-dispatched", remote: { kind: "unobserved" }, ...fields };
}
const observed = (provider: RuntimeTaskDeleteNativeFacts["provider"], fields: Partial<RuntimeTaskDeleteNativeFacts> = {}): RuntimeTaskDeleteNativeFacts => facts(provider, { remote: { kind: "absent", source: "readback", observationId: randomUUID(), read: { kind: "absent", status: 404 } }, ...fields });
async function fulfilled(claim: ReferenceTaskDeleteClaim, acceptedStatus: 204 | 226 = 204) { await store.markDeleteDispatch(claim); await store.recordDeleteEvidence(claim, observed({ kind: "accepted", validator: null }, { acceptedStatus })); }
const tables = ["reference_connections", "reference_objects", "reference_bindings", "reference_operations", "reference_attempts", "reference_task_objects", "reference_task_bindings", "reference_task_operations", "reference_task_attempts"];
const newTaskColumns = ["delete_accepted_baseline", "delete_acceptance_status", "delete_response_absence_status", "destination_lifecycle", "create_operation_id", "create_profile", "create_candidate_id", "create_candidate_validator", "create_acceptance_status", "predecessor_operation_id", "queued_intent_id", "resolution_basis", "completion_evidence"];
async function rows(legacy = false) { const all: Record<string, unknown> = {}; for (const table of tables) all[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows.map(value => legacy && table.startsWith("reference_task_") ? Object.fromEntries(Object.entries(value).filter(([key]) => !newTaskColumns.includes(key))) : value); return all; }
const oids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relname LIKE 'reference_%' AND relname NOT LIKE 'reference_task_intents%' AND relkind IN ('r','i') ORDER BY relname")).rows;
let oldRows: unknown, oldOids: unknown; let oldTask: { claim: Awaited<ReturnType<typeof store.claim>>; taskId: string };
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const file of ["schema.sql", "schema-delete.sql", "schema-create.sql", "schema-graph-delete.sql", "schema-caldav-delete.sql", "schema-graph-create.sql", "schema-caldav-create.sql", "schema-google-task-update.sql"]) await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const eventContent = { name: "Old event", notes: null, place: "Room", beginsAt: "2026-10-26T08:00:00.000Z", endsAt: "2026-10-26T09:00:00.000Z" };
  for (const family of ["google-update", "google-delete", "google-create", "microsoft-delete", "microsoft-create", "caldav-delete", "caldav-create"]) {
    const id = randomUUID(), base = { connectionId: `old-c:${id}`, objectId: `old-o:${id}`, bindingId: `old-b:${id}`, calendarId: `old-calendar:${id}`, accessToken: "synthetic-old-token", scope: "https://www.googleapis.com/auth/calendar.events", expiresAt: "2099-01-01T00:00:00.000Z", content: eventContent }, input = { bindingId: base.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id };
    if (family === "google-update" || family === "google-delete") { await events.seedBinding({ ...base, eventId: `old-native:${id}`, etag: '"old"' }); if (family === "google-update") await events.admitUpdate({ ...input, patch: { name: "Old pending title" } }); else await events.admitDelete(input); }
    else if (family === "google-create") { await events.seedCreateBinding({ ...base, operationId: id }); await events.admitCreate(input); }
    else if (family === "microsoft-delete") { await events.seedGraphDeleteBinding({ ...base, provider: "microsoft", endpointProfile: "microsoft-personal-event-delete-v1", scope: "Calendars.ReadWrite", eventId: `old-graph:${id}`, etag: 'W/"old"' }); await events.admitGraphDelete(input); }
    else if (family === "microsoft-create") { await events.seedGraphCreateBinding({ ...base, provider: "microsoft", endpointProfile: "microsoft-personal-event-create-v1", scope: "Calendars.ReadWrite", operationId: id }); await events.admitGraphCreate(input); }
    else {
      const dav = { provider: "caldav" as const, connectionId: base.connectionId, objectId: base.objectId, bindingId: base.bindingId, calendarUrl: `https://dav.example.test/${id}/`, username: "owned", password: "synthetic-dav", expiresAt: base.expiresAt, content: eventContent };
      if (family === "caldav-delete") { await events.seedCaldavDeleteBinding({ ...dav, endpointProfile: "caldav-personal-event-delete-v1", resourceUrl: dav.calendarUrl + "native.ics", uid: `uid:${id}`, etag: '"old"' }); await events.admitCaldavDelete(input); }
      else { await events.seedCaldavCreateBinding({ ...dav, endpointProfile: "caldav-personal-event-create-v1", operationId: id }); await events.admitCaldavCreate(input); }
    }
    const claim = await events.claim(id, randomUUID()); assert(claim); await events.markDispatch(claim);
    if (family === "microsoft-create") await events.recordGraphCreateEvidence(claim, { provider: "accepted", candidateEventId: `assigned:${id}`, createAcceptance: { status: 201, validator: "raw-native-version" }, remote: "unobserved" });
    else if (family === "caldav-create") await events.recordCaldavCreateEvidence(claim, { provider: "accepted", createAcceptanceStatus: 201, remote: "unobserved" });
    else await events.recordEvidence(claim, { provider: "uncertain", remote: "unobserved" });
  }
  const f = await fixture(); await store.admitUpdate({ ...f.input, patch: { name: "Old pending Task title" } }); const claim = await store.claim(f.input.operationId, randomUUID()); assert(claim); await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider: { kind: "accepted", validator: '"old-task-written"' }, acceptedStatus: 200, possibleDispatch: true, remote: { kind: "confirmed", observationId: randomUUID(), read: { kind: "present", task: { id: f.taskId, ...claim.saved.projection, etag: '"old-task-written"' }, etag: '"old-task-written"' }, projection: claim.saved.projection } }); oldTask = { claim, taskId: f.taskId };
  oldRows = await rows(); oldOids = await oids(); await events.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("additive DELETE migration preserves eight old profiles, complete rows/epochs/receipts/history and28OIDs", async () => {
  assert.equal((oldOids as unknown[]).length, 28); await events.migrate(); await events.migrate(); assert.deepEqual(await rows(true), oldRows); assert.deepEqual(await oids(), oldOids);
  const claim = oldTask.claim!; const task = { id: oldTask.taskId, ...claim.saved.projection, etag: '"old-task-written"' };
  assert.equal(await store.completeUpdate(claim, { validator: task.etag, projection: claim.saved.projection, read: { kind: "present", task, etag: task.etag }, saved: claim.saved }), true);
});
test("DELETE admission tombstones only canonical lifecycle and captures real null-body task envelope", async () => {
  const f = await claimed(), op = await show(f.claim), raw = (await pool.query("SELECT * FROM reference_task_operations WHERE id=$1", [f.claim.operationId])).rows[0];
  assert.deepEqual(op.canonical.content, content); assert.equal(op.canonical.lifecycle, "tombstoned"); assert.equal(op.canonical.revision, 2); assert.equal(op.canonical.generation, 2); assert.equal(op.capture.sourceGeneration, 1);
  assert.equal(raw.saved_projection, null); assert.equal(raw.field_mask, null); assert.deepEqual(raw.delete_accepted_baseline, baseline); assert.equal(raw.payload.operationEnvelope.nativePlan.data.body, null); assert.equal(raw.native_acceptance_status, null);
  for (const sql of ["delete_accepted_baseline='{}'::jsonb", "payload='{}'::jsonb", "task_id='other'", "action='update'", "accepted_etag='\"other\"'"]) await assert.rejects(pool.query(`UPDATE reference_task_operations SET ${sql} WHERE id=$1`, [f.claim.operationId]), /immutable/);
});
test("DELETE canonical CAS/idempotency/pending barrier roll back together", async () => {
  const f = await fixture(); await assert.rejects(store.admitDelete({ ...f.input, expectedRevision: 2 }), /revision-conflict/);
  const results = await Promise.allSettled([store.admitDelete(f.input), store.admitDelete({ ...f.input, commandId: randomUUID(), operationId: randomUUID() })]); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.deepEqual(await store.admitDelete(f.input), await store.inspectDeleteOperation(f.input.operationId)); await assert.rejects(store.admitDelete({ ...f.input, expectedRevision: 2 }), /command-reused/);
  const pending = await fixture(); await store.admitUpdate({ ...pending.input, patch: { name: "Pending UPDATE" } }); await assert.rejects(store.admitDelete({ ...pending.input, expectedRevision: 2, operationId: randomUUID(), commandId: randomUUID() }), /causal-barrier/);
  assert.equal((await pool.query("SELECT canonical_lifecycle FROM reference_task_objects WHERE id=$1", [pending.objectId])).rows[0].canonical_lifecycle, "active");
});
test("fresh GET404/410 confirms without dispatch, response sidecars or invented acceptance", async () => {
  for (const status of [404, 410] as const) {
    const f = await claimed(); await store.recordDeleteEvidence(f.claim, observed({ kind: "not-dispatched" })); assert.equal(await store.completeDelete(f.claim, { kind: "exact-absence", source: "initial-read", read: { kind: "absent", status } }), true);
    const op = await show(f.claim); assert.equal(op.receipt.provider.kind, "not-dispatched"); assert.equal(op.dispatchPossible, false); assert.deepEqual(op.deleteResponse, { acceptedStatus: null, responseAbsenceStatus: null });
    assert.equal(op.binding.destinationLifecycle, "absent"); assert.equal(op.binding.active, true); assert.equal(op.binding.sourceGeneration, 1); assert.equal(op.binding.etag, '"original"'); assert.deepEqual(op.binding.baseline, baseline);
  }
});
test("actual DELETE2xx and DELETE404/410 response facts remain separate and require later scoped GET", async () => {
  for (const status of [202, 204, 226, 404, 410] as const) {
    const f = await claimed(); await store.markDeleteDispatch(f.claim);
    await store.recordDeleteEvidence(f.claim, facts({ kind: "accepted", validator: null }, status < 300 ? { acceptedStatus: status as 202 | 204 | 226 } : { responseAbsenceStatus: status as 404 | 410 }));
    await assert.rejects(store.completeDelete(f.claim, absence), /confirmation-missing/);
    const next = status < 300 ? { acceptedStatus: status as 202 | 204 | 226 } : { responseAbsenceStatus: status as 404 | 410 };
    await store.recordDeleteEvidence(f.claim, observed({ kind: "accepted", validator: null }, next)); assert.equal(await store.completeDelete(f.claim, absence), true);
    const op = await show(f.claim); assert.equal(op.deleteResponse.acceptedStatus, status < 300 ? status : null); assert.equal(op.deleteResponse.responseAbsenceStatus, status >= 400 ? status : null); assert.equal(op.receipt.provider.kind, "accepted");
  }
});
test("earlier2xx remains sticky across later absence response and failed observation", async () => {
  const f = await claimed(); await store.markDeleteDispatch(f.claim); await store.recordDeleteEvidence(f.claim, facts({ kind: "accepted", validator: null }, { acceptedStatus: 204 }));
  await store.recordDeleteEvidence(f.claim, facts({ kind: "accepted", validator: null }, { responseAbsenceStatus: 404 }));
  await store.recordDeleteEvidence(f.claim, facts({ kind: "uncertain" })); assert.deepEqual((await show(f.claim)).deleteResponse, { acceptedStatus: 204, responseAbsenceStatus: 404 }); assert.equal((await show(f.claim)).receipt.provider.kind, "accepted");
});
test("successful2xx OR DELETE404/410 response makes reference mutation recovery observe-only", async () => {
  for (const sidecar of [{ acceptedStatus: 204 as const }, { responseAbsenceStatus: 410 as const }]) {
    const f = await claimed(); await store.markDeleteDispatch(f.claim); await store.recordDeleteEvidence(f.claim, facts({ kind: "accepted", validator: null }, sidecar)); await assert.rejects(store.markDeleteDispatch(f.claim), /observe-only/);
  }
});
test("unknown response may retry original binding and survive known rejection; rejected fresh attempt can become unknown", async () => {
  const f = await claimed(); await store.markDeleteDispatch(f.claim); await store.recordDeleteEvidence(f.claim, facts({ kind: "uncertain" })); await store.markDeleteDispatch(f.claim);
  await store.recordDeleteEvidence(f.claim, facts({ kind: "rejected", error: { code: "rate-limited", retry: "after-delay" } })); assert.equal((await show(f.claim)).receipt.provider.kind, "uncertain");
  const g = await claimed(); await store.markDeleteDispatch(g.claim); await store.recordDeleteEvidence(g.claim, facts({ kind: "rejected", error: { code: "rate-limited", retry: "after-delay" } })); await store.markDeleteDispatch(g.claim); await store.recordDeleteEvidence(g.claim, facts({ kind: "uncertain" })); assert.equal((await show(g.claim)).receipt.provider.kind, "uncertain");
});
test("absence ACK after unknown/rejected dispatch never fabricates HTTP acceptance", async () => {
  for (const kind of ["uncertain", "rejected"] as const) {
    const f = await claimed(); await store.markDeleteDispatch(f.claim); const provider = kind === "uncertain" ? { kind } : { kind, error: { code: "rate-limited" as const, retry: "after-delay" as const } };
    await store.recordDeleteEvidence(f.claim, observed(provider)); assert.equal(await store.completeDelete(f.claim, absence), true); assert.equal((await show(f.claim)).receipt.provider.kind, kind); assert.deepEqual((await show(f.claim)).deleteResponse, { acceptedStatus: null, responseAbsenceStatus: null });
  }
});
test("UPDATE evidence/claim ports cannot be repurposed for DELETE or widen UPDATE status constraints", async () => {
  const f = await claimed(); await assert.rejects(store.claim(f.claim.operationId, randomUUID()), /action-port-required/);
  await assert.rejects(store.recordEvidence(f.claim as any, { provider: { kind: "accepted", validator: null }, acceptedStatus: 204, possibleDispatch: false, remote: { kind: "unobserved" } }), /update-evidence-port-required/);
  await assert.rejects(pool.query("UPDATE reference_task_operations SET native_acceptance_status=204 WHERE id=$1", [f.claim.operationId]), /check constraint/);
});
test("exact absence source/status is validated and no content/deleted flag can substitute for GET absence", async () => {
  const f = await claimed(); await fulfilled(f.claim);
  for (const value of [{ kind: "provider-response", status: 204 }, { ...absence, source: "delete-response" }, { ...absence, read: { kind: "absent", status: 403 } }, { ...absence, read: { kind: "present", task: { deleted: true } } }]) await assert.rejects(store.completeDelete(f.claim, value as any), /Invalid reference task input|invalid-task-delete-absence/);
  assert.equal((await show(f.claim)).binding.destinationLifecycle, "present");
});
test("credential/source/privacy/lifecycle changes refuse ACK and retain actual response fact", async () => {
  for (const kind of ["scope", "connection", "binding", "privacy", "canonical"]) {
    const f = await claimed(); await fulfilled(f.claim);
    if (kind === "scope") await pool.query("UPDATE reference_connections SET scope='https://www.googleapis.com/auth/calendar.events' WHERE id=$1", [f.connectionId]);
    if (kind === "connection") { await pool.query("UPDATE reference_connections SET status='retired' WHERE id=$1", [f.connectionId]); await pool.query("UPDATE reference_connections SET status='active' WHERE id=$1", [f.connectionId]); }
    if (kind === "binding") { await pool.query("UPDATE reference_task_bindings SET active=false WHERE id=$1", [f.bindingId]); await pool.query("UPDATE reference_task_bindings SET active=true WHERE id=$1", [f.bindingId]); }
    if (kind === "privacy") { await pool.query("UPDATE reference_task_objects SET privacy_label='other' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_task_objects SET privacy_label='private' WHERE id=$1", [f.objectId]); }
    if (kind === "canonical") await pool.query("UPDATE reference_task_objects SET canonical_lifecycle='active' WHERE id=$1", [f.objectId]);
    assert.equal(await store.completeDelete(f.claim, absence), false); const op = await show(f.claim); assert.equal(op.binding.destinationLifecycle, "present"); assert.equal(op.deleteResponse.acceptedStatus, 204);
  }
});
test("stale attempt cannot change response facts or ACK a later owner's claim", async () => {
  const f = await claimed(); await fulfilled(f.claim); await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.claim.operationId]); const next = await store.claimDelete(f.claim.operationId, randomUUID()); assert(next);
  assert.equal(next.deleteResponse.acceptedStatus, 204); assert.equal(await store.recordDeleteEvidence(f.claim, observed({ kind: "accepted", validator: null }, { responseAbsenceStatus: 410 })), false); assert.equal(await store.completeDelete(f.claim, absence), false); assert.equal((await show(f.claim)).leaseAttemptId, next.attemptId);
});
for (const kind of ["cancel", "lease", "credential", "snapshot"] as const) test(`absence ACK ${kind} while waiting for binding lock preserves atomicity`, async () => {
  const f = await claimed(); await fulfilled(f.claim); const lock = await pool.connect(), controller = new AbortController(), reason = new Error("Synthetic DELETE ACK cancellation"), mutable = structuredClone(f.claim), input = structuredClone(absence);
  try {
    if (kind === "lease") await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.claim.operationId]);
    if (kind === "credential") await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.connectionId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    const promise = store.completeDelete(mutable, input, kind === "cancel" ? controller.signal : undefined), rejected = kind === "cancel" ? assert.rejects(promise, error => error === reason) : undefined;
    let waited = false; for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_bindings%FOR UPDATE%') AS waiting")).rows[0].waiting) { waited = true; break; } await pause(10); } assert(waited);
    if (kind === "cancel") controller.abort(reason);
    if (kind === "snapshot") { (mutable as { operationId: string }).operationId = "caller-mutated"; (input.read as { status: number }).status = 403; }
    if (kind === "lease" || kind === "credential") while (!(await pool.query(kind === "lease" ? "SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1" : "SELECT expires_at<clock_timestamp() AS expired FROM reference_connections WHERE id=$1", [kind === "lease" ? f.claim.operationId : f.connectionId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); if (kind === "cancel") await rejected; else assert.equal(await promise, kind === "snapshot"); const op = await show(f.claim); assert.equal(op.binding.destinationLifecycle, kind === "snapshot" ? "absent" : "present"); assert.equal(op.binding.sourceGeneration, 1); assert.equal(op.binding.active, true);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
for (const kind of ["dispatch", "evidence", "finish"] as const) test(`DELETE ${kind} after an expired attempt-row wait rolls back all provisional writes`, async () => {
  const f = await claimed(); if (kind === "evidence") await store.markDeleteDispatch(f.claim); const initial = await show(f.claim), lock = await pool.connect();
  try {
    await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.claim.operationId]); await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_attempts WHERE id=$1 FOR UPDATE", [f.claim.attemptId]);
    const promise = kind === "dispatch" ? store.markDeleteDispatch(f.claim) : kind === "evidence" ? store.recordDeleteEvidence(f.claim, facts({ kind: "accepted", validator: null }, { acceptedStatus: 204 })) : store.finish(f.claim, "hold", { code: "synthetic-delete-finish" });
    let waited = false; for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_attempts%') AS waiting")).rows[0].waiting) { waited = true; break; } await pause(10); } assert(waited);
    while (!(await pool.query("SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1", [f.claim.operationId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); assert.equal(await promise, false); const op = await show(f.claim); assert.equal(op.status, "running"); assert.equal(op.dispatchPossible, initial.dispatchPossible); assert.deepEqual(op.receipt, initial.receipt); assert.deepEqual(op.deleteResponse, initial.deleteResponse);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("populated DELETE sidecars/absence plus eight prior profiles survive repeated full migration without resurrection", async () => {
  const f = await claimed(); await fulfilled(f.claim); assert.equal(await store.completeDelete(f.claim, absence), true);
  const before = await rows(), ids = await oids(); await events.migrate(); await events.migrate(); assert.deepEqual(await rows(), before); assert.deepEqual(await oids(), ids);
  await assert.rejects(store.admitUpdate({ bindingId: f.bindingId, commandId: randomUUID(), operationId: randomUUID(), expectedRevision: 2, patch: { name: "No resurrection" } }), /source-unavailable/);
});
