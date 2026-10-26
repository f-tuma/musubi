import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import type { RuntimeTaskCreateNativeFacts } from "@musubi/sync-runtime";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import { REFERENCE_TASK_CREATE_PROFILE } from "./task-create-admission.js";
import type { ReferenceTaskCreateClaim, ReferenceTaskCreateObservation } from "./task-create-model.js";
import type { ReferenceTaskContent } from "./task-model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); if (!adminUrl) throw new Error("Explicit disposable DB required");
const name = `reference_task_create_${randomUUID().replaceAll("-", "")}`, url = new URL(adminUrl); url.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: url.href, max: 6 }), key = "ac".repeat(32), events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key);
const content: ReferenceTaskContent = { name: "Independent created task", notes: null, state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const projection = { title: content.name, notes: null, due: "2026-10-26T00:00:00.000Z", status: "needsAction" as const }, scope = "https://www.googleapis.com/auth/tasks";
async function fixture() {
  const id = randomUUID(), ids = { connectionId: `create-connection:${id}`, objectId: `create-object:${id}`, bindingId: `create-binding:${id}`, taskListId: `native-list/${id}?`, operationId: id };
  await store.seedCreateBinding({ ...ids, provider: "google", endpointProfile: REFERENCE_TASK_CREATE_PROFILE, accessToken: "synthetic-task-create-token", scope, expiresAt: "2099-01-01T00:00:00.000Z", content });
  return { ...ids, input: { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id } };
}
async function claimed() { const f = await fixture(); await store.admitCreate(f.input); const claim = await store.claimCreate(f.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
const show = (claim: ReferenceTaskCreateClaim) => store.inspectCreateOperation(claim.operationId);
const facts = (fields: Partial<RuntimeTaskCreateNativeFacts> = {}): RuntimeTaskCreateNativeFacts => ({ provider: { kind: "accepted", validator: null }, acceptedStatus: 200, possibleDispatch: true, remote: { kind: "unobserved" }, ...fields });
function observation(taskId = "assigned/native?", etag = '"readback"'): ReferenceTaskCreateObservation {
  return { kind: "exact-readback", taskId, validator: etag, projection, read: { kind: "present", etag, task: { id: taskId, etag, ...projection } } };
}
async function confirmed(claim: ReferenceTaskCreateClaim, candidateValidator: string | null = '"response"') {
  const observed = observation(); await store.markCreateDispatch(claim);
  await store.recordCreateEvidence(claim, facts({ responseAddress: { taskId: observed.taskId, validator: candidateValidator }, remote: { kind: "confirmed", observationId: randomUUID(), read: observed.read, projection } }));
  return observed;
}
const tables = ["reference_connections", "reference_objects", "reference_bindings", "reference_operations", "reference_attempts", "reference_task_objects", "reference_task_bindings", "reference_task_operations", "reference_task_attempts"];
const newColumns = ["create_operation_id", "create_profile", "create_candidate_id", "create_candidate_validator", "create_acceptance_status"];
async function rows(legacy = false) { const result: Record<string, unknown> = {}; for (const table of tables) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows.map(row => legacy && table.startsWith("reference_task_") ? Object.fromEntries(Object.entries(row).filter(([key]) => !newColumns.includes(key))) : row); return result; }
const oids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relname LIKE 'reference_%' AND relkind IN ('r','i') ORDER BY relname")).rows;
let oldRows: unknown, oldOids: unknown;
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const file of ["schema.sql", "schema-delete.sql", "schema-create.sql", "schema-graph-delete.sql", "schema-caldav-delete.sql", "schema-graph-create.sql", "schema-caldav-create.sql", "schema-google-task-update.sql", "schema-google-task-delete.sql"]) await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
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
  for (const action of ["update", "delete"] as const) {
    const id = randomUUID(), bindingId = `old-task-b:${id}`;
    await store.seedBinding({ provider: "google", endpointProfile: "google-task-update-v1", connectionId: `old-task-c:${id}`, objectId: `old-task-o:${id}`, bindingId, taskListId: `old-list:${id}`, taskId: `old-task:${id}`, accessToken: "old-task-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content, baseline: projection, etag: '"old"' });
    const input = { bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id };
    if (action === "update") { await store.admitUpdate({ ...input, patch: { name: "Old Task UPDATE" } }); const claim = await store.claim(id, randomUUID()); assert(claim); await store.markDispatch(claim); await store.recordEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 200, possibleDispatch: true, remote: { kind: "unobserved" } }); }
    else { await store.admitDelete(input); const claim = await store.claimDelete(id, randomUUID()); assert(claim); await store.markDeleteDispatch(claim); await store.recordDeleteEvidence(claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 226, responseAbsenceStatus: 410, possibleDispatch: true, remote: { kind: "unobserved" } }); }
  }
  oldRows = await rows(); oldOids = await oids(); await events.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("CREATE migration retains all nine populated profiles, history/sidecars/epochs and28OIDs", async () => {
  assert.equal((oldOids as unknown[]).length, 28); await events.migrate(); await events.migrate(); assert.deepEqual(await rows(true), oldRows); assert.deepEqual(await oids(), oldOids);
});
test("reservation and admitted CREATE have null native identity, validator, baseline and UPDATE mask", async () => {
  const f = await claimed(), op = await show(f.claim), raw = (await pool.query("SELECT * FROM reference_task_operations WHERE id=$1", [f.operationId])).rows[0];
  assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.binding.taskId, null); assert.equal(op.binding.etag, null); assert.equal(op.binding.baseline, null); assert.equal(op.binding.sourceGeneration, 1);
  assert.deepEqual(op.canonical.content, content); assert.equal(op.canonical.revision, 2); assert.equal(op.canonical.generation, 1);
  for (const key of ["task_id", "accepted_etag", "saved_projection", "field_mask", "delete_accepted_baseline", "native_acceptance_status", "delete_acceptance_status"]) assert.equal(raw[key], null);
  assert.equal(raw.payload.operationEnvelope.locator.resourceId, null); assert.deepEqual(raw.payload.operationEnvelope.nativePlan.data.body, projection);
  for (const sql of ["task_id='forged'", "accepted_etag='\"forged\"'", "payload='{}'::jsonb", "delete_accepted_baseline='{}'::jsonb"]) await assert.rejects(pool.query(`UPDATE reference_task_operations SET ${sql} WHERE id=$1`, [f.operationId]), /immutable/);
  await assert.rejects(pool.query("UPDATE reference_task_bindings SET create_operation_id=$2 WHERE id=$1", [f.bindingId, randomUUID()]), /immutable/);
});
test("CREATE CAS/idempotency/reservation and causal barriers are atomic", async () => {
  const f = await fixture(); await assert.rejects(store.admitCreate({ ...f.input, expectedRevision: 2 }), /revision-conflict/); await assert.rejects(store.admitCreate({ ...f.input, operationId: randomUUID() }), /reservation-unavailable/);
  const [a, b] = await Promise.all([store.admitCreate(f.input), store.admitCreate(f.input)]); assert.deepEqual(a, b);
  await assert.rejects(store.admitCreate({ ...f.input, expectedRevision: 2 }), /command-reused/);
  await assert.rejects(store.admitUpdate({ ...f.input, commandId: randomUUID(), operationId: randomUUID(), expectedRevision: 2, patch: { name: "No address" } }), /source-unavailable/);
  await assert.rejects(store.admitDelete({ ...f.input, commandId: randomUUID(), operationId: randomUUID(), expectedRevision: 2 }), /source-unavailable/);
});
test("raw accepted status survives without JSON/address; dispatch never repeats", async () => {
  const f = await claimed(); await store.markCreateDispatch(f.claim); await store.recordCreateEvidence(f.claim, facts());
  assert.deepEqual((await show(f.claim)).createResponse, { acceptedStatus: 200, responseAddress: null }); await assert.rejects(store.completeCreate(f.claim, observation()), /observation-conflict/); await assert.rejects(store.markCreateDispatch(f.claim), /observe-only/);
});
test("early candidate with unusable response validator can adopt only a fresh full-target tagged GET", async () => {
  const f = await claimed(), observed = await confirmed(f.claim, null); assert.equal(await store.completeCreate(f.claim, observed), true);
  const op = await show(f.claim); assert.equal(op.binding.taskId, observed.taskId); assert.equal(op.binding.etag, observed.validator); assert.deepEqual(op.binding.baseline, projection); assert.equal(op.binding.sourceGeneration, 2); assert.equal(op.binding.active, true); assert.equal(op.binding.destinationLifecycle, "present");
  assert.deepEqual(op.canonical.content, content); assert.equal((op.payload as any).operationEnvelope.locator.resourceId, null); assert.equal((await pool.query("SELECT task_id FROM reference_task_operations WHERE id=$1", [f.operationId])).rows[0].task_id, null); assert.equal(await store.completeCreate(f.claim, observed), false);
});
test("candidate/status monotonicity and family isolation refuse invented facts", async () => {
  const f = await claimed(); await assert.rejects(store.recordCreateEvidence(f.claim, facts()), /dispatch-evidence-missing/); await confirmed(f.claim);
  await assert.rejects(store.recordCreateEvidence(f.claim, facts({ acceptedStatus: 201 })), /acceptance-conflict/); await assert.rejects(store.recordCreateEvidence(f.claim, facts({ responseAddress: { taskId: "another", validator: null } })), /candidate-conflict/);
  await assert.rejects(store.claim(f.operationId, randomUUID()), /action-port-required/); await assert.rejects(store.claimDelete(f.operationId, randomUUID()), /action-port-required/);
  await assert.rejects(pool.query("UPDATE reference_task_operations SET create_candidate_id='another' WHERE id=$1", [f.operationId]), /immutable/); await assert.rejects(pool.query("UPDATE reference_task_operations SET native_acceptance_status=200 WHERE id=$1", [f.operationId]), /check constraint/);
});
test("stale original dispatch may append actual response facts but cannot observe/adopt/ACK", async () => {
  const f = await claimed(); await store.markCreateDispatch(f.claim); await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.operationId]); const next = await store.claimCreate(f.operationId, randomUUID()); assert(next);
  const observed = observation(); assert.equal(await store.recordCreateEvidence(f.claim, facts({ responseAddress: { taskId: observed.taskId, validator: null }, remote: { kind: "confirmed", observationId: randomUUID(), read: observed.read, projection } })), false);
  const op = await show(f.claim); assert.equal(op.createResponse.acceptedStatus, 200); assert.equal(op.createResponse.responseAddress?.taskId, observed.taskId); assert.equal(op.receipt.remote.kind, "unobserved"); assert.equal(op.leaseAttemptId, next.attemptId); assert.equal(await store.completeCreate(f.claim, observed), false);
  await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.operationId]); const recovered = await store.claimCreate(f.operationId, randomUUID()); assert(recovered); assert.equal(recovered.createResponse.responseAddress?.taskId, observed.taskId); await assert.rejects(store.markCreateDispatch(recovered), /observe-only/);
});
test("serial successor admission pairs adopted address, real baseline/tag and new source epoch", async () => {
  const f = await claimed(), observed = await confirmed(f.claim); assert.equal(await store.completeCreate(f.claim, observed), true);
  const update = await store.admitUpdate({ bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "Successor" } });
  const envelope = (update.payload as any).operationEnvelope; assert.equal(envelope.locator.resourceId, observed.taskId); assert.equal(envelope.sourceEpoch.generation, 2); assert.equal(update.capture.sourceGeneration, 2); assert.equal(update.binding.etag, observed.validator); assert.deepEqual(update.saved.baseline, projection);
});
for (const kind of ["scope", "connection", "binding", "privacy", "canonical", "revision", "credential"] as const) test(`CREATE ${kind} authority change refuses adoption while preserving actual response`, async () => {
  const f = await claimed(), observed = await confirmed(f.claim);
  if (kind === "scope") await pool.query("UPDATE reference_connections SET scope='https://www.googleapis.com/auth/tasks.readonly' WHERE id=$1", [f.connectionId]);
  if (kind === "connection") { await pool.query("UPDATE reference_connections SET status='retired' WHERE id=$1", [f.connectionId]); await pool.query("UPDATE reference_connections SET status='active' WHERE id=$1", [f.connectionId]); }
  if (kind === "binding") { await pool.query("UPDATE reference_task_bindings SET active=false WHERE id=$1", [f.bindingId]); await pool.query("UPDATE reference_task_bindings SET active=true WHERE id=$1", [f.bindingId]); }
  if (kind === "privacy") { await pool.query("UPDATE reference_task_objects SET privacy_label='other' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_task_objects SET privacy_label='private' WHERE id=$1", [f.objectId]); }
  if (kind === "canonical") await pool.query("UPDATE reference_task_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [f.objectId]);
  if (kind === "revision") await pool.query("UPDATE reference_task_objects SET content=jsonb_set(content,'{name}','\"Changed\"') WHERE id=$1", [f.objectId]);
  if (kind === "credential") await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.connectionId]);
  assert.equal(await store.completeCreate(f.claim, observed), false); const op = await show(f.claim); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.createResponse.acceptedStatus, 200);
});
for (const kind of ["cancel", "lease", "credential", "snapshot"] as const) test(`CREATE ACK ${kind} after binding-lock wait preserves atomic adoption`, async () => {
  const f = await claimed(), observed = await confirmed(f.claim), lock = await pool.connect(), controller = new AbortController(), reason = new Error("Synthetic CREATE cancellation"), mutable = structuredClone(f.claim), input = structuredClone(observed);
  try {
    if (kind === "lease") await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.operationId]);
    if (kind === "credential") await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.connectionId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    const promise = store.completeCreate(mutable, input, kind === "cancel" ? controller.signal : undefined), rejected = kind === "cancel" ? assert.rejects(promise, error => error === reason) : undefined;
    let waited = false; for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_bindings%FOR UPDATE%') AS waiting")).rows[0].waiting) { waited = true; break; } await pause(10); } assert(waited);
    if (kind === "cancel") controller.abort(reason);
    if (kind === "snapshot") { (mutable as { operationId: string }).operationId = "caller-mutated"; (input as { taskId: string }).taskId = "caller-mutated"; }
    if (kind === "lease" || kind === "credential") while (!(await pool.query(kind === "lease" ? "SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1" : "SELECT expires_at<clock_timestamp() AS expired FROM reference_connections WHERE id=$1", [kind === "lease" ? f.operationId : f.connectionId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); if (kind === "cancel") await rejected; else assert.equal(await promise, kind === "snapshot"); const op = await show(f.claim); assert.equal(op.binding.destinationLifecycle, kind === "snapshot" ? "present" : "reserved"); assert.equal(op.binding.sourceGeneration, kind === "snapshot" ? 2 : 1);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("late DB-clock lease expiry while appending concrete response keeps facts without ACK authority", async () => {
  const f = await claimed(); await store.markCreateDispatch(f.claim); const lock = await pool.connect();
  try {
    await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.operationId]); await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_attempts WHERE id=$1 FOR UPDATE", [f.claim.attemptId]);
    const promise = store.recordCreateEvidence(f.claim, facts());
    let waited = false; for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_attempts%') AS waiting")).rows[0].waiting) { waited = true; break; } await pause(10); } assert(waited);
    while (!(await pool.query("SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1", [f.operationId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); assert.equal(await promise, false); const op = await show(f.claim); assert.equal(op.createResponse.acceptedStatus, 200); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.receipt.remote.kind, "unobserved");
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
for (const kind of ["lease", "credential", "cancel"] as const) test(`CREATE ${kind} after actual provisional mapping write rolls back mapping and ACK together`, async () => {
  const f = await claimed(), observed = await confirmed(f.claim), qaPool = new Pool({ connectionString: url.href, max: 1 }), connect = qaPool.connect.bind(qaPool), controller = new AbortController(), reason = new Error("Cancel after provisional CREATE adoption");
  (qaPool as any).connect = async (...args: any[]) => {
    const client = await (connect as any)(...args), query = client.query.bind(client);
    client.query = async (...values: any[]) => {
      const result = await query(...values);
      if (typeof values[0] === "string" && values[0].startsWith("UPDATE reference_task_bindings SET task_id=")) {
        if (kind === "lease") await query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.operationId]);
        if (kind === "credential") await query("UPDATE reference_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.connectionId]);
        if (kind === "cancel") controller.abort(reason);
      }
      return result;
    }; return client;
  };
  try {
    const promise = new ReferenceTaskStore(qaPool, key).completeCreate(f.claim, observed, controller.signal);
    if (kind === "cancel") await assert.rejects(promise, error => error === reason); else assert.equal(await promise, false);
    const op = await show(f.claim); assert.equal(op.status, "running"); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.binding.taskId, null); assert.equal(op.binding.sourceGeneration, 1); assert.equal(op.binding.etag, null); assert.equal(op.binding.baseline, null); assert.equal(op.createResponse.acceptedStatus, 200);
  } finally { await qaPool.end(); }
});
test("populated CREATE reservations/adoptions and all older histories survive full migration reruns", async () => {
  const f = await claimed(), observed = await confirmed(f.claim); await store.completeCreate(f.claim, observed); await claimed(); const beforeRows = await rows(), beforeOids = await oids(); await events.migrate(); await events.migrate(); assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await oids(), beforeOids);
});
