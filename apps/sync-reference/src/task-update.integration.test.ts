import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceTaskStore } from "./task-store.js";
import { REFERENCE_TASK_UPDATE_PROFILE, encodeReferenceTask } from "./task-admission.js";
import { projection } from "./admission.js";
import type { ReferenceTaskClaim, ReferenceTaskContent } from "./task-model.js";
import { projectMicrosoftCreatedEvent, type RuntimeTaskNativeFacts } from "@musubi/sync-runtime";
const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit disposable independent DB required");
const name = `reference_task_${randomUUID().replaceAll("-", "")}`, url = new URL(adminUrl); url.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: url.href, max: 6 }), key = "ab".repeat(32);
const events = new ReferenceStore(pool, key), store = new ReferenceTaskStore(pool, key), scope = "https://www.googleapis.com/auth/tasks";
const content: ReferenceTaskContent = { name: "Independent task", notes: "Original notes", state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const baseline = { title: content.name, notes: content.notes, status: "needsAction" as const, due: "2026-10-26T00:00:00.000Z" };
const oldTables = ["reference_connections", "reference_objects", "reference_bindings", "reference_operations", "reference_attempts"];
const oldOids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relkind IN ('r','i') AND relname LIKE 'reference_%' AND relname NOT LIKE 'reference_task_%' ORDER BY relname")).rows;
async function oldRows() { const value: Record<string, unknown> = {}; for (const table of oldTables) value[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows; return value; }
let legacyRows: Record<string, any[]>, legacyOids: unknown;
async function assertLegacyRows() {
  for (const table of oldTables) assert.deepEqual((await pool.query(`SELECT * FROM ${table} WHERE id=ANY($1::text[]) ORDER BY id`, [legacyRows[table].map(row => row.id)])).rows, legacyRows[table]);
}
async function fixture(patch: Record<string, unknown> = { name: "New title" }) {
  const nonce = randomUUID(), ids = { connectionId: `task-connection:${nonce}`, objectId: `task-object:${nonce}`, bindingId: `task-binding:${nonce}`, taskListId: `list/${nonce}?`, taskId: `task/${nonce}?` };
  await store.seedBinding({ ...ids, provider: "google", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, accessToken: "synthetic-task-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content, etag: '"before"', baseline });
  const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: `command:${nonce}`, operationId: randomUUID(), patch };
  return { ...ids, input };
}
async function claimed(patch?: Record<string, unknown>) { const f = await fixture(patch); const operation = await store.admitUpdate(f.input); const claim = await store.claim(operation.operationId, randomUUID()); assert(claim); return { ...f, operation, claim }; }
function observation(claim: ReferenceTaskClaim, changes: Record<string, unknown> = {}) {
  assert.equal(typeof claim.locator.taskId, "string");
  if (claim.locator.taskId === null) throw new Error("Addressed fixture required");
  const target = claim.saved.projection, task = { id: claim.locator.taskId, ...target, etag: '"after"', ...changes };
  return { validator: task.etag, projection: { title: task.title, notes: task.notes, status: task.status, due: task.due }, read: { kind: "present" as const, task, etag: task.etag }, saved: claim.saved };
}
function facts(claim: ReferenceTaskClaim, provider: RuntimeTaskNativeFacts["provider"] = { kind: "accepted", validator: '"after"' }, confirmed = true): RuntimeTaskNativeFacts {
  return { provider, ...(provider.kind === "accepted" ? { acceptedStatus: 200 as const } : {}), possibleDispatch: provider.kind !== "not-dispatched", remote: confirmed ? { kind: "confirmed", observationId: randomUUID(), read: observation(claim).read, projection: claim.saved.projection } : { kind: "unobserved" } };
}
async function confirmed(claim: ReferenceTaskClaim, provider?: RuntimeTaskNativeFacts["provider"]) { await store.markDispatch(claim); assert.equal(await store.recordEvidence(claim, facts(claim, provider)), true); }
const show = (claim: ReferenceTaskClaim) => store.inspectOperation(claim.operationId);
async function mappingWait() {
  for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_bindings%FOR UPDATE%') AS waiting")).rows[0].waiting) return; await pause(10); }
  assert.fail("Real Task ACK did not wait on its binding lock");
}
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  // Actual seven-profile pre-task schema, before the task migration exists.
  for (const path of ["schema.sql", "schema-delete.sql", "schema-create.sql", "schema-graph-delete.sql", "schema-caldav-delete.sql", "schema-graph-create.sql", "schema-caldav-create.sql"])
    await pool.query(await readFile(new URL(path, import.meta.url), "utf8"));
  const eventContent = { name: "Old event", notes: null, place: "Room", beginsAt: "2026-10-26T08:00:00.000Z", endsAt: "2026-10-26T09:00:00.000Z" };
  for (const family of ["google-update", "google-delete", "google-create", "microsoft-delete", "microsoft-create", "caldav-delete", "caldav-create"]) {
    const id = randomUUID(), ids = { connectionId: `old-connection:${id}`, objectId: `old-object:${id}`, bindingId: `old-binding:${id}`, calendarId: `old-calendar:${id}`, eventId: `old-event:${id}` };
    const seed = { ...ids, accessToken: "old-synthetic-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "https://www.googleapis.com/auth/calendar.events", content: eventContent, etag: '"old"' };
    const input = { operationId: id, commandId: `old-command:${id}`, bindingId: ids.bindingId, expectedRevision: 1 };
    if (family === "google-update") { await events.seedBinding(seed); await events.admitUpdate({ ...input, patch: { name: "Old pending title" } }); }
    else if (family === "google-delete") { await events.seedBinding(seed); await events.admitDelete(input); }
    else if (family === "google-create") { await events.seedCreateBinding({ ...seed, operationId: id }); await events.admitCreate(input); }
    else if (family === "microsoft-delete") { await events.seedGraphDeleteBinding({ ...seed, provider: "microsoft", endpointProfile: "microsoft-personal-event-delete-v1", scope: "Calendars.ReadWrite", etag: 'W/"old"' }); await events.admitGraphDelete(input); }
    else if (family === "microsoft-create") { const { eventId: _eventId, etag: _etag, ...createSeed } = seed; await events.seedGraphCreateBinding({ ...createSeed, provider: "microsoft", endpointProfile: "microsoft-personal-event-create-v1", scope: "Calendars.ReadWrite", operationId: id }); await events.admitGraphCreate(input); }
    else {
      const dav = { provider: "caldav" as const, connectionId: ids.connectionId, objectId: ids.objectId, bindingId: ids.bindingId, calendarUrl: `https://dav.example.test/${id}/`, username: "owned-user", password: "synthetic-dav-pass", expiresAt: seed.expiresAt, content: eventContent };
      if (family === "caldav-delete") { await events.seedCaldavDeleteBinding({ ...dav, endpointProfile: "caldav-personal-event-delete-v1", resourceUrl: `${dav.calendarUrl}old.ics`, uid: `uid:${id}`, etag: seed.etag }); await events.admitCaldavDelete(input); }
      else { await events.seedCaldavCreateBinding({ ...dav, endpointProfile: "caldav-personal-event-create-v1", operationId: id }); await events.admitCaldavCreate(input); }
    }
    const claim = await events.claim(id, randomUUID()); assert(claim); await events.markDispatch(claim);
    if (family === "microsoft-create") await events.recordGraphCreateEvidence(claim, { provider: "accepted", candidateEventId: `assigned:${id}`, createAcceptance: { status: 201, validator: "native-raw-version" }, remote: "unobserved" });
    else if (family === "caldav-create") await events.recordCaldavCreateEvidence(claim, { provider: "accepted", createAcceptanceStatus: 201, remote: "unobserved" });
    else if (family.endsWith("delete")) await events.recordEvidence(claim, { provider: "accepted", acceptanceStatus: family === "google-delete" ? 204 : family === "microsoft-delete" ? 204 : 200, remote: "unobserved" });
    else await events.recordEvidence(claim, { provider: "uncertain", remote: "unobserved" });
  }
  for (const tag of [null, 'W/"old-adopted"', "reserved"] as const) {
    const id = randomUUID(), base = { connectionId: `graph-variant:${id}`, objectId: `graph-object:${id}`, bindingId: `graph-binding:${id}`, calendarId: `graph-calendar:${id}`, accessToken: "old-synthetic-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "Calendars.ReadWrite", content: eventContent, provider: "microsoft" as const, endpointProfile: "microsoft-personal-event-create-v1" as const, operationId: id };
    await events.seedGraphCreateBinding(base); if (tag === "reserved") continue;
    await events.admitGraphCreate({ bindingId: base.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id });
    const claim = await events.claim(id, randomUUID()); assert(claim); await events.markDispatch(claim);
    await events.recordGraphCreateEvidence(claim, { provider: "accepted", candidateEventId: `assigned:${id}`, createAcceptance: { status: 201, validator: "raw-native-version" }, remote: "confirmed" });
    const event = { id: `assigned:${id}`, transactionId: id, subject: eventContent.name, body: { contentType: "text", content: "" }, location: { displayName: eventContent.place }, start: { dateTime: eventContent.beginsAt, timeZone: "UTC" }, end: { dateTime: eventContent.endsAt, timeZone: "UTC" }, isAllDay: false, recurrence: null, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, "@odata.etag": tag };
    const projected = projectMicrosoftCreatedEvent(event); assert(projected);
    assert.equal(await events.completeGraphCreate(claim, { kind: "correlated-readback", eventId: event.id, etag: tag, projection: { ...projected }, read: { kind: "present", event, etag: tag }, correlation: { kind: "complete-scoped-listing", operationId: id, calendarId: base.calendarId, matches: 1 } }), true);
  }
  legacyRows = await oldRows() as Record<string, any[]>; legacyOids = await oldOids(); await events.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("seven old event profiles/history/sidecars/epochs and fifteen OIDs survive additive repeat task migration", async () => {
  assert.equal((legacyOids as unknown[]).length, 15); await events.migrate(); await events.migrate(); assert.deepEqual(await oldRows(), legacyRows); assert.deepEqual(await oldOids(), legacyOids);
  assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE status='running'")).rows[0].count, "7");
  assert.equal((await pool.query("SELECT count(*) FROM reference_bindings WHERE create_profile='microsoft-personal-event-create-v1' AND event_id IS NULL")).rows[0].count, "2");
});
test("task seed has real native baseline and independent rich truth; credentials remain private", async () => {
  const f = await fixture(); const conn = (await pool.query("SELECT * FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0];
  assert.notEqual(conn.credential_ciphertext, "synthetic-task-token"); assert.equal(conn.provider, "google");
  assert.deepEqual((await pool.query("SELECT content FROM reference_task_objects WHERE id=$1", [f.objectId])).rows[0].content, content);
  assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE binding_id=$1", [f.bindingId])).rows[0].count, "0");
});
test("task admission freezes full codec target, original baseline, sorted mask, captured epochs and rich canonical CAS", async () => {
  const f = await claimed(), op = await show(f.claim); assert.equal(op.capture.acceptedRevision, 2); assert.deepEqual(op.saved.patch, { title: "New title" }); assert.deepEqual(op.saved.baseline, baseline);
  assert.deepEqual(op.canonical.content, { ...content, name: "New title" }); assert.equal(op.canonical.content.state, "doing"); assert.equal(op.canonical.content.dueAt, content.dueAt); assert.equal(op.canonical.content.importance, "high");
  for (const patch of ["task_id='other'", "accepted_etag='\"other\"'", "payload='{}'::jsonb", "saved_projection='{}'::jsonb", "field_mask=ARRAY['notes']", "connection_generation=2"])
    await assert.rejects(pool.query(`UPDATE reference_task_operations SET ${patch} WHERE id=$1`, [op.operationId]), /immutable/);
  await assert.rejects(pool.query("UPDATE reference_task_bindings SET task_id='other' WHERE id=$1", [f.bindingId]), /immutable/);
});
test("nested evidence/read getters are refused by the shared descriptor-safe JSON boundary without evaluation", async () => {
  const f = await claimed(); let touched = false;
  const provider = Object.defineProperty({}, "kind", { enumerable: true, get() { touched = true; return "accepted"; } });
  await assert.rejects(store.recordEvidence(f.claim, { provider, possibleDispatch: false, remote: { kind: "unobserved" } } as RuntimeTaskNativeFacts), /invalid-task-evidence/);
  const observed = observation(f.claim); Object.defineProperty(observed.read.task, "title", { enumerable: true, get() { touched = true; return "caller getter"; } });
  await assert.rejects(store.completeUpdate(f.claim, observed), /invalid-task-observation/);
  assert.equal(touched, false); const op = await show(f.claim); assert.equal(op.receipt.provider.kind, "not-dispatched"); assert.equal(op.binding.etag, '"before"');
});
test("idempotent command and one-pending barrier are atomic with stale/concurrent canonical CAS", async () => {
  const f = await fixture(); await assert.rejects(store.admitUpdate({ ...f.input, expectedRevision: 2 }), /revision-conflict/);
  const results = await Promise.allSettled([store.admitUpdate(f.input), store.admitUpdate({ ...f.input, operationId: randomUUID(), commandId: randomUUID() })]); assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.deepEqual(await store.admitUpdate(f.input), await store.inspectOperation(f.input.operationId));
  await assert.rejects(store.admitUpdate({ ...f.input, patch: { notes: "different" } }), /command-reused/);
  await assert.rejects(store.admitUpdate({ ...f.input, operationId: randomUUID(), commandId: randomUUID(), expectedRevision: 2 }), /causal-barrier/);
  assert.equal((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [f.objectId])).rows[0].revision, "2");
});
test("Calendar/readonly grant and expired credential cannot provide task session/dispatch authority", async () => {
  for (const changed of ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/tasks.readonly"]) {
    const f = await claimed(); await pool.query("UPDATE reference_connections SET scope=$2 WHERE id=$1", [f.connectionId, changed]); await assert.rejects(store.getSession(f.claim), /authority-changed/); await assert.rejects(store.markDispatch(f.claim), /authority-changed/);
  }
  const f = await claimed(); await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.connectionId]); await assert.rejects(store.prepare(f.claim), /authority-changed/);
});
test("connection, binding and privacy ABA each invalidate captured task authority", async () => {
  for (const kind of ["connection", "binding", "privacy"]) {
    const f = await claimed();
    if (kind === "connection") { await pool.query("UPDATE reference_connections SET status='retired' WHERE id=$1", [f.connectionId]); await pool.query("UPDATE reference_connections SET status='active' WHERE id=$1", [f.connectionId]); }
    if (kind === "binding") { await pool.query("UPDATE reference_task_bindings SET active=false WHERE id=$1", [f.bindingId]); await pool.query("UPDATE reference_task_bindings SET active=true WHERE id=$1", [f.bindingId]); }
    if (kind === "privacy") { await pool.query("UPDATE reference_task_objects SET privacy_label='other' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_task_objects SET privacy_label='private' WHERE id=$1", [f.objectId]); }
    await assert.rejects(store.prepare(f.claim), /authority-changed/); assert.equal((await show(f.claim)).dispatchPossible, false);
  }
});
test("session post-materialization authority recheck uses the originally captured claim identity", async () => {
  const f = await claimed(), mutable = structuredClone(f.claim), lock = await pool.connect();
  try {
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    const session = store.getSession(mutable); await mappingWait(); (mutable as { operationId: string }).operationId = "caller-mutated-after-await";
    await lock.query("COMMIT"); assert.equal((await session).connectionId, f.connectionId);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("admission waiting on a binding lock rechecks local credential expiry before canonical commit", async () => {
  const f = await fixture(), lock = await pool.connect();
  try {
    await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.connectionId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    const admission = store.admitUpdate(f.input), rejected = assert.rejects(admission, /task-source-unavailable/); await mappingWait();
    while (!(await pool.query("SELECT expires_at<clock_timestamp() AS expired FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); await rejected;
    assert.equal((await pool.query("SELECT revision FROM reference_task_objects WHERE id=$1", [f.objectId])).rows[0].revision, "1");
    assert.equal((await pool.query("SELECT count(*) FROM reference_task_operations WHERE id=$1", [f.input.operationId])).rows[0].count, "0");
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("accepted status without a response validator survives restart before success-body parse", async () => {
  const f = await claimed(); await store.markDispatch(f.claim); await store.recordEvidence(f.claim, { provider: { kind: "accepted", validator: null }, acceptedStatus: 204, possibleDispatch: true, remote: { kind: "unobserved" } });
  await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.claim.operationId]);
  const next = await store.claim(f.claim.operationId, randomUUID()); assert(next); assert.equal(next.acceptedStatus, 204); assert.equal(next.receipt.provider.kind, "accepted"); assert.equal(next.recovery, true);
  assert.deepEqual((await pool.query("SELECT native_acceptance_status FROM reference_task_attempts WHERE operation_id=$1 ORDER BY created_at", [f.claim.operationId])).rows, [{ native_acceptance_status: 204 }, { native_acceptance_status: 204 }]);
});
test("historical accepted/uncertain facts survive later known rejection; a new retry may become uncertain", async () => {
  for (const kind of ["accepted", "uncertain", "rejected"] as const) {
    const f = await claimed(); await store.markDispatch(f.claim);
    const prior: RuntimeTaskNativeFacts["provider"] = kind === "accepted" ? { kind, validator: null } : kind === "rejected" ? { kind, error: { code: "rate-limited", retry: "after-delay" } } : { kind };
    await store.recordEvidence(f.claim, facts(f.claim, prior, false));
    if (kind === "rejected") { await store.markDispatch(f.claim); await store.recordEvidence(f.claim, facts(f.claim, { kind: "uncertain" }, false)); assert.equal((await show(f.claim)).receipt.provider.kind, "uncertain"); }
    else { await store.recordEvidence(f.claim, facts(f.claim, { kind: "rejected", error: { code: "rate-limited", retry: "after-delay" } }, false)); assert.equal((await show(f.claim)).receipt.provider.kind, kind); }
  }
});
test("exact full target and strong real readback atomically ACK without replacing rich canonical truth", async () => {
  const f = await claimed(); await confirmed(f.claim); assert.equal(await store.completeUpdate(f.claim, observation(f.claim)), true);
  const op = await show(f.claim); assert.equal(op.status, "acked"); assert.equal(op.binding.etag, '"after"'); assert.deepEqual(op.binding.baseline, op.saved.projection); assert.deepEqual(op.canonical.content, { ...content, name: "New title" });
  assert.equal(await store.completeUpdate(f.claim, observation(f.claim)), false);
});
test("untouched concurrent notes edit refuses strict full-target ACK and retains native accepted status", async () => {
  const f = await claimed(); await confirmed(f.claim); await assert.rejects(store.completeUpdate(f.claim, observation(f.claim, { notes: "Changed remotely" })), /observation-conflict/);
  const op = await show(f.claim); assert.equal(op.status, "running"); assert.equal(op.binding.etag, '"before"'); assert.deepEqual(op.binding.baseline, baseline); assert.equal(op.receipt.provider.kind, "accepted"); assert.equal(op.acceptedStatus, 200);
});
test("task ACK reuses strict native-body validation for raw tag, assignment/deletion flags and malformed raw due", async () => {
  const f = await claimed(); await confirmed(f.claim);
  for (const change of [{ etag: '"other-native-tag"' }, { assignmentInfo: {} }, { deleted: true }, { deleted: "false" }, { notes: 1 }, { due: "2026-10-26NOT-A-NATIVE-DATE" }]) {
    const observed = observation(f.claim);
    Object.assign(observed.read.task, change); // Keep the caller projection/outer tag unchanged on purpose.
    await assert.rejects(store.completeUpdate(f.claim, observed), /invalid-task-observation/);
  }
  const op = await show(f.claim); assert.equal(op.binding.etag, '"before"'); assert.deepEqual(op.binding.baseline, baseline); assert.equal(op.acceptedStatus, 200); assert.equal(op.status, "running");
});
test("empty native mask confirms through read only without inventing dispatch or acceptance", async () => {
  const f = await claimed({ importance: "low" }); assert.deepEqual(f.claim.saved.patch, {});
  await store.recordEvidence(f.claim, { provider: { kind: "not-dispatched" }, possibleDispatch: false, remote: { kind: "confirmed", observationId: randomUUID(), read: observation(f.claim).read, projection: f.claim.saved.projection } });
  assert.equal(await store.completeUpdate(f.claim, observation(f.claim)), true); const op = await show(f.claim); assert.equal(op.receipt.provider.kind, "not-dispatched"); assert.equal(op.dispatchPossible, false); assert.equal(op.acceptedStatus, null); assert.equal(op.canonical.content.importance, "low");
});
test("newer canonical/lifecycle authority refuses ACK while native accepted evidence remains", async () => {
  for (const kind of ["revision", "deleted"]) {
    const f = await claimed(); await confirmed(f.claim);
    if (kind === "revision") await pool.query("UPDATE reference_task_objects SET content=jsonb_set(content,'{name}','\"Newer canonical title\"') WHERE id=$1", [f.objectId]);
    else await pool.query("UPDATE reference_task_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [f.objectId]);
    assert.equal(await store.completeUpdate(f.claim, observation(f.claim)), false); assert.equal((await show(f.claim)).binding.etag, '"before"'); assert.equal((await show(f.claim)).receipt.provider.kind, "accepted");
  }
});
test("stale attempt cannot overwrite successor evidence or ACK after takeover", async () => {
  const f = await claimed(); await confirmed(f.claim, { kind: "uncertain" });
  await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.claim.operationId]); const next = await store.claim(f.claim.operationId, randomUUID()); assert(next);
  assert.equal(await store.recordEvidence(f.claim, facts(f.claim)), false); assert.equal(await store.completeUpdate(f.claim, observation(f.claim)), false); assert.equal((await show(f.claim)).leaseAttemptId, next.attemptId);
});
for (const kind of ["cancel", "expire", "snapshot"] as const) test(`ACK ${kind} during real binding lock wait has no partial mapping commit`, async () => {
  const f = await claimed(); await confirmed(f.claim); const lock = await pool.connect(), controller = new AbortController(), reason = new Error("Synthetic reference ACK cancellation"), observed = observation(f.claim), claim = structuredClone(f.claim);
  try {
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [f.bindingId]);
    if (kind === "expire") await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.claim.operationId]);
    const acknowledgement = store.completeUpdate(claim, observed, kind === "cancel" ? controller.signal : undefined);
    const rejected = kind === "cancel" ? assert.rejects(acknowledgement, error => error === reason) : undefined;
    await mappingWait();
    if (kind === "cancel") controller.abort(reason);
    else if (kind === "expire") { while (!(await pool.query("SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1", [f.claim.operationId])).rows[0].expired) await pause(10); }
    else { (claim as { operationId: string }).operationId = randomUUID(); observed.projection.title = "Mutable caller"; (observed.read.task as { id: string }).id = "other"; }
    await lock.query("COMMIT");
    if (kind === "cancel") await rejected; else assert.equal(await acknowledgement, kind === "snapshot");
    const op = await show(f.claim); assert.equal(op.binding.etag, kind === "snapshot" ? '"after"' : '"before"'); assert.equal(op.status, kind === "snapshot" ? "acked" : "running");
    assert.deepEqual(op.binding.baseline, kind === "snapshot" ? f.claim.saved.projection : baseline);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
for (const kind of ["dispatch", "evidence", "finish"] as const) test(`${kind} waiting on an attempt lock cannot commit after lease expiry`, async () => {
  const f = await claimed(); if (kind === "evidence") await store.markDispatch(f.claim);
  const original = await show(f.claim), lock = await pool.connect();
  try {
    await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.claim.operationId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_attempts WHERE id=$1 FOR UPDATE", [f.claim.attemptId]);
    const action = kind === "dispatch" ? store.markDispatch(f.claim) : kind === "evidence" ? store.recordEvidence(f.claim, facts(f.claim)) : store.finish(f.claim, "hold", { code: "synthetic-finish" });
    let waiting = false;
    for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_attempts%') AS waiting")).rows[0].waiting) { waiting = true; break; } await pause(10); }
    assert.equal(waiting, true, "The production port must actually wait for its attempt row");
    while (!(await pool.query("SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1", [f.claim.operationId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); assert.equal(await action, false); const op = await show(f.claim);
    assert.equal(op.status, "running"); assert.equal(op.leaseAttemptId, f.claim.attemptId); assert.equal(op.dispatchPossible, original.dispatchPossible); assert.equal(op.acceptedStatus, original.acceptedStatus); assert.deepEqual(op.receipt, original.receipt);
    assert.equal((await pool.query("SELECT code FROM reference_task_attempts WHERE id=$1", [f.claim.attemptId])).rows[0].code, null);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("heartbeat acquiring an operation lock after expiry cannot revive its old lease", async () => {
  const f = await claimed(), lock = await pool.connect();
  try {
    await pool.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1", [f.claim.operationId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_operations WHERE id=$1 FOR UPDATE", [f.claim.operationId]);
    const renewed = store.renew(f.claim); let waiting = false;
    for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_operations%') AS waiting")).rows[0].waiting) { waiting = true; break; } await pause(10); }
    assert.equal(waiting, true); while (!(await pool.query("SELECT lease_until<clock_timestamp() AS expired FROM reference_task_operations WHERE id=$1", [f.claim.operationId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); assert.equal(await renewed, false);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("dispatch waiting on its attempt row cannot outlive local credential validity", async () => {
  const f = await claimed(), lock = await pool.connect();
  try {
    await pool.query("UPDATE reference_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.connectionId]);
    await lock.query("BEGIN"); await lock.query("SELECT id FROM reference_task_attempts WHERE id=$1 FOR UPDATE", [f.claim.attemptId]);
    const dispatched = store.markDispatch(f.claim); let waiting = false;
    for (let i = 0; i < 200; i++) { if ((await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%reference_task_attempts%') AS waiting")).rows[0].waiting) { waiting = true; break; } await pause(10); }
    assert.equal(waiting, true); while (!(await pool.query("SELECT expires_at<clock_timestamp() AS expired FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0].expired) await pause(10);
    await lock.query("COMMIT"); assert.equal(await dispatched, false); assert.equal((await show(f.claim)).dispatchPossible, false);
    assert.equal((await pool.query("SELECT dispatch_possible FROM reference_task_attempts WHERE id=$1", [f.claim.attemptId])).rows[0].dispatch_possible, false);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
test("populated task ACK history and all original event rows/OIDs survive the full migration chain again", async () => {
  const tables = ["reference_task_objects", "reference_task_bindings", "reference_task_operations", "reference_task_attempts"], snapshot: Record<string, unknown> = {};
  for (const table of tables) snapshot[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  const identities = await oldOids(), taskIdentities = (await pool.query("SELECT relname,oid FROM pg_class WHERE relkind IN ('r','i') AND relname LIKE 'reference_task_%' ORDER BY relname")).rows;
  await events.migrate(); await events.migrate(); assert.deepEqual(await oldOids(), identities); await assertLegacyRows();
  assert.deepEqual((await pool.query("SELECT relname,oid FROM pg_class WHERE relkind IN ('r','i') AND relname LIKE 'reference_task_%' ORDER BY relname")).rows, taskIdentities);
  for (const table of tables) assert.deepEqual((await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows, snapshot[table]);
});
