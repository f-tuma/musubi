import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import test, { after, before } from "node:test";
import { Pool } from "pg";
import { ReferenceStore, ReferenceHoldError } from "./store.js";
import { deliverReferenceOperation } from "./runner.js";
import { admissionFingerprint } from "./admission.js";
import type { ReferenceAdmission, ReferenceClaim, ReferenceContent, ReferenceSeed } from "./model.js";
const explicitUrl = process.env.REFERENCE_DATABASE_URL;
const fallbackUrl = process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined;
if (!explicitUrl && !fallbackUrl) throw new Error("An explicit reference database or disposable test database is required");
// CI's Musubi fixture URL is an administrative bootstrap only: host tables
// are created in a nonce-owned independent database, never its product schema.
const ownedDatabase = explicitUrl ? undefined : `reference_ledger_${randomUUID().replace(/-/g, "")}`;
const admin = ownedDatabase ? new Pool({ connectionString: fallbackUrl, max: 1 }) : undefined;
const database = new URL(explicitUrl ?? fallbackUrl!);
if (ownedDatabase) database.pathname = `/${ownedDatabase}`;
const pool = new Pool({ connectionString: database.href, max: 4 });
let ownedCreated = false;
const store = new ReferenceStore(pool, "ab".repeat(32));
const scope = "https://www.googleapis.com/auth/calendar.events";
const content: ReferenceContent = { name: "Original", notes: null, place: "Room", beginsAt: "2026-10-13T08:00:00.000Z", endsAt: "2026-10-13T09:00:00.000Z" };
before(async () => {
  if (admin && ownedDatabase) { await admin.query(`CREATE DATABASE "${ownedDatabase}"`); ownedCreated = true; }
  await store.migrate();
});
after(async () => {
  await pool.end();
  try { if (ownedCreated && admin && ownedDatabase) await admin.query(`DROP DATABASE "${ownedDatabase}"`); }
  finally { await admin?.end(); }
});
async function fixture() {
  const suffix = randomUUID(); const connectionId = `account:${suffix}`, objectId = `object:${suffix}`, bindingId = `binding:${suffix}`;
  await store.seedBinding({ connectionId, objectId, bindingId, calendarId: `calendar/${suffix}`, eventId: `event/${suffix}`, scope,
    accessToken: "fixture-token-private", expiresAt: "2099-01-01T00:00:00.000Z", content, etag: '"original"' });
  const input: ReferenceAdmission = { bindingId, expectedRevision: 1, commandId: `command:${suffix}`, operationId: `operation:${suffix}`, patch: { name: "Accepted A" } };
  return { connectionId, objectId, bindingId, input };
}
async function admitted() { const f = await fixture(); await store.admitUpdate(f.input); return f; }
async function claimed() { const f = await admitted(); const claim = await store.claim(f.input.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
const savedProjection = (claim: ReferenceClaim) => claim.envelope!.admittedProjection.data;
async function acceptedAndConfirmed(claim: ReferenceClaim) {
  await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider: "accepted", validator: '"native-v2"', remote: "confirmed", observationId: randomUUID() });
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("credentials encrypted separately, operation and inspection contain no token", async () => {
  const f = await admitted(); const op = await store.inspectOperation(f.input.operationId);
  const conn = (await pool.query("SELECT credential_ciphertext FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0];
  assert(!conn.credential_ciphertext.includes("fixture-token-private")); assert(!JSON.stringify(op).includes("fixture-token-private"));
  assert.equal(op.receipt.local.kind, "committed"); assert.equal(op.receipt.provider.kind, "not-dispatched");
});
test("CAS plus immutable intent atomic, idempotent command and altered-command rejection", async () => {
  const f = await admitted(); const op = await store.admitUpdate(f.input);
  assert.equal(op.operationId, f.input.operationId); assert.equal(op.capture.acceptedRevision, 2);
  await assert.rejects(store.admitUpdate({ ...f.input, patch: { name: "B" } }), error => error instanceof ReferenceHoldError && error.code === "command-reused");
  const object = (await pool.query("SELECT revision,content FROM reference_objects WHERE id=$1", [f.objectId])).rows[0];
  assert.equal(Number(object.revision), 2); assert.equal(object.content.name, "Accepted A");
});
test("invalid admitted JSON rolls back canonical revision and outbox insert", async () => {
  const f = await fixture();
  await assert.rejects(store.admitUpdate({ ...f.input, patch: { name: "x".repeat(2_000_000) } }));
  assert.equal(Number((await pool.query("SELECT revision FROM reference_objects WHERE id=$1", [f.objectId])).rows[0].revision), 1);
  assert.equal((await pool.query("SELECT id FROM reference_operations WHERE binding_id=$1", [f.bindingId])).rowCount, 0);
});
test("causal barrier and concurrent CAS admit exactly one operation", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([store.admitUpdate(f.input), store.admitUpdate({ ...f.input, commandId: randomUUID(), operationId: randomUUID() })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT id FROM reference_operations WHERE binding_id=$1", [f.bindingId])).rowCount, 1);
  await assert.rejects(store.admitUpdate({ ...f.input, expectedRevision: 2, commandId: randomUUID(), operationId: randomUUID() }), error => error instanceof ReferenceHoldError && error.code === "causal-barrier");
});
test("SQL rejects payload and captured identity rewrite, allows receipt update", async () => {
  const f = await admitted();
  for (const query of ["UPDATE reference_operations SET payload='{}'::jsonb WHERE id=$1", "UPDATE reference_operations SET connection_generation=99 WHERE id=$1"])
    await assert.rejects(pool.query(query, [f.input.operationId]), /immutable/);
  await pool.query("UPDATE reference_operations SET status='hold' WHERE id=$1", [f.input.operationId]);
});
test("grant status/scope/credential-presence ABA advances generation, token rotation does not", async () => {
  const f = await fixture();
  const generation = async () => Number((await pool.query("SELECT generation FROM reference_connections WHERE id=$1", [f.connectionId])).rows[0].generation);
  await store.changeConnection(f.connectionId, { accessToken: "new-token" }); assert.equal(await generation(), 1);
  await store.changeConnection(f.connectionId, { scope: "https://www.googleapis.com/auth/calendar.readonly" });
  await store.changeConnection(f.connectionId, { scope }); assert.equal(await generation(), 3);
  await store.changeConnection(f.connectionId, { status: "retired" }); await store.changeConnection(f.connectionId, { status: "active" }); assert.equal(await generation(), 5);
  await store.changeConnection(f.connectionId, { accessToken: null }); await store.changeConnection(f.connectionId, { accessToken: "new-token" }); assert.equal(await generation(), 7);
  await pool.query("UPDATE reference_connections SET generation=1 WHERE id=$1", [f.connectionId]); assert.equal(await generation(), 7);
});
test("source locator/retirement and privacy ABA cannot restore admitted authority", async () => {
  const f = await claimed();
  await store.changeBinding(f.bindingId, { active: false }); await store.changeBinding(f.bindingId, { active: true });
  await store.changePrivacy(f.objectId, "shared"); await store.changePrivacy(f.objectId, "private");
  await assert.rejects(store.markDispatch(f.claim), error => error instanceof ReferenceHoldError && error.code === "authority-changed");
  assert.equal((await store.inspectOperation(f.input.operationId)).dispatchPossible, false);
  assert.equal(Number((await pool.query("SELECT privacy_generation FROM reference_objects WHERE id=$1", [f.objectId])).rows[0].privacy_generation), 3);
});
test("expired or refused credentials HOLD before dispatch, opaque session identity retained", async () => {
  const f = await claimed(); const session = await store.getSession(f.claim, Date.now());
  assert.equal(session.connectionId, f.connectionId); assert.equal(session.connectionGeneration, "1"); assert.equal(session.eventWriteAllowed, true);
  await store.changeConnection(f.connectionId, { expiresAt: "2000-01-01T00:00:00.000Z" });
  await assert.rejects(store.getSession(f.claim, 0), error => error instanceof ReferenceHoldError && error.code === "credentials-expired");
  assert.equal((await store.inspectOperation(f.input.operationId)).dispatchPossible, false);
});
test("claim serializes workers; expired claim recovers saved payload without changing hash", async () => {
  const f = await claimed(); const original = hash(f.claim.payload);
  assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
  await store.markDispatch(f.claim);
  await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  const second = await store.claim(f.input.operationId, randomUUID()); assert(second);
  assert.equal(hash(second.payload), original); assert.equal(second.recovery, true); assert.equal(second.receipt.provider.kind, "uncertain");
});
test("exact confirmed observation atomically updates binding and idempotent restart", async () => {
  const f = await claimed(); await acceptedAndConfirmed(f.claim);
  assert.equal(await store.complete(f.claim, { etag: '"native-v2"', projection: savedProjection(f.claim) }), true);
  const op = await store.inspectOperation(f.input.operationId); assert.equal(op.status, "acked"); assert.equal(op.binding.etag, '"native-v2"');
  assert.deepEqual(op.binding.baseline, savedProjection(f.claim)); assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
  assert.equal((await store.admitUpdate(f.input)).status, "acked");
});
test("post-write privacy, source, grant and canonical changes preserve native evidence without binding ACK", async () => {
  for (const axis of ["privacy", "source", "connection", "revision"]) {
    const f = await claimed(); await acceptedAndConfirmed(f.claim);
    if (axis === "privacy") { await store.changePrivacy(f.objectId, "public"); await store.changePrivacy(f.objectId, "private"); }
    if (axis === "source") { await store.changeBinding(f.bindingId, { active: false }); await store.changeBinding(f.bindingId, { active: true }); }
    if (axis === "connection") { await store.changeConnection(f.connectionId, { status: "retired" }); await store.changeConnection(f.connectionId, { status: "active" }); }
    if (axis === "revision") await pool.query("UPDATE reference_objects SET revision=revision+1 WHERE id=$1", [f.objectId]);
    assert.equal(await store.complete(f.claim, { etag: '"native-v2"', projection: savedProjection(f.claim) }), false);
    await store.finish(f.claim);
    const op = await store.inspectOperation(f.input.operationId); assert.equal(op.binding.etag, '"original"');
    assert.equal(op.receipt.provider.kind, "accepted"); assert.equal(op.receipt.remote.kind, "confirmed"); assert.equal(op.status, "hold");
  }
});
test("stale lease evidence belongs to its attempt and cannot overwrite newer worker or ACK", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  const next = await store.claim(f.input.operationId, randomUUID()); assert(next);
  assert.equal(await store.recordEvidence(f.claim, { provider: "accepted", validator: '"stale"', remote: "confirmed", observationId: "old" }), false);
  assert.equal(await store.complete(f.claim, { etag: '"stale"', projection: savedProjection(f.claim) }), false);
  const op = await store.inspectOperation(f.input.operationId); assert.equal(op.leaseAttemptId, next.attemptId); assert.equal(op.receipt.provider.kind, "uncertain");
  const old = (await pool.query("SELECT receipt FROM reference_attempts WHERE id=$1", [f.claim.attemptId])).rows[0]; assert.equal(old.receipt.provider.kind, "accepted");
});
test("mismatching readback and expired leases cannot ACK or dispatch", async () => {
  const f = await claimed(); await acceptedAndConfirmed(f.claim);
  await assert.rejects(store.complete(f.claim, { etag: '"native-v2"', projection: { ...savedProjection(f.claim), title: "other" } }), error => error instanceof ReferenceHoldError && error.code === "observation-conflict");
  await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  assert.equal(await store.renew(f.claim), false); await assert.rejects(store.markDispatch(f.claim), /authority-changed/);
  assert.equal(await store.complete(f.claim, { etag: '"native-v2"', projection: savedProjection(f.claim) }), false);
});
test("Retry-After lower bound survives reconnect of the host pool", async () => {
  const f = await claimed(); await store.finish(f.claim, "hold", { retryAfterMs: 60_000, code: "rate-limited" });
  assert.equal(await new ReferenceStore(pool, "ab".repeat(32)).claim(f.input.operationId, randomUUID()), null);
  await pool.query("UPDATE reference_operations SET not_before=clock_timestamp()-interval '1 second' WHERE id=$1", [f.input.operationId]);
  assert(await store.claim(f.input.operationId, randomUUID()));
});
test("later observation failure preserves native acceptance and notification remains unrequested", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  await store.recordEvidence(f.claim, { provider: "accepted", validator: '"native-v2"', remote: "unobserved" });
  await store.recordEvidence(f.claim, { provider: "uncertain", remote: "unobserved", code: "invalid-provider-data" });
  const op = await store.inspectOperation(f.input.operationId); assert.equal(op.receipt.provider.kind, "accepted");
  assert.equal(op.receipt.remote.kind, "unobserved"); assert.equal(op.receipt.notification.kind, "not-requested");
});

test("unrepresentable Retry-After remains durably HOLD rather than retrying early", async () => {
  const f = await claimed(); await store.finish(f.claim, "hold", { retryAfterMs: Infinity });
  assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
  assert.equal((await pool.query("SELECT not_before='infinity'::timestamptz AS infinite FROM reference_operations WHERE id=$1", [f.input.operationId])).rows[0].infinite, true);
});
test("canonical content and native locator ABA advance their own authority clocks", async () => {
  const f = await claimed();
  await pool.query("UPDATE reference_objects SET content=jsonb_set(content,'{name}','\"B\"') WHERE id=$1", [f.objectId]);
  await pool.query("UPDATE reference_objects SET content=jsonb_set(content,'{name}','\"Accepted A\"'),revision=2 WHERE id=$1", [f.objectId]);
  assert.equal(Number((await pool.query("SELECT revision FROM reference_objects WHERE id=$1", [f.objectId])).rows[0].revision), 4);
  const original = (await pool.query("SELECT event_id FROM reference_bindings WHERE id=$1", [f.bindingId])).rows[0].event_id;
  await store.changeBinding(f.bindingId, { eventId: "elsewhere" }); await store.changeBinding(f.bindingId, { eventId: original });
  assert.equal(Number((await pool.query("SELECT source_generation FROM reference_bindings WHERE id=$1", [f.bindingId])).rows[0].source_generation), 3);
  await assert.rejects(store.markDispatch(f.claim), /authority-changed/);
});

for (const [status, expectedCode, expectedRetry] of [
  [412, "conflict", "never"], [429, "rate-limited", "after-delay"],
  [401, "permission-denied", "after-reconnect"], [403, "permission-denied", "after-reconnect"],
] as const) test(`native PATCH ${status} persists actionable protocol rejection metadata`, async () => {
  const f = await admitted();
  const binding = (await pool.query("SELECT calendar_id,event_id FROM reference_bindings WHERE id=$1", [f.bindingId])).rows[0];
  const calls: string[] = [];
  const baseTime = Date.parse("2026-10-13T00:00:00.000Z");
  const result = await deliverReferenceOperation(store, f.input.operationId, {
    http: { async fetch(url, init) {
      calls.push(init.method ?? "GET");
      if (init.method === "PATCH") return new Response(JSON.stringify({ error: { message: "native-private-error" } }), {
        status, ...(status === 429 ? { headers: { "retry-after": new Date(baseTime + 1000).toUTCString() } } : {}),
      });
      return new Response(JSON.stringify(url.includes("/calendarList/") ? { id: binding.calendar_id, accessRole: "writer" } : {
        id: binding.event_id, etag: '"original"', summary: content.name, description: content.notes, location: content.place,
        start: { dateTime: content.beginsAt }, end: { dateTime: content.endsAt }, organizer: { self: true },
      }), { status: 200 });
    } },
    // HTTP-date Retry-After is 999.75 ms; durable delay must round upwards.
    clock: { nowEpochMs: () => baseTime + 0.25, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  });
  assert.equal(result.status, status === 412 ? "conflict" : "hold");
  assert.deepEqual(calls, ["GET", "GET", "PATCH"]);
  const op = await store.inspectOperation(f.input.operationId);
  assert.equal(op.receipt.provider.kind, "rejected");
  if (op.receipt.provider.kind !== "rejected") assert.fail("Expected rejection receipt");
  assert.deepEqual(op.receipt.provider.error, { code: expectedCode, retry: expectedRetry, ...(status === 429 ? { retryAfterMs: 1000 } : {}) });
  assert.equal(op.binding.etag, '"original"'); assert.equal(op.receipt.remote.kind, "unobserved");
  assert(!JSON.stringify(op).includes("native-private-error"));
  if (status === 412) assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
  if (status === 401 || status === 403) {
    assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
    assert.equal((await pool.query("SELECT not_before='infinity'::timestamptz AS indefinite FROM reference_operations WHERE id=$1", [f.input.operationId])).rows[0].indefinite, true);
  }
  if (status === 429) {
    assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
    assert.equal((await pool.query("SELECT not_before>clock_timestamp() AS delayed FROM reference_operations WHERE id=$1", [f.input.operationId])).rows[0].delayed, true);
  }
});
test("invalid protocol retry metadata is rejected atomically before evidence mutation", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  await assert.rejects(store.recordEvidence(f.claim, { provider: "rejected", remote: "unobserved",
    error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 0.5 } }), /invalid-protocol-error/);
  assert.equal((await store.inspectOperation(f.input.operationId)).receipt.provider.kind, "pending");
});

test("429 rejection followed by externally fulfilled exact target ACKs through recovery without another PATCH", async () => {
  const f = await admitted();
  const binding = (await pool.query("SELECT calendar_id,event_id FROM reference_bindings WHERE id=$1", [f.bindingId])).rows[0];
  const calls: string[] = [];
  let externalFulfillment = false;
  const ports = {
    http: { async fetch(url: string, init: RequestInit) {
      calls.push(init.method ?? "GET");
      if (init.method === "PATCH") {
        assert.equal(externalFulfillment, false, "Recovery may not send another PATCH when the exact target is already fulfilled");
        return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(JSON.stringify(url.includes("/calendarList/") ? { id: binding.calendar_id, accessRole: "writer" } : {
        id: binding.event_id, etag: externalFulfillment ? '"external-fulfilled"' : '"original"', summary: externalFulfillment ? "Accepted A" : content.name,
        description: content.notes, location: content.place, start: { dateTime: content.beginsAt }, end: { dateTime: content.endsAt }, organizer: { self: true },
      }), { status: 200 });
    } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  };
  assert.equal((await deliverReferenceOperation(store, f.input.operationId, ports)).status, "hold");
  const rejected = await store.inspectOperation(f.input.operationId);
  assert.equal(rejected.receipt.provider.kind, "rejected"); assert.equal(rejected.binding.etag, '"original"');
  externalFulfillment = true;
  assert.equal((await deliverReferenceOperation(store, f.input.operationId, ports)).status, "acked");
  const op = await store.inspectOperation(f.input.operationId);
  assert.deepEqual(calls, ["GET", "GET", "PATCH", "GET"]); assert.deepEqual(op.receipt.provider, rejected.receipt.provider);
  assert.equal(op.receipt.remote.kind, "confirmed"); assert.equal(op.receipt.notification.kind, "not-requested");
  assert.equal(op.binding.etag, '"external-fulfilled"');
  assert.equal((await pool.query("SELECT count(*)::int AS total FROM reference_attempts WHERE operation_id=$1 AND recovery", [f.input.operationId])).rows[0].total, 1);
});
test("rejected confirmed target cannot ACK in a fresh attempt without recorded recovery", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  await store.recordEvidence(f.claim, { provider: "rejected", remote: "confirmed", observationId: randomUUID(), error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 0 } });
  await assert.rejects(store.complete(f.claim, { etag: '"external-fulfilled"', projection: savedProjection(f.claim) }), /confirmation-missing/);
  assert.equal((await store.inspectOperation(f.input.operationId)).binding.etag, '"original"');
});

test("admission snapshots immutable A before blocked PostgreSQL locks despite caller mutation", async () => {
  const f = await fixture();
  const original: ReferenceAdmission = { ...f.input, patch: { name: "Accepted A", notes: "Notes A", place: "Place A" } };
  const supplied: ReferenceAdmission = { ...original, patch: { ...original.patch } };
  const application = `reference_snapshot_${randomUUID().replace(/-/g, "")}`;
  const delayedPool = new Pool({ connectionString: database.href, max: 1, application_name: application });
  const delayedStore = new ReferenceStore(delayedPool, "ab".repeat(32));
  const blocker = await pool.connect(); let blocked = true;
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]);
  const pending = delayedStore.admitUpdate(supplied);
  try {
    const deadline = Date.now() + 5_000;
    while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rowCount) {
      if (Date.now() >= deadline) assert.fail("Admission did not reach the owned PostgreSQL row lock");
      await pause(10);
    }
    supplied.operationId = `changed:${randomUUID()}`;
    supplied.commandId = `changed:${randomUUID()}`;
    supplied.patch.name = "Caller B"; supplied.patch.notes = "Notes B"; supplied.patch.place = "Place B";
    await blocker.query("COMMIT"); blocked = false;
    const op = await pending;
    assert.equal(op.operationId, original.operationId); assert.equal(op.commandId, original.commandId);
    assert.deepEqual((op.payload as { operationEnvelope: { nativePlan: { data: { body: unknown } } } }).operationEnvelope.nativePlan.data.body,
      { summary: "Accepted A", description: "Notes A", location: "Place A" });
    assert.equal((await pool.query("SELECT fingerprint FROM reference_operations WHERE id=$1", [original.operationId])).rows[0].fingerprint, admissionFingerprint(original));
    assert.equal((await store.admitUpdate(original)).operationId, original.operationId, "The accepted A command remains idempotent");
    assert.equal((await pool.query("SELECT id FROM reference_operations WHERE id=$1", [supplied.operationId])).rowCount, 0);
    assert.equal((await pool.query("SELECT content FROM reference_objects WHERE id=$1", [f.objectId])).rows[0].content.name, "Accepted A");
  } finally {
    if (blocked) await blocker.query("ROLLBACK"); blocker.release();
    await pending.catch(() => undefined); await delayedPool.end();
  }
});
test("seed snapshots content, identities and credential AAD before blocked pool acquisition", async () => {
  const nonce = randomUUID();
  const original: ReferenceSeed = { connectionId: `account:${nonce}`, objectId: `object:${nonce}`, bindingId: `binding:${nonce}`,
    calendarId: `calendar:${nonce}`, eventId: `event:${nonce}`, accessToken: "seed-token-A", expiresAt: "2099-01-01T00:00:00.000Z",
    scope, privacyLabel: "private", content: { ...content, name: "Seed A" }, etag: '"seed-A"' };
  const supplied: ReferenceSeed = { ...original, content: { ...original.content } };
  const delayedPool = new Pool({ connectionString: database.href, max: 1 });
  const delayedStore = new ReferenceStore(delayedPool, "ab".repeat(32));
  const holder = await delayedPool.connect(); let held = true;
  const pending = delayedStore.seedBinding(supplied);
  try {
    assert.equal(delayedPool.waitingCount, 1, "Seed is waiting for the owned occupied pool connection");
    supplied.connectionId = `changed-account:${nonce}`; supplied.objectId = `changed-object:${nonce}`; supplied.bindingId = `changed-binding:${nonce}`;
    supplied.calendarId = "changed-calendar"; supplied.eventId = "changed-event"; supplied.accessToken = "seed-token-B";
    supplied.expiresAt = "2000-01-01T00:00:00.000Z"; supplied.scope = "https://www.googleapis.com/auth/calendar.readonly";
    supplied.privacyLabel = "shared"; supplied.etag = '"seed-B"'; supplied.content.name = "Seed B";
    holder.release(); held = false;
    await pending;
    const binding = (await pool.query("SELECT * FROM reference_bindings WHERE id=$1", [original.bindingId])).rows[0];
    assert.equal(binding.connection_id, original.connectionId); assert.equal(binding.object_id, original.objectId);
    assert.equal(binding.calendar_id, original.calendarId); assert.equal(binding.event_id, original.eventId); assert.equal(binding.etag, original.etag);
    assert.equal(binding.baseline.title, "Seed A");
    assert.equal((await pool.query("SELECT id FROM reference_connections WHERE id=$1", [supplied.connectionId])).rowCount, 0);
    const input: ReferenceAdmission = { bindingId: original.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: randomUUID(), patch: { name: "Updated A" } };
    await store.admitUpdate(input); const claim = await store.claim(input.operationId, randomUUID()); assert(claim);
    const session = await store.getSession(claim, Date.now());
    assert.equal(session.accessToken, "seed-token-A", "Encrypted credential A decrypts with the persisted A connection identity");
    assert.equal(session.scope, original.scope); assert.equal(session.eventWriteAllowed, true);
    assert.equal((await pool.query("SELECT privacy_label FROM reference_objects WHERE id=$1", [original.objectId])).rows[0].privacy_label, "private");
  } finally {
    if (held) holder.release(); await pending.catch(() => undefined); await delayedPool.end();
  }
});

