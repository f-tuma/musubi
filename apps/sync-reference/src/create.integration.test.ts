import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { projection, referenceCreateEventID } from "./admission.js";
import type { ReferenceClaim, ReferenceContent } from "./model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit independent or disposable test DB required");
const name = `reference_create_${randomUUID().replace(/-/g, "")}`;
const database = new URL(adminUrl); database.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = new Pool({ connectionString: database.href, max: 5 });
const key = "ab".repeat(32), store = new ReferenceStore(pool, key);
const content: ReferenceContent = { name: "A synthetic CREATE", notes: null, place: "Room", beginsAt: "2026-10-24T08:00:00.000Z", endsAt: "2026-10-24T09:00:00.000Z" };
const scope = "https://www.googleapis.com/auth/calendar.events";
const rows = async () => (await pool.query(`SELECT c.relname,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname LIKE 'reference_%' AND c.relkind IN ('r','i') ORDER BY c.relname`)).rows;
let oldOids: unknown, oldPayloads: unknown, oldAttempts: unknown;
let legacyUpdate: { operationId: string; claim: ReferenceClaim; content: ReferenceContent };
async function legacyFixture() {
  const nonce = randomUUID(), ids = { connectionId: `legacy-connection:${nonce}`, objectId: `legacy-object:${nonce}`, bindingId: `legacy-binding:${nonce}`, calendarId: `calendar/${nonce}`, eventId: `existing/${nonce}` };
  await store.seedBinding({ ...ids, accessToken: "synthetic-reference-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content, etag: '"before"' });
  return { ...ids, input: { bindingId: ids.bindingId, expectedRevision: 1, commandId: `command:${nonce}`, operationId: `operation:${nonce}` } };
}
async function fixture() {
  const nonce = randomUUID(), operationId = randomUUID();
  const ids = { connectionId: `create-connection:${nonce}`, objectId: `create-object:${nonce}`, bindingId: `create-binding:${nonce}`, calendarId: `calendar/${nonce}` };
  await store.seedCreateBinding({ ...ids, operationId, accessToken: "synthetic-reference-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content });
  return { ...ids, eventId: referenceCreateEventID(operationId), input: { bindingId: ids.bindingId, expectedRevision: 1, commandId: `create-command:${nonce}`, operationId } };
}
async function claimed() {
  const f = await fixture(); await store.admitCreate(f.input);
  const claim = await store.claim(f.input.operationId, randomUUID()); assert(claim);
  return { ...f, claim };
}
async function confirmed(claim: ReferenceClaim, provider: "accepted" | "uncertain" = "accepted") {
  await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider, ...(provider === "accepted" ? { validator: '"created"' } : {}), remote: "confirmed", observationId: randomUUID() });
}
const complete = (f: { claim: ReferenceClaim; eventId: string }, signal?: AbortSignal) =>
  store.completeCreate(f.claim, { eventId: f.eventId, etag: '"created"', projection: projection(content) }, signal);
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  await pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("./schema-delete.sql", import.meta.url), "utf8"));
  const update = await legacyFixture();
  await store.admitUpdate({ ...update.input, patch: { name: "Accepted before CREATE upgrade" } });
  const claim = await store.claim(update.input.operationId, randomUUID()); assert(claim);
  await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider: "accepted", validator: '"legacy-written"', remote: "confirmed", observationId: "legacy-observation" });
  legacyUpdate = { operationId: update.input.operationId, claim, content: { ...content, name: "Accepted before CREATE upgrade" } };
  const deleted = await legacyFixture();
  await store.admitDelete(deleted.input); const deleteClaim = await store.claim(deleted.input.operationId, randomUUID()); assert(deleteClaim);
  await store.markDispatch(deleteClaim); await store.recordEvidence(deleteClaim, { provider: "accepted", acceptanceStatus: 204, remote: "confirmed" });
  assert.equal(await store.completeDelete(deleteClaim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }), true);
  oldOids = await rows();
  oldPayloads = (await pool.query("SELECT id,payload,receipt,dispatch_possible,delete_acceptance_status FROM reference_operations ORDER BY id")).rows;
  oldAttempts = (await pool.query("SELECT id,operation_id,dispatch_possible,recovery,receipt,code,created_at,updated_at,delete_acceptance_status FROM reference_attempts ORDER BY id")).rows;
  await store.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("populated C05/C07 upgrade preserves tables, indexes, payloads, receipt/status history and old UPDATE delivery", async () => {
  await store.migrate(); await store.migrate();
  assert.deepEqual(await rows(), oldOids);
  assert.deepEqual((await pool.query("SELECT id,payload,receipt,dispatch_possible,delete_acceptance_status FROM reference_operations ORDER BY id")).rows, oldPayloads);
  assert.deepEqual((await pool.query("SELECT id,operation_id,dispatch_possible,recovery,receipt,code,created_at,updated_at,delete_acceptance_status FROM reference_attempts ORDER BY id")).rows, oldAttempts);
  assert.equal((await pool.query("SELECT count(*) FROM reference_attempts WHERE create_candidate_id IS NOT NULL OR create_acceptance_status IS NOT NULL OR create_acceptance_validator IS NOT NULL")).rows[0].count, "0");
  assert.equal(await store.complete(legacyUpdate.claim, { etag: '"legacy-written"', projection: projection(legacyUpdate.content) }), true);
  const op = await store.inspectOperation(legacyUpdate.operationId); assert.equal(op.status, "acked"); assert.equal(op.action, "update");
  assert.equal((await pool.query("SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('reference_bindings'::regclass,'reference_operations'::regclass,'reference_attempts'::regclass)")).rows[0].count, "6");
});
test("CREATE seed reserves a deterministic target without native validator, baseline or accepted intent", async () => {
  const f = await fixture();
  const binding = (await pool.query("SELECT * FROM reference_bindings WHERE id=$1", [f.bindingId])).rows[0];
  assert.equal(binding.destination_lifecycle, "reserved"); assert.equal(binding.event_id, f.eventId); assert.equal(binding.create_operation_id, f.input.operationId);
  assert.equal(binding.etag, null); assert.equal(binding.baseline, null);
  assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE binding_id=$1", [f.bindingId])).rows[0].count, "0");
  await assert.rejects(pool.query("UPDATE reference_bindings SET etag='\"fake\"' WHERE id=$1", [f.bindingId]), /check constraint/);
  await assert.rejects(pool.query("UPDATE reference_bindings SET create_operation_id=$2 WHERE id=$1", [f.bindingId, randomUUID()]), /immutable/);
});
test("CREATE CAS captures one immutable full plan; command retry is idempotent and changed input cannot alias it", async () => {
  const f = await fixture(), op = await store.admitCreate(f.input);
  assert.equal(op.action, "create"); assert.equal(op.capture.acceptedRevision, 2); assert.equal(op.capture.canonicalGeneration, 1);
  assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.binding.etag, null); assert.equal(op.binding.baseline, null);
  assert.deepEqual(op.canonical, { lifecycle: "active", generation: 1, revision: 2 });
  assert.deepEqual(await store.admitCreate(f.input), op);
  await assert.rejects(store.admitCreate({ ...f.input, expectedRevision: 2 }), /command-reused/);
  for (const sql of ["action='update'", "event_id='different'", "payload='{}'::jsonb", "accepted_revision=3", "canonical_generation=2", "accepted_etag='\"fake\"'"])
    await assert.rejects(pool.query(`UPDATE reference_operations SET ${sql} WHERE id=$1`, [op.operationId]), /immutable|check constraint/);
});
test("wrong UUID reservation, stale revision and concurrent admission leave no partial canonical change", async () => {
  const f = await fixture();
  await assert.rejects(store.admitCreate({ ...f.input, operationId: randomUUID() }), /lifecycle-unavailable/);
  await assert.rejects(store.admitCreate({ ...f.input, expectedRevision: 2 }), /revision-conflict/);
  const settled = await Promise.allSettled([store.admitCreate(f.input), store.admitCreate({ ...f.input, commandId: randomUUID() })]);
  assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT revision FROM reference_objects WHERE id=$1", [f.objectId])).rows[0].revision, "2");
  assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE binding_id=$1", [f.bindingId])).rows[0].count, "1");
});
test("no UPDATE/DELETE or second CREATE crosses an unresolved reservation", async () => {
  const f = await fixture(); await store.admitCreate(f.input);
  await assert.rejects(store.admitUpdate({ ...f.input, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "Premature" } }), /lifecycle-unavailable/);
  await assert.rejects(store.admitDelete({ ...f.input, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID() }), /lifecycle-unavailable/);
  await assert.rejects(store.admitCreate({ ...f.input, expectedRevision: 2, commandId: randomUUID() }), /causal-barrier/);
});
test("CREATE ACK atomically stores real projection/ETag, advances source epoch and enables serial UPDATE then DELETE", async () => {
  const f = await claimed(); await confirmed(f.claim); assert.equal(await complete(f), true);
  const created = await store.inspectOperation(f.input.operationId);
  assert.equal(created.status, "acked"); assert.equal(created.binding.destinationLifecycle, "present"); assert.equal(created.binding.sourceGeneration, 2);
  assert.equal(created.binding.etag, '"created"'); assert.deepEqual(created.binding.baseline, projection(content));
  assert.equal(await store.claim(f.input.operationId, randomUUID()), null); assert.equal(await complete(f), false);
  assert.equal((await store.admitCreate(f.input)).status, "acked");
  const update = { bindingId: f.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "After CREATE" } };
  const updated = await store.admitUpdate(update); assert.equal(updated.capture.sourceGeneration, 2);
  const claim = await store.claim(update.operationId, randomUUID()); assert(claim);
  await store.markDispatch(claim); await store.recordEvidence(claim, { provider: "accepted", validator: '"updated"', remote: "confirmed" });
  assert.equal(await store.complete(claim, { etag: '"updated"', projection: projection({ ...content, name: "After CREATE" }) }), true);
  const deletion = { bindingId: f.bindingId, expectedRevision: 3, commandId: randomUUID(), operationId: randomUUID() };
  await store.admitDelete(deletion); const deleteClaim = await store.claim(deletion.operationId, randomUUID()); assert(deleteClaim);
  await store.markDispatch(deleteClaim); await store.recordEvidence(deleteClaim, { provider: "accepted", acceptanceStatus: 204, remote: "confirmed" });
  assert.equal(await store.completeDelete(deleteClaim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }), true);
  const deleted = await store.inspectOperation(deletion.operationId); assert.equal(deleted.binding.destinationLifecycle, "absent"); assert.equal(deleted.canonical.lifecycle, "tombstoned");
  await assert.rejects(store.admitCreate({ ...f.input, expectedRevision: 4, commandId: randomUUID() }), /lifecycle-unavailable/);
});
test("CREATE completion requires actual dispatch, exact saved projection and strong real ETag", async () => {
  const f = await claimed();
  for (const etag of [null, "", 'W/"weak"']) await assert.rejects(store.completeCreate(f.claim, { eventId: f.eventId, etag, projection: projection(content) } as never), /invalid-create-observation/);
  await assert.rejects(complete(f), /confirmation-missing/);
  await confirmed(f.claim, "uncertain");
  await assert.rejects(store.completeCreate(f.claim, { eventId: "other", etag: '"real"', projection: projection(content) }), /observation-conflict/);
  await assert.rejects(store.completeCreate(f.claim, { eventId: f.eventId, etag: '"real"', projection: projection({ ...content, name: "Foreign" }) }), /observation-conflict/);
  assert.equal(await store.complete(f.claim, { etag: '"real"', projection: projection(content) }), false);
  assert.equal(await store.completeDelete(f.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }), false);
  assert.equal(await complete(f), true); assert.equal((await store.inspectOperation(f.input.operationId)).receipt.provider.kind, "uncertain");
});
test("a rejected CREATE is not adopted just because its target appears", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  await store.recordEvidence(f.claim, { provider: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 }, remote: "confirmed" });
  await assert.rejects(complete(f), /confirmation-missing/);
  assert.equal((await store.inspectOperation(f.input.operationId)).binding.destinationLifecycle, "reserved");
});
test("connection, source, privacy and canonical ABA invalidate old CREATE authority", async () => {
  for (const kind of ["connection", "source", "privacy", "canonical"] as const) {
    const f = await claimed(); await confirmed(f.claim);
    if (kind === "connection") { await store.changeConnection(f.connectionId, { status: "retired" }); await store.changeConnection(f.connectionId, { status: "active" }); }
    else if (kind === "source") { await store.changeBinding(f.bindingId, { active: false }); await store.changeBinding(f.bindingId, { active: true }); }
    else if (kind === "privacy") { await store.changePrivacy(f.objectId, "other"); await store.changePrivacy(f.objectId, "private"); }
    else { await pool.query("UPDATE reference_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_objects SET canonical_lifecycle='active' WHERE id=$1", [f.objectId]); }
    await assert.rejects(store.getSession(f.claim, 0), /authority-changed/); await assert.rejects(store.markDispatch(f.claim), /authority-changed/);
    assert.equal(await complete(f), false); assert.equal((await store.inspectOperation(f.input.operationId)).binding.destinationLifecycle, "reserved");
  }
});
test("lease takeover prevents stale CREATE ACK and leaves original immutable body pinned", async () => {
  const f = await claimed(); await confirmed(f.claim); const before = (await store.inspectOperation(f.input.operationId)).payload;
  await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  const fresh = await store.claim(f.input.operationId, randomUUID()); assert(fresh); assert.equal(fresh.recovery, true);
  assert.equal(await complete(f), false); assert.equal(await store.renew(f.claim), false); assert.equal(await store.finish(f.claim), false);
  assert.deepEqual((await store.inspectOperation(f.input.operationId)).payload, before);
  assert.equal(await store.completeCreate(fresh, { eventId: f.eventId, etag: '"created"', projection: projection(content) }), true);
});
test("CREATE ACK snapshots caller DTO and observation before waiting for a pool connection", async () => {
  const f = await claimed(); await confirmed(f.claim);
  const single = new Pool({ connectionString: database.href, max: 1 }), isolated = new ReferenceStore(single, key);
  const blocker = await single.connect();
  let released = false;
  try {
    const claim = { ...f.claim }, observation = { eventId: f.eventId, etag: '"created"', projection: projection(content) };
    const pending = isolated.completeCreate(claim, observation); await pause(20); assert.equal(single.waitingCount, 1);
    (claim as { operationId: string }).operationId = "foreign"; observation.eventId = "foreign"; observation.projection.title = "Foreign content";
    blocker.release(); released = true; assert.equal(await pending, true);
    assert.deepEqual((await store.inspectOperation(f.input.operationId)).binding.baseline, projection(content));
  } finally { if (!released) blocker.release(); await single.end(); }
});
test("CREATE admission snapshots operation UUID, command and CAS before waiting for PostgreSQL locks", async () => {
  const f = await fixture(), blocker = await pool.connect(); let open = false;
  try {
    await blocker.query("BEGIN"); open = true; await blocker.query("SELECT id FROM reference_objects WHERE id=$1 FOR UPDATE", [f.objectId]);
    const supplied = { ...f.input }, pending = store.admitCreate(supplied);
    await pause(25); supplied.operationId = randomUUID(); supplied.commandId = "mutated"; supplied.expectedRevision = 99;
    await blocker.query("COMMIT"); open = false;
    const admitted = await pending; assert.equal(admitted.operationId, f.input.operationId); assert.equal(admitted.commandId, f.input.commandId); assert.equal(admitted.capture.acceptedRevision, 2);
    const body = (admitted.payload as { operationEnvelope: { nativePlan: { data: { body: { id: string } } } } }).operationEnvelope.nativePlan.data.body;
    assert.equal(body.id, f.eventId);
  } finally { if (open) await blocker.query("ROLLBACK"); blocker.release(); }
});
test("CREATE seed snapshots private credential AAD, native UUID and full content before pool acquisition", async () => {
  const single = new Pool({ connectionString: database.href, max: 1 }), isolated = new ReferenceStore(single, key), blocker = await single.connect();
  const nonce = randomUUID(), operationId = randomUUID(), ids = { connectionId: `seed-connection:${nonce}`, objectId: `seed-object:${nonce}`, bindingId: `seed-binding:${nonce}`, calendarId: `calendar/${nonce}` };
  let released = false;
  try {
    const supplied = { ...ids, operationId, accessToken: "synthetic-original-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content: { ...content } };
    const pending = isolated.seedCreateBinding(supplied); await pause(20); assert.equal(single.waitingCount, 1);
    supplied.connectionId = "foreign"; supplied.operationId = randomUUID(); supplied.accessToken = "mutated-token"; supplied.content.name = "Mutated content";
    blocker.release(); released = true; await pending;
    const binding = (await pool.query("SELECT event_id,create_operation_id FROM reference_bindings WHERE id=$1", [ids.bindingId])).rows[0];
    assert.equal(binding.event_id, referenceCreateEventID(operationId)); assert.equal(binding.create_operation_id, operationId);
    const op = await store.admitCreate({ bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId });
    const claim = await store.claim(op.operationId, randomUUID()); assert(claim);
    assert.equal((await store.getSession(claim, 0)).accessToken, "synthetic-original-token");
    assert.deepEqual((op.payload as { operationEnvelope: { admittedProjection: { data: unknown } } }).operationEnvelope.admittedProjection.data, projection(content));
  } finally { if (!released) blocker.release(); await single.end(); }
});
test("cancellation while CREATE ACK waits for row authority locks rolls back reserved-to-present", async () => {
  const f = await claimed(); await confirmed(f.claim); const blocker = await pool.connect(), cancellation = new AbortController();
  let open = false;
  try {
    await blocker.query("BEGIN"); open = true; await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]);
    const pending = complete(f, cancellation.signal); await pause(30); cancellation.abort(new Error("Owned CREATE cancellation"));
    await blocker.query("COMMIT"); open = false; await assert.rejects(pending, /Owned CREATE cancellation/);
    const op = await store.inspectOperation(f.input.operationId); assert.equal(op.status, "running"); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.binding.etag, null);
  } finally { if (open) await blocker.query("ROLLBACK"); blocker.release(); }
});
