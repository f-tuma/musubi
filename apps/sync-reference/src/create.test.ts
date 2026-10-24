import assert from "node:assert/strict";
import test from "node:test";
import { acceptedCreateEnvelope, createAdmissionFingerprint, deleteAdmissionFingerprint, initialReceipt, projection, referenceCreateEventID } from "./admission.js";
import { deliverReferenceOperation, supportsReferenceEnvelope, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceClaim, ReferenceContent, ReferenceEvidence } from "./model.js";

const content: ReferenceContent = { name: "Saved CREATE", notes: " Exact notes ", place: null, beginsAt: "2026-10-24T08:00:00.123Z", endsAt: "2026-10-24T09:00:00.456Z" };
const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const input = { bindingId: "reference:binding", expectedRevision: 1, commandId: "reference:command", operationId };
const host = { objectId: "reference:object", connectionId: "reference:connection", calendarId: "own/calendar+id", eventId: referenceCreateEventID(operationId),
  capture: { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 1 } };
const envelope = () => acceptedCreateEnvelope(input, content, host);
const native = (overrides: Record<string, unknown> = {}) => ({ ...envelope().nativePlan.data.body as Record<string, unknown>, etag: '"created"', status: "confirmed", eventType: "default", organizer: { self: true }, ...overrides });
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
const acl = () => response({ id: host.calendarId, accessRole: "owner" });
function fixture(replies: (Response | Error)[], recovery = false) {
  const admitted = envelope();
  const claim: ReferenceClaim = { operationId, attemptId: "reference:attempt", payload: { operationEnvelope: admitted }, envelope: admitted,
    binding: { kind: "event", action: "create", operationId, commandId: input.commandId, hostObjectId: host.objectId, provider: "google",
      connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId, acceptedRevision: 2, sourceEpoch: admitted.sourceEpoch, privacyEpoch: admitted.privacyEpoch },
    capture: { ...host.capture }, locator: { connectionId: host.connectionId, calendarId: host.calendarId, eventId: host.eventId }, etag: null,
    receipt: initialReceipt(admitted), recovery };
  if (recovery) claim.receipt.provider = { kind: "uncertain" };
  const calls: { url: string; init: RequestInit }[] = [], evidence: ReferenceEvidence[] = [], completions: unknown[] = [], finishes: unknown[] = [];
  let marks = 0, sessions = 0;
  const store: ReferenceRunnerStore = {
    async claim() { return claim; }, async renew() { return true; }, async markDispatch() { marks++; return true; },
    async getSession() { sessions++; return { accessToken: "synthetic-reference-token", connectionId: host.connectionId, connectionGeneration: "1", eventWriteAllowed: true, scope: "https://www.googleapis.com/auth/calendar.events" }; },
    async recordEvidence(_claim, value) { evidence.push(value); return true; },
    async complete() { assert.fail("CREATE cannot use UPDATE completion"); }, async completeDelete() { assert.fail("CREATE cannot use DELETE completion"); },
    async completeCreate(_claim, value) { completions.push(value); return true; }, async finish(_claim, status, outcome) { finishes.push({ status, ...outcome }); return true; },
  };
  let mismatch = false;
  const ports: ReferenceRunnerPorts = { http: { async fetch(url, init) {
    calls.push({ url, init }); const next = replies.shift(); if (!next) { mismatch = true; throw new Error("Unexpected synthetic HTTP"); }
    if (next instanceof Error) throw next; return next;
  } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  const run = async () => { const result = await deliverReferenceOperation(store, operationId, ports, { attemptId: claim.attemptId }); assert.equal(mismatch, false); assert.equal(replies.length, 0); return result; };
  return { claim, store, calls, evidence, completions, finishes, ports, run, counts: () => ({ marks, sessions }) };
}
test("CREATE admission pins the existing UUID/native marker identity and full independent content", () => {
  const admitted = envelope(); assert.equal(admitted.operation.action, "create"); assert.equal(supportsReferenceEnvelope(admitted), true);
  assert.deepEqual(admitted.admittedProjection.data, projection(content));
  const body = admitted.nativePlan.data.body as Record<string, unknown>;
  assert.equal(body.id, host.eventId); assert.deepEqual(body.extendedProperties, { private: { musubiOperationID: operationId } });
  assert.deepEqual(body.start, { dateTime: content.beginsAt }); assert.deepEqual(body.end, { dateTime: content.endsAt });
  assert.notEqual(createAdmissionFingerprint(input), deleteAdmissionFingerprint(input));
  for (const id of ["operation:opaque", operationId.toUpperCase(), "", operationId + " "]) assert.throws(() => referenceCreateEventID(id));
  assert.throws(() => acceptedCreateEnvelope(input, content, { ...host, eventId: "foreign" }));
});
test("fresh CREATE sends pinned POST then requires exact strong readback before adoption", async () => {
  const f = fixture([acl(), response(native(), 201), response(native())]);
  assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "POST", "GET"]);
  assert.equal(f.calls[1]!.init.body, JSON.stringify(envelope().nativePlan.data.body));
  assert.deepEqual(f.completions, [{ eventId: host.eventId, etag: '"created"', projection: projection(content) }]);
  assert.equal(f.counts().marks, 1); assert.deepEqual(f.evidence.map(value => [value.provider, value.remote]), [["accepted", "unobserved"], ["accepted", "confirmed"]]);
});
test("lost CREATE reply observes the same owned target with one POST and retained uncertainty", async () => {
  const f = fixture([acl(), new Error("Synthetic lost reply"), response(native())]);
  assert.equal((await f.run()).status, "acked"); assert.equal(f.calls.filter(call => call.init.method === "POST").length, 1);
  assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.evidence.at(-1)!.remote, "confirmed");
});
test("restart finds the exact own target by GET and never resends an already observed CREATE", async () => {
  const f = fixture([response(native())], true);
  assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]);
  assert.equal(f.counts().marks, 0); assert.equal(f.evidence.at(-1)!.provider, "uncertain");
});
test("a proven 404 permits only the same immutable ID/body POST, not a new identity", async () => {
  const f = fixture([response({}, 404), acl(), response(native(), 201), response(native())], true);
  assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "POST", "GET"]);
  assert.equal(f.calls[2]!.init.body, JSON.stringify(envelope().nativePlan.data.body)); assert.equal(f.counts().marks, 1);
});
for (const [label, observed, status] of [
  ["410", {}, 410], ["cancelled", native({ status: "cancelled" }), 200],
  ["foreign-marker", native({ extendedProperties: { private: { musubiOperationID: "foreign" } } }), 200],
  ["changed-content", native({ summary: "Foreign title" }), 200], ["weak-validator", native({ etag: 'W/"weak"' }), 200],
] as const) test(`recovery ${label} does not authorize CREATE or adoption`, async () => {
  const f = fixture([response(observed, status)], true); assert.notEqual((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]); assert.equal(f.completions.length, 0); assert.equal(f.counts().marks, 0);
});
test("a known 409 remains rejected with no automatic read/adoption", async () => {
  const f = fixture([acl(), response({}, 409)]); assert.equal((await f.run()).status, "hold");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "POST"]); assert.equal(f.completions.length, 0); assert.equal(f.evidence.at(-1)!.provider, "rejected");
});
test("429 preserves the provider rejection and bounded Retry-After", async () => {
  const f = fixture([acl(), response({}, 429, { "retry-after": "9" })]); assert.equal((await f.run()).status, "hold");
  assert.deepEqual(f.finishes.at(-1), { status: "hold", code: "provider-write-failed", retryAfterMs: 9000 });
  assert.deepEqual(f.evidence.at(-1)!.error, { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 });
});
test("malformed admitted CREATE refuses before opening credentials or HTTP", async () => {
  const f = fixture([]); (f.claim.payload as { operationEnvelope: { locator: { resourceId: string } } }).operationEnvelope.locator.resourceId = "foreign";
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0); assert.equal(f.counts().marks, 0);
});
test("a host without CREATE completion capability refuses before opening credentials or HTTP", async () => {
  const f = fixture([]); delete f.store.completeCreate;
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0); assert.equal(f.counts().marks, 0);
});
test("runtime pins nested CREATE body before an awaited host checkpoint", async () => {
  const f = fixture([acl(), response(native(), 201), response(native())]);
  const body = (f.claim.payload as { operationEnvelope: { nativePlan: { data: { body: Record<string, unknown> } } } }).operationEnvelope.nativePlan.data.body;
  const saved = JSON.stringify(body);
  const result = await deliverReferenceOperation(f.store, operationId, f.ports, { attemptId: f.claim.attemptId, checkpoint: async phase => {
    if (phase === "claim") { body.summary = "Late caller data"; (body.start as { dateTime: string }).dateTime = "2030-01-01T00:00:00.000Z"; }
  } });
  assert.equal(result.status, "acked"); assert.equal(f.calls[1]!.init.body, saved);
});