test("strong observation validator and full target stay stable across blocked ACK locks", async () => {
  const f = await claimed(); await acceptedAndConfirmed(f.claim);
  const observation = { etag: '"native-v2"', projection: { ...savedProjection(f.claim) } };
  const application = `reference_ack_${randomUUID().replace(/-/g, "")}`;
  const delayedPool = new Pool({ connectionString: database.href, max: 1, application_name: application });
  const delayedStore = new ReferenceStore(delayedPool, "ab".repeat(32));
  const blocker = await pool.connect(); let blocked = true;
  await blocker.query("BEGIN"); await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]);
  const pending = delayedStore.complete(f.claim, observation);
  try {
    const deadline = Date.now() + 5_000;
    while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rowCount) {
      if (Date.now() >= deadline) assert.fail("ACK did not reach the owned PostgreSQL row lock");
      await pause(10);
    }
    observation.etag = 'W/"caller-weak"';
    observation.projection.title = "Caller B";
    await blocker.query("COMMIT"); blocked = false;
    assert.equal(await pending, true);
    const op = await store.inspectOperation(f.input.operationId);
    assert.equal(op.binding.etag, '"native-v2"'); assert.equal(op.binding.baseline.title, "Accepted A");
  } finally {
    if (blocked) await blocker.query("ROLLBACK"); blocker.release();
    await pending.catch(() => undefined); await delayedPool.end();
  }
});
test("protocol evidence axes, validator and parsed retry error stay stable while pool acquisition waits", async () => {
  const f = await claimed(); await store.markDispatch(f.claim);
  const delayedPool = new Pool({ connectionString: database.href, max: 1 });
  const delayedStore = new ReferenceStore(delayedPool, "ab".repeat(32));
  let holder = await delayedPool.connect(); let held = true;
  const error = { code: "rate-limited" as const, retry: "after-delay" as const, retryAfterMs: 1000 };
  const supplied: Parameters<ReferenceStore["recordEvidence"]>[1] = { provider: "rejected", remote: "unobserved", error };
  let pending = delayedStore.recordEvidence(f.claim, supplied);
  try {
    assert.equal(delayedPool.waitingCount, 1);
    supplied.provider = "accepted"; supplied.remote = "confirmed"; supplied.validator = 'W/"caller-weak"';
    error.retryAfterMs = 9000;
    holder.release(); held = false;
    assert.equal(await pending, true);
    let op = await store.inspectOperation(f.input.operationId);
    assert.deepEqual(op.receipt.provider, { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 1000 } });
    assert.equal(op.receipt.remote.kind, "unobserved");
    holder = await delayedPool.connect(); held = true;
    const accepted: Parameters<ReferenceStore["recordEvidence"]>[1] = { provider: "accepted", remote: "confirmed", validator: '"native-v2"', observationId: "observation-A" };
    pending = delayedStore.recordEvidence(f.claim, accepted);
    assert.equal(delayedPool.waitingCount, 1);
    accepted.provider = "rejected"; accepted.remote = "conflict"; accepted.validator = 'W/"caller-weak"'; accepted.observationId = "observation-B";
    holder.release(); held = false;
    assert.equal(await pending, true);
    op = await store.inspectOperation(f.input.operationId);
    assert.deepEqual(op.receipt.provider, { kind: "accepted", validator: { kind: "etag", value: '"native-v2"' } });
    assert.deepEqual(op.receipt.remote, { kind: "confirmed", observationId: "observation-A" });
  } finally {
    if (held) holder.release(); await pending.catch(() => undefined); await delayedPool.end();
  }
});

