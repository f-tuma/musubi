import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { projection, REFERENCE_GRAPH_DELETE_PROFILE } from "./admission.js";
import type { ReferenceClaim, ReferenceContent, ReferenceGraphDeleteSeed } from "./model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit independent or disposable test DB required");
const name = `reference_graph_delete_${randomUUID().replace(/-/g, "")}`, database = new URL(adminUrl); database.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: database.href, max: 5 });
const key = "ab".repeat(32), store = new ReferenceStore(pool, key), etag = 'W/"original-native-version"';
const content: ReferenceContent = { name: "Synthetic guarded DELETE", notes: null, place: "Room", beginsAt: "2026-10-24T08:00:00.000Z", endsAt: "2026-10-24T09:00:00.000Z" };
const scope = "openid,Calendars.ReadWrite offline_access";
const identity = () => { const id = randomUUID(); return { connectionId: `connection:${id}`, objectId: `object:${id}`, bindingId: `binding:${id}`, calendarId: `calendar/${id}`, eventId: `event/${id}` }; };
const seed = (ids = identity()): ReferenceGraphDeleteSeed => ({ ...ids, provider: "microsoft", endpointProfile: REFERENCE_GRAPH_DELETE_PROFILE,
  accessToken: "synthetic-graph-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content, etag });
async function fixture() {
  const supplied = seed(); await store.seedGraphDeleteBinding(supplied);
  return { ...supplied, input: { bindingId: supplied.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: `graph-operation:${randomUUID()}` } };
}
async function claimed() { const f = await fixture(); await store.admitGraphDelete(f.input); const claim = await store.claim(f.input.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
const complete = (claim: ReferenceClaim, signal?: AbortSignal) => store.completeGraphDelete(claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }, signal);
async function confirmed(claim: ReferenceClaim, provider: "accepted" | "uncertain" | "not-dispatched" = "accepted") {
  if (provider !== "not-dispatched") await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider, ...(provider === "accepted" ? { acceptanceStatus: 204 as const } : {}), remote: "confirmed", observationId: randomUUID() });
}
const oids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relname LIKE 'reference_%' AND relkind IN ('r','i') ORDER BY relname")).rows;
let oldOids: unknown, oldRows: unknown, oldAttempts: unknown;
let oldUpdate: { id: string; claim: ReferenceClaim }, oldDelete: { id: string; claim: ReferenceClaim }, oldCreate: { id: string; claim: ReferenceClaim; eventId: string };
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const file of ["schema.sql", "schema-delete.sql", "schema-create.sql"]) await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  const ids = identity(); await store.seedBinding({ ...ids, accessToken: "old-google-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "https://www.googleapis.com/auth/calendar.events", content, etag: '"google-old"' });
  const update = { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "Old Google UPDATE" } };
  await store.admitUpdate(update); const claim = await store.claim(update.operationId, randomUUID()); assert(claim); await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider: "accepted", validator: '"google-updated"', remote: "confirmed" }); oldUpdate = { id: update.operationId, claim };
  const createdIds = identity(), operationId = randomUUID();
  await store.seedCreateBinding({ connectionId: createdIds.connectionId, objectId: createdIds.objectId, bindingId: createdIds.bindingId, calendarId: createdIds.calendarId,
    operationId, accessToken: "old-google-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "https://www.googleapis.com/auth/calendar.events", content });
  await store.admitCreate({ bindingId: createdIds.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId });
  const createClaim = await store.claim(operationId, randomUUID()); assert(createClaim); await store.markDispatch(createClaim);
  await store.recordEvidence(createClaim, { provider: "accepted", validator: '"google-created"', remote: "confirmed" });
  oldCreate = { id: operationId, claim: createClaim, eventId: `musubi${operationId.replace(/-/g, "")}` };
  const deletedIds = identity(), deleteId = randomUUID();
  await store.seedBinding({ ...deletedIds, accessToken: "old-google-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "https://www.googleapis.com/auth/calendar.events", content, etag: '"google-old"' });
  await store.admitDelete({ bindingId: deletedIds.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: deleteId });
  const deleteClaim = await store.claim(deleteId, randomUUID()); assert(deleteClaim); await store.markDispatch(deleteClaim);
  await store.recordEvidence(deleteClaim, { provider: "accepted", acceptanceStatus: 204, remote: "confirmed" }); oldDelete = { id: deleteId, claim: deleteClaim };
  oldOids = await oids(); oldRows = (await pool.query("SELECT id,payload,receipt,accepted_etag,connection_generation,source_generation,privacy_generation,canonical_generation FROM reference_operations ORDER BY id")).rows;
  oldAttempts = (await pool.query("SELECT * FROM reference_attempts ORDER BY id")).rows;
  await store.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("populated Google CREATE/UPDATE/DELETE upgrade preserves identities/history and stamps only explicit metadata", async () => {
  await store.migrate(); await store.migrate(); assert.deepEqual(await oids(), oldOids);
  assert.deepEqual((await pool.query("SELECT id,payload,receipt,accepted_etag,connection_generation,source_generation,privacy_generation,canonical_generation FROM reference_operations ORDER BY id")).rows, oldRows);
  assert.deepEqual((await pool.query("SELECT * FROM reference_attempts ORDER BY id")).rows, oldAttempts);
  assert.equal((await store.inspectOperation(oldUpdate.id)).endpointProfile, "google-personal-event-update-v1");
  assert.equal((await store.inspectOperation(oldCreate.id)).endpointProfile, "google-personal-event-create-v1");
  assert.equal((await store.inspectOperation(oldDelete.id)).endpointProfile, "google-personal-event-delete-v1");
  assert.equal(await store.complete(oldUpdate.claim, { etag: '"google-updated"', projection: projection({ ...content, name: "Old Google UPDATE" }) }), true);
  assert.equal(await store.completeCreate(oldCreate.claim, { eventId: oldCreate.eventId, etag: '"google-created"', projection: projection(content) }), true);
  assert.equal(await store.completeDelete(oldDelete.claim, { kind: "exact-absence", read: { kind: "absent", status: 410 } }), true);
});
test("Graph seed and DELETE admission retain the exact weak ETag and immutable provider/profile", async () => {
  const f = await fixture(), op = await store.admitGraphDelete(f.input);
  assert.equal(op.provider, "microsoft"); assert.equal(op.endpointProfile, REFERENCE_GRAPH_DELETE_PROFILE); assert.equal(op.binding.etag, etag);
  assert.deepEqual(op.canonical, { lifecycle: "tombstoned", generation: 2, revision: 2 }); assert.deepEqual(await store.admitGraphDelete(f.input), op);
  const claim = await store.claim(op.operationId, randomUUID()); assert(claim); assert.equal(claim.etag, etag); assert.equal(claim.attemptNumber, 1); assert.equal(claim.endpointProfile, REFERENCE_GRAPH_DELETE_PROFILE);
  assert.equal(claim.binding.provider, "microsoft"); assert.equal((await store.getSession(claim, 0)).eventWriteAllowed, true);
  for (const sql of ["provider='google'", "endpoint_profile='google-personal-event-delete-v1'", "accepted_etag='\"converted\"'", "payload='{}'::jsonb"])
    await assert.rejects(pool.query(`UPDATE reference_operations SET ${sql} WHERE id=$1`, [op.operationId]), /immutable/);
  await assert.rejects(pool.query("UPDATE reference_connections SET provider='google' WHERE id=$1", [f.connectionId]), /immutable/);
});
test("Graph cannot use Google admission and neither profile nor scope can be inferred from an ETag", async () => {
  const f = await fixture();
  await assert.rejects(store.admitDelete(f.input), /source-unavailable/);
  await assert.rejects(store.admitUpdate({ ...f.input, patch: { name: "Wrong provider" } }), /source-unavailable/);
  await assert.rejects(store.admitCreate({ ...f.input, operationId: randomUUID() }), /source-unavailable/);
  for (const patch of [{ etag: '"strong-is-not-native"' }, { etag: "changeKey" }, { endpointProfile: "google-personal-event-delete-v1" }, { provider: "google" }])
    await assert.rejects(store.seedGraphDeleteBinding({ ...seed(), ...patch } as never), /Invalid reference Graph DELETE seed/);
  const denied = seed(); denied.scope = "https://www.googleapis.com/auth/calendar.events"; await store.seedGraphDeleteBinding(denied);
  await assert.rejects(store.admitGraphDelete({ bindingId: denied.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: randomUUID() }), /source-unavailable/);
});
test("malformed Graph metadata cannot acquire the default Google profile", async () => {
  const f = await fixture(); const op = await store.admitGraphDelete(f.input);
  await assert.rejects(pool.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
    connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action,provider)
    SELECT id||'-missing-profile',command_id||'-missing-profile',binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
    connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action,'microsoft'
    FROM reference_operations WHERE id=$1`, [op.operationId]), /endpoint_profile/);
});
test("Graph dispatch is durably one-shot across repeated calls, new claims and known rejections", async () => {
  const f = await claimed(); assert.equal(await store.markDispatch(f.claim), true); await assert.rejects(store.markDispatch(f.claim), /guarded-delete-observe-only/);
  await store.recordEvidence(f.claim, { provider: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 }, remote: "conflict" });
  await store.finish(f.claim, "hold"); const fresh = await store.claim(f.input.operationId, randomUUID()); assert(fresh);
  assert.equal(fresh.attemptNumber, 2); assert.equal(fresh.recovery, true); assert.equal((await store.getSession(fresh, 0)).eventWriteAllowed, true);
  await assert.rejects(store.markDispatch(fresh), /guarded-delete-observe-only/);
  await assert.rejects(store.admitGraphDelete({ ...f.input, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID() }), /lifecycle-unavailable|causal-barrier/);
  await assert.rejects(store.admitGraphDelete({ ...f.input, resolution: { expectedRemoteExists: true, expectedRemoteEtag: etag } } as never), /Invalid reference input/);
});
test("Graph ACK requires exact 404 and preserves independent acceptance/absence axes", async () => {
  const f = await claimed();
  for (const read of [{ kind: "absent", status: 410 }, { kind: "cancelled" }, { kind: "absent", status: 200 }])
    await assert.rejects(store.completeGraphDelete(f.claim, { kind: "exact-absence", read } as never), /Invalid reference input|invalid-graph-absence/);
  assert.equal(await store.completeDelete(f.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }), false);
  await assert.rejects(complete(f.claim), /confirmation-missing/);
  await confirmed(f.claim); assert.equal(await complete(f.claim), true);
  const op = await store.inspectOperation(f.input.operationId); assert.equal(op.binding.destinationLifecycle, "absent"); assert.equal(op.binding.etag, etag);
  assert.equal(op.binding.sourceGeneration, 2); assert.equal(op.deleteAcceptanceStatus, 204); assert.equal(op.receipt.provider.kind, "accepted");
});
test("Graph initial scoped absence and uncertain recovery never fabricate ETag or native acceptance", async () => {
  for (const provider of ["not-dispatched", "uncertain"] as const) {
    const f = await claimed(); await confirmed(f.claim, provider); assert.equal(await complete(f.claim), true);
    const op = await store.inspectOperation(f.input.operationId); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.deleteAcceptanceStatus, null);
    assert.equal(op.dispatchPossible, provider !== "not-dispatched"); assert.equal(op.binding.etag, etag);
  }
});
test("Graph receipt cannot claim conditional validator or unsupported accepted response status", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  for (const acceptanceStatus of [200, 201, 410]) await assert.rejects(store.recordEvidence(f.claim, { provider: "accepted", acceptanceStatus: acceptanceStatus as never, remote: "confirmed" }), /invalid-protocol-evidence/);
  await assert.rejects(store.recordEvidence(f.claim, { provider: "accepted", acceptanceStatus: 204, validator: '"fake"', remote: "confirmed" }), /invalid-protocol-evidence/);
  assert.equal((await store.inspectOperation(f.input.operationId)).receipt.provider.kind, "pending");
});
test("Graph authority ABA and stale leases prevent dispatch/ACK while preserving attempt evidence", async () => {
  for (const kind of ["connection", "source", "privacy", "canonical"] as const) {
    const f = await claimed(); await confirmed(f.claim);
    if (kind === "connection") { await store.changeConnection(f.connectionId, { status: "retired" }); await store.changeConnection(f.connectionId, { status: "active" }); }
    else if (kind === "source") { await store.changeBinding(f.bindingId, { active: false }); await store.changeBinding(f.bindingId, { active: true }); }
    else if (kind === "privacy") { await store.changePrivacy(f.objectId, "other"); await store.changePrivacy(f.objectId, "private"); }
    else { await pool.query("UPDATE reference_objects SET canonical_lifecycle='active' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [f.objectId]); }
    await assert.rejects(store.getSession(f.claim, 0), /authority-changed/); assert.equal(await complete(f.claim), false);
  }
  const f = await claimed(); await confirmed(f.claim); await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  const fresh = await store.claim(f.input.operationId, randomUUID()); assert(fresh); assert.equal(await complete(f.claim), false); assert.equal(await complete(fresh), true);
});
test("Graph ACK cancellation during a real authority lock wait rolls back absence transition", async () => {
  const f = await claimed(); await confirmed(f.claim); const blocker = await pool.connect(), cancellation = new AbortController(); let open = false;
  try {
    await blocker.query("BEGIN"); open = true; await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]);
    const pending = complete(f.claim, cancellation.signal); await pause(30); cancellation.abort(new Error("Owned Graph ACK cancellation"));
    await blocker.query("COMMIT"); open = false; await assert.rejects(pending, /Owned Graph ACK cancellation/);
    const op = await store.inspectOperation(f.input.operationId); assert.equal(op.status, "running"); assert.equal(op.binding.destinationLifecycle, "present");
  } finally { if (open) await blocker.query("ROLLBACK"); blocker.release(); }
});
