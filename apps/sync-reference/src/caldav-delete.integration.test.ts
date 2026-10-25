import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { projection, REFERENCE_CALDAV_DELETE_PROFILE, REFERENCE_GRAPH_DELETE_PROFILE } from "./admission.js";
import { encryptCredential } from "./crypto.js";
import type { ReferenceClaim, ReferenceCaldavDeleteSeed } from "./model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit independent disposable DB required");
const name = `reference_caldav_delete_${randomUUID().replaceAll("-", "")}`, database = new URL(adminUrl); database.pathname = `/${name}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }), pool = new Pool({ connectionString: database.href, max: 5 });
const key = "ab".repeat(32), store = new ReferenceStore(pool, key), etag = '"original-native-version"';
const content = { name: "Exact DAV DELETE", notes: null, place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" };
const identity = () => { const id = randomUUID(); return { connectionId: `dav-connection:${id}`, objectId: `dav-object:${id}`, bindingId: `dav-binding:${id}`, calendarUrl: `https://dav.example.test/calendars/${id}/`, resourceUrl: `https://dav.example.test/calendars/${id}/original.ics`, uid: `native-${id}@example.test` }; };
const seed = (): ReferenceCaldavDeleteSeed => ({ ...identity(), provider: "caldav", endpointProfile: REFERENCE_CALDAV_DELETE_PROFILE, username: "owner@example.test", password: "synthetic-password", expiresAt: "2099-01-01T00:00:00.000Z", content, etag });
async function fixture() { const supplied = seed(); await store.seedCaldavDeleteBinding(supplied); return { ...supplied, input: { bindingId: supplied.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: randomUUID() } }; }
async function claimed() { const f = await fixture(); await store.admitCaldavDelete(f.input); const claim = await store.claim(f.input.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
const complete = (claim: ReferenceClaim, signal?: AbortSignal) => store.completeCaldavDelete(claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }, signal);
async function confirmed(claim: ReferenceClaim, provider: "accepted" | "uncertain" | "not-dispatched" | "rejected" = "accepted") {
  if (provider !== "not-dispatched") await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider, ...(provider === "accepted" ? { acceptanceStatus: 204 as const } : {}), ...(provider === "rejected" ? { error: { code: "rate-limited", retry: "after-delay" as const, retryAfterMs: 9000 } } : {}), remote: "confirmed", observationId: randomUUID() });
}
const oids = async () => (await pool.query("SELECT relname,oid FROM pg_class WHERE relname LIKE 'reference_%' AND relkind IN ('r','i') ORDER BY relname")).rows;
const old: { action: string; id: string; claim: ReferenceClaim; eventId: string }[] = [];
let beforeOids: unknown, beforeRows: unknown, beforeAttempts: unknown;
const oldRows = () => pool.query("SELECT id,payload,receipt,accepted_etag,connection_generation,source_generation,privacy_generation,canonical_generation,provider,endpoint_profile FROM reference_operations ORDER BY id").then(r => r.rows);
before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const file of ["schema.sql", "schema-delete.sql", "schema-create.sql", "schema-graph-delete.sql"]) await pool.query(await readFile(new URL(file, import.meta.url), "utf8"));
  for (const action of ["create", "update", "delete", "graph-delete"]) {
    const id = randomUUID(), target = identity(), eventId = action === "create" ? `musubi${id.replaceAll("-", "")}` : `old-native:${id}`;
    const common = { connectionId: target.connectionId, objectId: target.objectId, bindingId: target.bindingId, calendarId: "old-calendar", accessToken: "synthetic-old-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: action === "graph-delete" ? "Calendars.ReadWrite" : "https://www.googleapis.com/auth/calendar.events", content };
    if (action === "create") await store.seedCreateBinding({ ...common, operationId: id });
    else if (action === "graph-delete") await store.seedGraphDeleteBinding({ ...common, provider: "microsoft", endpointProfile: REFERENCE_GRAPH_DELETE_PROFILE, eventId, etag: 'W/"old-weak"' });
    else await store.seedBinding({ ...common, eventId, etag });
    const input = { bindingId: common.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: id };
    if (action === "create") await store.admitCreate(input); else if (action === "update") await store.admitUpdate({ ...input, patch: { name: "Old accepted UPDATE" } });
    else if (action === "graph-delete") await store.admitGraphDelete(input); else await store.admitDelete(input);
    const claim = await store.claim(id, randomUUID()); assert(claim); await store.markDispatch(claim);
    await store.recordEvidence(claim, { provider: "accepted", remote: "confirmed", ...(action.includes("delete") ? { acceptanceStatus: 204 as const } : { validator: '"old-accepted"' }) }); old.push({ action, id, claim, eventId });
  }
  beforeOids = await oids(); beforeRows = await oldRows(); beforeAttempts = (await pool.query("SELECT * FROM reference_attempts ORDER BY id")).rows;
  await store.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } });

test("populated Google CREATE/UPDATE/DELETE and Graph upgrade preserves old identities, immutable payloads and historical receipts", async () => {
  await store.migrate(); assert.deepEqual(await oids(), beforeOids); assert.deepEqual(await oldRows(), beforeRows); assert.deepEqual((await pool.query("SELECT * FROM reference_attempts ORDER BY id")).rows, beforeAttempts);
  assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE accepted_uid IS NOT NULL")).rows[0].count, "0");
  for (const item of old) {
    const ok = item.action === "create" ? await store.completeCreate(item.claim, { eventId: item.eventId, etag: '"old-accepted"', projection: projection(content) })
      : item.action === "update" ? await store.complete(item.claim, { etag: '"old-accepted"', projection: projection({ ...content, name: "Old accepted UPDATE" }) })
      : item.action === "graph-delete" ? await store.completeGraphDelete(item.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } })
      : await store.completeDelete(item.claim, { kind: "exact-absence", read: { kind: "absent", status: 410 } });
    assert.equal(ok, true, item.action);
  }
});
test("DAV seed/admission uses immutable accepted UID, URL and original strong ETag, with repeat-migrate preservation", async () => {
  const f = await fixture(), op = await store.admitCaldavDelete(f.input); assert.deepEqual(await store.admitCaldavDelete(f.input), op);
  assert.equal(op.provider, "caldav"); assert.equal(op.endpointProfile, REFERENCE_CALDAV_DELETE_PROFILE); assert.equal(op.acceptedUid, f.uid); assert.equal(op.binding.etag, etag);
  const tableOids = await oids(); await store.migrate(); await store.migrate(); assert.deepEqual(await oids(), tableOids); assert.deepEqual(await store.inspectOperation(op.operationId), op);
  for (const sql of ["accepted_uid='another'", "calendar_id='https://dav.example.test/other/'", "event_id='https://dav.example.test/other/item.ics'", "accepted_etag='\"newer\"'", "provider='google'", "endpoint_profile='google-personal-event-delete-v1'", "payload='{}'::jsonb"])
    await assert.rejects(pool.query(`UPDATE reference_operations SET ${sql} WHERE id=$1`, [op.operationId]), /immutable/);
});
test("DAV bootstrap refuses missing UID, ambiguous URLs, weak validator, unsupported content and OAuth/resolution input", async () => {
  for (const patch of [{ uid: "" }, { etag: 'W/"weak"' }, { resourceUrl: "https://other.example.test/item.ics" }, { content: { ...content, beginsAt: "2026-10-25T08:00:00.123Z" } }, { scope: "calendar.events" }, { accessToken: "token" }])
    await assert.rejects(store.seedCaldavDeleteBinding({ ...seed(), ...patch } as never), /Invalid reference/);
  const f = await fixture(); await assert.rejects(store.admitCaldavDelete({ ...f.input, resolution: { expectedRemoteExists: true } } as never), /Invalid reference input/);
  for (const admit of [() => store.admitDelete(f.input), () => store.admitGraphDelete(f.input), () => store.admitUpdate({ ...f.input, patch: { name: "wrong" } }), () => store.admitCreate(f.input)]) await assert.rejects(admit(), /source-unavailable/);
  await pool.query("UPDATE reference_bindings SET ical_uid=NULL WHERE id=$1", [f.bindingId]); await assert.rejects(store.admitCaldavDelete(f.input), /native-identity-unavailable/);
  assert.equal((await pool.query("SELECT canonical_lifecycle,revision FROM reference_objects WHERE id=$1", [f.objectId])).rows[0].revision, "1");
});
test("Basic session is provider-specific, locally validity bounded, encrypted and never uses an OAuth scope", async () => {
  const f = await claimed(), session = await store.getCaldavSession(f.claim, 0); assert.equal(session.authorization, `Basic ${Buffer.from(`${f.username}:${f.password}`).toString("base64")}`);
  const conn = (await pool.query("SELECT * FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0]; assert.equal(conn.scope, ""); assert.equal(conn.credential_ciphertext.includes(f.password), false);
  await assert.rejects(store.getSession(f.claim, 0), /credential-kind-unavailable/);
  await pool.query("UPDATE reference_connections SET expires_at='2000-01-01' WHERE id=$1", [f.connectionId]); await assert.rejects(store.getCaldavSession(f.claim, 0), /credentials-expired/);
  const malformed = await fixture(); await pool.query("UPDATE reference_connections SET credential_ciphertext=$2 WHERE id=$1", [malformed.connectionId, encryptCredential(key, malformed.connectionId, "not-a-basic-envelope")]);
  await store.admitCaldavDelete(malformed.input); const claim = await store.claim(malformed.input.operationId, randomUUID()); assert(claim); await assert.rejects(store.getCaldavSession(claim, 0), /credential-kind-unavailable/);
});
test("conditional DAV dispatch retains its marker and can re-enter while Graph remains one-shot", async () => {
  const f = await claimed(); assert.equal(await store.markDispatch(f.claim), true); assert.equal(await store.markDispatch(f.claim), true);
  await store.recordEvidence(f.claim, { provider: "uncertain", remote: "unobserved" }); await store.finish(f.claim, "hold"); const next = await store.claim(f.input.operationId, randomUUID()); assert(next);
  assert.equal(next.recovery, true); assert.equal(await store.markDispatch(next), true); assert.equal((await store.inspectOperation(f.input.operationId)).dispatchPossible, true);
  await assert.rejects(store.admitCaldavDelete({ ...f.input, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID() }), /lifecycle-unavailable|causal-barrier/);
});
test("DAV ACK accepts only exact404 and preserves provider acceptance/uncertainty/rejection independently", async () => {
  for (const provider of ["accepted", "uncertain", "not-dispatched", "rejected"] as const) {
    const f = await claimed(); for (const read of [{ kind: "absent", status: 410 }, { kind: "cancelled" }, { kind: "absent", status: 200 }]) await assert.rejects(store.completeCaldavDelete(f.claim, { kind: "exact-absence", read } as never), /invalid-caldav-absence|Invalid reference input/);
    assert.equal(await store.completeDelete(f.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }), false); assert.equal(await store.completeGraphDelete(f.claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }), false);
    await assert.rejects(complete(f.claim), /confirmation-missing/); await confirmed(f.claim, provider); assert.equal(await complete(f.claim), true);
    const op = await store.inspectOperation(f.input.operationId); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.deleteAcceptanceStatus, provider === "accepted" ? 204 : null); assert.equal(op.binding.destinationLifecycle, "absent"); assert.equal(op.binding.etag, etag); assert.equal(op.acceptedUid, f.uid);
  }
});
test("DAV cannot manufacture unsupported accepted statuses or mutation validators", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  await assert.rejects(store.recordEvidence(f.claim, { provider: "accepted", acceptanceStatus: 410, remote: "confirmed" }), /invalid-protocol-evidence/);
  await assert.rejects(store.recordEvidence(f.claim, { provider: "accepted", acceptanceStatus: 204, validator: etag, remote: "confirmed" }), /invalid-protocol-evidence/);
});
test("UID, URL and Basic-credential ABA invalidate the original reference integer source/connection floor", async () => {
  for (const kind of ["uid", "url", "credential", "privacy", "canonical"] as const) {
    const f = await claimed(); await confirmed(f.claim);
    if (kind === "uid") { await pool.query("UPDATE reference_bindings SET ical_uid=$2 WHERE id=$1", [f.bindingId, "other-uid"]); await pool.query("UPDATE reference_bindings SET ical_uid=$2 WHERE id=$1", [f.bindingId, f.uid]); }
    else if (kind === "url") { await pool.query("UPDATE reference_bindings SET event_id=$2 WHERE id=$1", [f.bindingId, f.calendarUrl + "other.ics"]); await pool.query("UPDATE reference_bindings SET event_id=$2 WHERE id=$1", [f.bindingId, f.resourceUrl]); }
    else if (kind === "credential") { const ciphertext = (await pool.query("SELECT credential_ciphertext FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0].credential_ciphertext; await pool.query("UPDATE reference_connections SET credential_ciphertext=$2 WHERE id=$1", [f.connectionId, encryptCredential(key, f.connectionId, JSON.stringify({ kind: "basic", username: "other", password: "synthetic" }))]); await pool.query("UPDATE reference_connections SET credential_ciphertext=$2 WHERE id=$1", [f.connectionId, ciphertext]); }
    else if (kind === "privacy") { await store.changePrivacy(f.objectId, "other"); await store.changePrivacy(f.objectId, "private"); }
    else { await pool.query("UPDATE reference_objects SET canonical_lifecycle='active' WHERE id=$1", [f.objectId]); await pool.query("UPDATE reference_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [f.objectId]); }
    await assert.rejects(store.getCaldavSession(f.claim, 0), /authority-changed/); await assert.rejects(store.markDispatch(f.claim), /authority-changed/); assert.equal(await complete(f.claim), false);
  }
});
test("stale lease cannot ACK a newer DAV attempt but retains its actual attempt evidence", async () => {
  const f = await claimed(); await confirmed(f.claim); await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  const fresh = await store.claim(f.input.operationId, randomUUID()); assert(fresh); assert.equal(await complete(f.claim), false); assert.equal(await store.recordEvidence(f.claim, { provider: "uncertain", remote: "unobserved" }), false); assert.equal(await complete(fresh), true);
});
test("cancellation while waiting for a DAV ACK lock rolls back the provisional transaction", async () => {
  const f = await claimed(); await confirmed(f.claim); const blocker = await pool.connect(); const cancellation = new AbortController();
  try { await blocker.query("BEGIN"); await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]);
    const waiting = complete(f.claim, cancellation.signal); await pause(30); cancellation.abort(new Error("Owned DAV cancellation")); await blocker.query("COMMIT"); await assert.rejects(waiting, /Owned DAV cancellation/);
    assert.equal((await store.inspectOperation(f.input.operationId)).status, "running"); assert.equal((await store.inspectOperation(f.input.operationId)).binding.destinationLifecycle, "present");
  } finally { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); }
});