test("durable reconnect delay and finish code cannot change during blocked pool acquisition", async () => {
  const f = await claimed();
  const delayedPool = new Pool({ connectionString: database.href, max: 1 });
  const delayedStore = new ReferenceStore(delayedPool, "ab".repeat(32));
  const holder = await delayedPool.connect(); let held = true;
  const delay = { retryAfterMs: Infinity, code: "reconnect-gate-a" };
  const pending = delayedStore.finish(f.claim, "hold", delay);
  try {
    assert.equal(delayedPool.waitingCount, 1);
    delay.retryAfterMs = 0; delay.retryAfterMs = -1; delay.code = "changed-gate-b";
    holder.release(); held = false;
    assert.equal(await pending, true);
    assert.equal(await store.claim(f.input.operationId, randomUUID()), null);
    assert.equal((await pool.query("SELECT not_before='infinity'::timestamptz AS indefinite FROM reference_operations WHERE id=$1", [f.input.operationId])).rows[0].indefinite, true);
    assert.equal((await pool.query("SELECT code FROM reference_attempts WHERE id=$1", [f.claim.attemptId])).rows[0].code, "reconnect-gate-a");
  } finally {
    if (held) holder.release(); await pending.catch(() => undefined); await delayedPool.end();
  }
});


test("cancelled ACK waiting on PostgreSQL authority lock rolls back despite a live lease", async () => {
  const f = await claimed(); await acceptedAndConfirmed(f.claim);
  const application = `reference_cancelled_ack_${randomUUID().replace(/-/g, "")}`;
  const delayedPool = new Pool({ connectionString: database.href, max: 1, application_name: application });
  const delayedStore = new ReferenceStore(delayedPool, "ab".repeat(32));
  const blocker = await pool.connect(); let blocked = true;
  await blocker.query("BEGIN"); await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [f.connectionId]);
  const cancellation = new AbortController(); const reason = new Error("Owned C06 cancellation");
  const pending = delayedStore.complete(f.claim, { etag: '\"not-accepted\"', projection: savedProjection(f.claim) }, cancellation.signal);
  const rejection = assert.rejects(pending, error => error === reason);
  try {
    const deadline = Date.now() + 5_000;
    while (!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rowCount) {
      if (Date.now() >= deadline) assert.fail("ACK did not reach its owned PostgreSQL lock");
      await pause(10);
    }
    cancellation.abort(reason);
    await blocker.query("COMMIT"); blocked = false;
    await rejection;
    const op = await store.inspectOperation(f.input.operationId);
    assert.equal(op.status, "running"); assert.equal(op.leaseAttemptId, f.claim.attemptId);
    assert.equal(op.binding.etag, '"original"');
    assert.equal(op.binding.baseline.title, "Original");
  } finally {
    if (blocked) await blocker.query("ROLLBACK"); blocker.release();
    await pending.catch(() => undefined); await delayedPool.end();
  }
});
