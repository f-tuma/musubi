import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { projection, REFERENCE_GRAPH_CREATE_PROFILE, REFERENCE_GRAPH_DELETE_PROFILE, REFERENCE_CALDAV_DELETE_PROFILE } from "./admission.js";
import { projectMicrosoftCreatedEvent } from "@musubi/sync-runtime";
import type { ReferenceClaim, ReferenceGraphCreateSeed, ReferenceGraphCreateObservation } from "./model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit disposable independent DB required");
const name = `reference_graph_create_${randomUUID().replaceAll("-", "")}`, database = new URL(adminUrl); database.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: database.href, max: 5 });
const key = "ab".repeat(32), store = new ReferenceStore(pool, key), weak = 'W/"readback-native"';
const content = { name: "Synthetic Graph CREATE", notes: " Exact note ", place: " Room ", beginsAt: "2026-10-25T08:00:00.123Z", endsAt: "2026-10-25T09:00:00.456Z" };
const seed = (): ReferenceGraphCreateSeed => { const id = randomUUID(); return { provider: "microsoft", endpointProfile: REFERENCE_GRAPH_CREATE_PROFILE, connectionId: `graph-create:connection:${id}`, objectId: `graph-create:object:${id}`, bindingId: `graph-create:binding:${id}`, calendarId: `native/calendar/${id}`, operationId: randomUUID(), accessToken: "synthetic-graph-token", scope: "openid,Calendars.ReadWrite offline_access", expiresAt: "2099-01-01T00:00:00.000Z", content }; };
async function fixture() { const supplied = seed(); await store.seedGraphCreateBinding(supplied); const input = { bindingId: supplied.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: supplied.operationId }; await store.admitGraphCreate(input); return { ...supplied, input }; }
async function claimed() { const f = await fixture(); const claim = await store.claim(f.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
const row = async (id: string) => (await pool.query("SELECT * FROM reference_operations WHERE id=$1", [id])).rows[0];
function observation(f: { operationId: string; calendarId: string }, id = "assigned-native-id", etag: string | null = weak): ReferenceGraphCreateObservation {
  const event = { id, transactionId: f.operationId, subject: content.name, body: { contentType: "text", content: content.notes }, location: { displayName: content.place },
    start: { dateTime: content.beginsAt, timeZone: "UTC" }, end: { dateTime: content.endsAt, timeZone: "UTC" }, isAllDay: false, recurrence: null,
    type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, "@odata.etag": etag };
  const projected = projectMicrosoftCreatedEvent(event); assert(projected);
  return { kind: "correlated-readback", eventId: id, etag, projection: { ...projected }, read: { kind: "present", event, etag }, correlation: { kind: "complete-scoped-listing", operationId: f.operationId, calendarId: f.calendarId, matches: 1 } };
}
async function accepted(f: { claim: ReferenceClaim }, id = "assigned-native-id", validator: string | null = "raw-acceptance-value") {
  await store.markDispatch(f.claim); await store.recordGraphCreateEvidence(f.claim, { provider: "accepted", candidateEventId: id, createAcceptance: { status: 201, validator }, remote: "confirmed", observationId: randomUUID() });
}
const oids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relname LIKE 'reference_%' AND relkind IN ('r','i') ORDER BY relname")).rows;
const newColumns = ["create_profile", "create_candidate_id", "create_acceptance_validator", "create_acceptance_status", "caldav_create_acceptance_status"];
async function oldRows() { const result: Record<string, unknown> = {}; for (const table of ["reference_connections", "reference_objects", "reference_bindings", "reference_operations", "reference_attempts"]) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => !newColumns.includes(key)))); return result; }
let beforeRows: unknown, beforeOids: unknown; const old: { action: string; id: string; eventId: string; claim: ReferenceClaim }[] = [];
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`); for (const file of ["schema.sql", "schema-delete.sql", "schema-create.sql", "schema-graph-delete.sql", "schema-caldav-delete.sql"]) await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  for (const action of ["create", "update", "delete", "graph-delete", "dav-delete"]) {
    const id = randomUUID(), base = { connectionId: `old-connection:${id}`, objectId: `old-object:${id}`, bindingId: `old-binding:${id}`, calendarId: `old-calendar:${id}`, accessToken: "synthetic-old-token", scope: action === "graph-delete" ? "Calendars.ReadWrite" : "https://www.googleapis.com/auth/calendar.events", expiresAt: "2099-01-01T00:00:00.000Z", content: { ...content, notes: null, place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" } }, eventId = action === "create" ? `musubi${id.replaceAll("-", "")}` : `old-native:${id}`;
    if (action === "create") await store.seedCreateBinding({ ...base, operationId: id });
    else if (action === "graph-delete") await store.seedGraphDeleteBinding({ ...base, provider: "microsoft", endpointProfile: REFERENCE_GRAPH_DELETE_PROFILE, eventId, etag: weak });
    else if (action === "dav-delete") await store.seedCaldavDeleteBinding({ provider: "caldav", endpointProfile: REFERENCE_CALDAV_DELETE_PROFILE, connectionId: base.connectionId, objectId: base.objectId, bindingId: base.bindingId, calendarUrl: `https://dav.example.test/${id}/`, resourceUrl: `https://dav.example.test/${id}/native.ics`, uid: `old-uid:${id}`, username: "synthetic-owner", password: "synthetic-password", expiresAt: base.expiresAt, content: base.content, etag: '"old-strong"' });
    else await store.seedBinding({ ...base, eventId, etag: '"old-strong"' });
    const input = { bindingId: base.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id };
    if (action === "create") await store.admitCreate(input); else if (action === "update") await store.admitUpdate({ ...input, patch: { name: "Old UPDATE" } }); else if (action === "graph-delete") await store.admitGraphDelete(input); else if (action === "dav-delete") await store.admitCaldavDelete(input); else await store.admitDelete(input);
    const claim = await store.claim(id, randomUUID()); assert(claim); await store.markDispatch(claim); await store.recordEvidence(claim, { provider: "accepted", remote: "confirmed", ...(action.includes("delete") ? { acceptanceStatus: 204 as const } : { validator: '"old-accepted"' }) }); old.push({ action, id, eventId, claim });
  }
  beforeOids = await oids(); beforeRows = await oldRows(); await store.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("upgrade preserves populated Google/Graph/DAV payloads, epochs, attempts and OIDs before completing old pending operations", async () => {
  await store.migrate(); assert.deepEqual(await oids(), beforeOids); assert.deepEqual(await oldRows(), beforeRows);
  for (const table of ["reference_operations", "reference_attempts"]) assert.equal((await pool.query(`SELECT count(*) FROM ${table} WHERE caldav_create_acceptance_status IS NOT NULL`)).rows[0].count, "0");
  const oldContent = { ...content, notes: null, place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" };
  for (const item of old) { const ok = item.action === "create" ? await store.completeCreate(item.claim, { eventId: item.eventId, etag: '"old-accepted"', projection: projection(oldContent) })
    : item.action === "update" ? await store.complete(item.claim, { etag: '"old-accepted"', projection: projection({ ...oldContent, name: "Old UPDATE" }) })
    : item.action === "graph-delete" ? await store.completeGraphDelete(item.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } })
    : item.action === "dav-delete" ? await store.completeCaldavDelete(item.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } })
    : await store.completeDelete(item.claim, { kind: "exact-absence", read: { kind: "absent", status: 410 } }); assert.equal(ok, true, item.action); }
});
test("Graph reservation admits NULL forever and atomically adopts weak-or-null readback only into its binding", async () => {
  for (const etag of [weak, null]) {
    const f = await claimed(), admitted = await row(f.operationId); assert.equal(admitted.event_id, null); assert.equal(f.claim.locator.eventId, null); assert.equal(f.claim.binding.resourceId, null);
    await accepted(f); assert.equal(await store.completeGraphCreate(f.claim, observation(f, "assigned-native-id", etag)), true);
    const op = await store.inspectOperation(f.operationId); assert.equal(op.status, "acked"); assert.equal(op.graphCreate?.bindingEventId, "assigned-native-id"); assert.equal(op.binding.etag, etag); assert.equal(op.binding.sourceGeneration, 2); assert.equal((await row(f.operationId)).event_id, null); assert.deepEqual((await row(f.operationId)).payload, admitted.payload);
    await assert.rejects(pool.query("UPDATE reference_bindings SET etag='\"not-native-weak\"' WHERE id=$1", [f.bindingId]), /create_reservation_check/);
    const all = await oldRows(), identities = await oids(); await store.migrate(); await store.migrate(); assert.deepEqual(await oldRows(), all); assert.deepEqual(await oids(), identities);
  }
});
test("reservation/profile and immutable admitted identity cannot be weakened or rewritten after adoption", async () => {
  const f = await claimed();
  for (const sql of ["event_id='guessed-id'", "accepted_etag='W/\"pretend\"'", "endpoint_profile='microsoft-personal-event-delete-v1'", "payload='{}'::jsonb"]) await assert.rejects(pool.query(`UPDATE reference_operations SET ${sql} WHERE id=$1`, [f.operationId]), /immutable/);
  await assert.rejects(pool.query("UPDATE reference_bindings SET create_profile='google-personal-event-create-v1' WHERE id=$1", [f.bindingId]), /immutable/);
  await assert.rejects(pool.query("UPDATE reference_bindings SET event_id='guessed' WHERE id=$1", [f.bindingId]), /create_reservation_check/);
  await assert.rejects(store.admitGraphCreate({ ...f.input, resolution: {} } as never), /Invalid reference input/);
  await assert.rejects(store.seedGraphCreateBinding({ ...seed(), eventId: "guessed" } as never), /Invalid reference input/);
  const googleId = randomUUID(), googleBinding = `google-reservation:${randomUUID()}`;
  await store.seedCreateBinding({ connectionId: `google-connection:${randomUUID()}`, objectId: `google-object:${randomUUID()}`, bindingId: googleBinding, calendarId: "google-calendar", operationId: googleId, accessToken: "synthetic", scope: "https://www.googleapis.com/auth/calendar.events", expiresAt: "2099-01-01T00:00:00.000Z", content });
  await assert.rejects(pool.query("UPDATE reference_bindings SET event_id=NULL WHERE id=$1", [googleBinding]), /create_reservation_check/);
});
test("raw native acceptance strings roundtrip losslessly without entering conditional validators", async () => {
  for (const validator of [null, "", "not-a-conditional-validator", weak, "NUL\0value", "unpaired\ud800value"]) {
    const f = await claimed(); await accepted(f, "assigned-native-id", validator); const raw = await row(f.operationId), op = await store.inspectOperation(f.operationId);
    assert.equal(op.graphCreate?.acceptanceValidator, validator); assert.equal(raw.create_acceptance_validator, validator === null ? null : JSON.stringify(validator)); assert.deepEqual(op.receipt.provider, { kind: "accepted" });
    assert.equal(await store.completeGraphCreate(f.claim, observation(f, "assigned-native-id", null)), true); assert.equal((await store.inspectOperation(f.operationId)).graphCreate?.acceptanceValidator, validator);
  }
});
test("native candidate and acceptance metadata are monotonic and cannot use the generic Google evidence port", async () => {
  const f = await claimed(); await accepted(f);
  await assert.rejects(store.recordGraphCreateEvidence(f.claim, { provider: "accepted", candidateEventId: "different-id", createAcceptance: { status: 201, validator: "different" }, remote: "unobserved" }), /candidate-conflict/);
  await assert.rejects(store.recordGraphCreateEvidence(f.claim, { provider: "accepted", candidateEventId: "assigned-native-id", createAcceptance: { status: 201, validator: "different" }, remote: "unobserved" }), /acceptance-conflict/);
  await assert.rejects(store.recordEvidence(f.claim, { provider: "accepted", validator: '"looks-strong"', remote: "confirmed" }), /graph-create-evidence-port-required/);
  const op = await store.inspectOperation(f.operationId); assert.equal(op.graphCreate?.candidateEventId, "assigned-native-id"); assert.equal(op.graphCreate?.acceptanceValidator, "raw-acceptance-value");
});
test("uncertain complete correlation can persist its candidate without inventing native response acceptance", async () => {
  const f = await claimed(); await store.markDispatch(f.claim); await store.recordGraphCreateEvidence(f.claim, { provider: "uncertain", candidateEventId: "assigned-native-id", remote: "confirmed", observationId: randomUUID() });
  assert.equal(await store.completeGraphCreate(f.claim, observation(f)), true); const op = await store.inspectOperation(f.operationId); assert.equal(op.receipt.provider.kind, "uncertain"); assert.equal(op.graphCreate?.acceptanceStatus, null); assert.equal(op.graphCreate?.acceptanceValidator, null);
});
test("Graph CREATE durable dispatch remains one-shot after rejection and pending intent prevents another admission", async () => {
  const f = await claimed(); await store.markDispatch(f.claim); await store.recordGraphCreateEvidence(f.claim, { provider: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 }, remote: "unobserved" }); await store.finish(f.claim, "hold");
  const next = await store.claim(f.operationId, randomUUID()); assert(next); await assert.rejects(store.markDispatch(next), /create-observe-only/);
  await assert.rejects(store.admitGraphCreate({ ...f.input, operationId: randomUUID(), commandId: randomUUID(), expectedRevision: 2 }), /lifecycle-unavailable|causal-barrier/);
});
test("ACK rejects missing/incomplete correlation, changed content/identity and invalid readback validator", async () => {
  const f = await claimed(); await accepted(f);
  const original = observation(f);
  for (const invalid of [{ ...original, correlation: { ...original.correlation, matches: 2 } }, { ...original, correlation: { ...original.correlation, calendarId: "other" } }, { ...original, read: { ...original.read, event: { ...original.read.event, transactionId: randomUUID() } } }, { ...original, projection: { ...original.projection, title: "changed" } }, { ...original, etag: '"strong-is-not-native"', read: { ...original.read, etag: '"strong-is-not-native"' } }, { ...original, etag: 'W/"' + 'x'.repeat(2048) + '"', read: { ...original.read, etag: 'W/"' + 'x'.repeat(2048) + '"' } }])
    await assert.rejects(store.completeGraphCreate(f.claim, invalid as never), /invalid-graph-create-observation|observation-conflict/);
  assert.equal((await store.inspectOperation(f.operationId)).binding.destinationLifecycle, "reserved"); assert.equal((await row(f.operationId)).event_id, null);
});
test("scope occupancy collision refuses adoption with no partial binding or ACK changes and preserves native facts", async () => {
  const f = await claimed(); await accepted(f); const objectId = `occupied-object:${randomUUID()}`;
  await pool.query("INSERT INTO reference_objects(id,content) VALUES($1,$2)", [objectId, content]);
  await pool.query("INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline) VALUES($1,$2,$3,$4,$5,$6,$7)", [`occupied-binding:${randomUUID()}`, f.connectionId, objectId, f.calendarId, "assigned-native-id", weak, observation(f).projection]);
  await assert.rejects(store.completeGraphCreate(f.claim, observation(f)), /create-scope-occupied/); const op = await store.inspectOperation(f.operationId); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.graphCreate?.bindingEventId, null); assert.equal(op.status, "running"); assert.equal(op.graphCreate?.acceptanceStatus, 201); assert.equal(op.receipt.provider.kind, "accepted");
});
test("stale attempt evidence remains historical and cannot replace a new current candidate or ACK", async () => {
  const f = await claimed(); await store.markDispatch(f.claim); await store.recordGraphCreateEvidence(f.claim, { provider: "uncertain", remote: "unobserved" }); await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.operationId]);
  const fresh = await store.claim(f.operationId, randomUUID()); assert(fresh); await store.recordGraphCreateEvidence(fresh, { provider: "uncertain", candidateEventId: "assigned-native-id", remote: "confirmed", observationId: randomUUID() });
  assert.equal(await store.recordGraphCreateEvidence(f.claim, { provider: "accepted", candidateEventId: "late-old-candidate", createAcceptance: { status: 201, validator: "late-raw" }, remote: "unobserved" }), false);
  assert.equal((await store.inspectOperation(f.operationId)).graphCreate?.candidateEventId, "assigned-native-id"); assert.equal((await pool.query("SELECT create_candidate_id FROM reference_attempts WHERE id=$1", [f.claim.attemptId])).rows[0].create_candidate_id, "late-old-candidate"); assert.equal(await store.completeGraphCreate(f.claim, observation(f)), false); assert.equal(await store.completeGraphCreate(fresh, observation(f)), true);
});
test("source/connection/privacy/canonical ABA blocks adoption and retains native candidate evidence", async () => {
  for (const kind of ["connection", "source", "privacy", "canonical"] as const) {
    const f = await claimed(); await accepted(f);
    if (kind === "connection") { await store.changeConnection(f.connectionId, { status: "retired" }); await store.changeConnection(f.connectionId, { status: "active" }); }
    else if (kind === "source") { await store.changeBinding(f.bindingId, { active: false }); await store.changeBinding(f.bindingId, { active: true }); }
    else if (kind === "privacy") { await store.changePrivacy(f.objectId, "other"); await store.changePrivacy(f.objectId, "private"); }
    else { await pool.query("UPDATE reference_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_objects SET canonical_lifecycle='active' WHERE id=$1", [f.objectId]); }
    assert.equal(await store.completeGraphCreate(f.claim, observation(f)), false); assert.equal((await store.inspectOperation(f.operationId)).graphCreate?.candidateEventId, "assigned-native-id");
  }
});
test("cancellation waiting on ACK lock rolls back adoption while durable native acceptance survives", async () => {
  const f = await claimed(); await accepted(f); const blocker = await pool.connect(), cancellation = new AbortController();
  try { await blocker.query("BEGIN"); await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]); const waiting = store.completeGraphCreate(f.claim, observation(f), cancellation.signal); await pause(30); cancellation.abort(new Error("Owned Graph CREATE cancellation")); await blocker.query("COMMIT"); await assert.rejects(waiting, /Owned Graph CREATE cancellation/); const op = await store.inspectOperation(f.operationId); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.graphCreate?.bindingEventId, null); assert.equal(op.graphCreate?.candidateEventId, "assigned-native-id"); assert.equal(op.graphCreate?.acceptanceStatus, 201); }
  finally { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); }
});
