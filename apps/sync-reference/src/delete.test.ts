import assert from "node:assert/strict";
import test from "node:test";
import { acceptedDeleteEnvelope, admissionFingerprint, deleteAdmissionFingerprint, initialReceipt } from "./admission.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceClaim, ReferenceContent, ReferenceEvidence } from "./model.js";

const content: ReferenceContent = { name: "Own host", notes: null, place: "Room", beginsAt: "2026-10-13T08:00:00.000Z", endsAt: "2026-10-13T09:00:00.000Z" };
const input = { bindingId: "own:binding", expectedRevision: 1, commandId: "own:command", operationId: "own:operation" };
const host = { objectId: "own:object", connectionId: "own:connection", calendarId: "own/cal+id", eventId: "own/event+id",
  capture: { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 2 } };
const envelope = () => acceptedDeleteEnvelope(input, content, host);
const present = (etag: string | undefined = '"original"') => ({ id: host.eventId, ...(etag ? { etag } : {}), status: "confirmed", eventType: "default", organizer: { self: true }, attendees: [],
  summary: content.name, description: content.notes, location: content.place, start: { dateTime: content.beginsAt }, end: { dateTime: content.endsAt } });
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
const acl = () => response({ id: host.calendarId, accessRole: "owner" });
function fixture(replies: (Response | Error)[], recovery = false) {
  const admitted = envelope();
  const claim: ReferenceClaim = { operationId: input.operationId, attemptId: "own:attempt", payload: { operationEnvelope: admitted }, envelope: admitted,
    binding: { kind: "event", action: "delete", operationId: input.operationId, commandId: input.commandId, hostObjectId: host.objectId,
      provider: "google", connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId, acceptedRevision: 2,
      sourceEpoch: admitted.sourceEpoch, privacyEpoch: admitted.privacyEpoch }, capture: { ...host.capture }, locator: { connectionId: host.connectionId, calendarId: host.calendarId, eventId: host.eventId },
    etag: '"original"', receipt: initialReceipt(admitted), recovery, deleteAcceptanceStatus: null };
  if (recovery) claim.receipt.provider = { kind: "uncertain" };
  const calls: RequestInit[] = [], evidence: ReferenceEvidence[] = [], completions: unknown[] = [];
  let marks = 0;
  const store: ReferenceRunnerStore = {
    async claim() { return claim; }, async renew() { return true; }, async markDispatch() { marks++; return true; },
    async getSession() { return { accessToken: "owned-token", connectionId: host.connectionId, connectionGeneration: "1", scope: "https://www.googleapis.com/auth/calendar.events", eventWriteAllowed: true }; },
    async recordEvidence(_claim, value) { evidence.push(value); return true; }, async complete() { assert.fail("DELETE cannot UPDATE-complete"); },
    async completeDelete(_claim, value) { completions.push(value); return true; }, async finish() { return true; },
  };
  const ports: ReferenceRunnerPorts = { http: { async fetch(_url, init) { calls.push(init); const next = replies.shift(); assert(next, "Unexpected HTTP"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  const run = () => deliverReferenceOperation(store, input.operationId, ports, { attemptId: claim.attemptId });
  return { claim, calls, evidence, completions, store, ports, run, marks: () => marks };
}
test("DELETE admission pins independent canonical content and body null, action-prefixed idempotency", () => {
  const admitted = envelope(); assert.equal(admitted.operation.action, "delete"); assert.deepEqual(admitted.nativePlan.data, { planKind: "json-body", body: null });
  assert.equal(admitted.hostObjectId, host.objectId); assert.equal(initialReceipt(admitted).provider.kind, "not-dispatched");
  assert.notEqual(deleteAdmissionFingerprint(input), admissionFingerprint({ ...input, patch: { name: "A" } }));
  assert.notEqual(deleteAdmissionFingerprint(input), deleteAdmissionFingerprint({ ...input, expectedRevision: 2 }));
  for (const expectedRevision of [0, Infinity, 1.5]) assert.throws(() => deleteAdmissionFingerprint({ ...input, expectedRevision }));
});
test("fresh DELETE writes once with strong If-Match and exact absence completion, no validator", async () => {
  const f = fixture([response(present()), acl(), response(present()), response(null, 204), response({}, 404)]);
  assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(call => call.method), ["GET", "GET", "GET", "DELETE", "GET"]);
  assert.equal(new Headers(f.calls[3]!.headers).get("if-match"), '"original"'); assert.equal(f.calls[3]!.body, undefined);
  assert.deepEqual(f.completions, [{ kind: "exact-absence", read: { kind: "absent", status: 404 } }]);
  assert.deepEqual(f.evidence.map(value => [value.provider, value.remote]), [["accepted", "unobserved"], ["accepted", "confirmed"]]);
  assert(f.evidence.every(value => value.validator === undefined)); assert.equal(f.evidence[0]!.acceptanceStatus, 204);
});
for (const absent of [response({},404), response({},410), response({ id: host.eventId, status: "cancelled" })])
  test(`GET-only absence ${absent.status} confirms destination without inventing acceptance`, async () => {
    const f = fixture([absent]); assert.equal((await f.run()).status,"acked"); assert.equal(f.calls.length,1); assert.equal(f.marks(),0);
    assert.equal(f.evidence.at(-1)!.provider,"not-dispatched"); assert.equal(f.evidence.at(-1)!.remote,"confirmed");
  });
test("lost DELETE acceptance recovers immediately by GET and retains uncertainty", async () => {
  const f = fixture([response(present()), acl(), response(present()), new Error("Owned lost reply"), response({},410)]);
  assert.equal((await f.run()).status,"acked"); assert.equal(f.calls.filter(call => call.method === "DELETE").length,1);
  assert.equal(f.evidence.at(-1)!.provider,"uncertain"); assert.equal(f.evidence.at(-1)!.acceptanceStatus,undefined);
});
test("restart after possible dispatch uses scoped GET-only absence and preserves known rejection", async () => {
  const f = fixture([response({},404)],true); f.claim.receipt.provider = { kind:"rejected", error:{ code:"rate-limited",retry:"after-delay",retryAfterMs:120000 } };
  assert.equal((await f.run()).status,"acked"); assert.deepEqual(f.calls.map(call=>call.method),["GET"]); assert.equal(f.marks(),0);
  assert.equal(f.evidence[0]!.provider,"rejected"); assert.deepEqual(f.evidence[0]!.error,{code:"rate-limited",retry:"after-delay",retryAfterMs:120000});
});
test("restart preserves separately stored accepted native DELETE status", async () => {
  const f = fixture([response({},410)],true); f.claim.receipt.provider = {kind:"accepted"}; (f.claim as { deleteAcceptanceStatus: number }).deleteAcceptanceStatus = 204;
  assert.equal((await f.run()).status,"acked"); assert.equal(f.evidence[0]!.acceptanceStatus,204); assert.equal(f.calls.length,1);
});
test("changed, missing and weak present ETags refuse DELETE and absence ACK", async () => {
  for(const etag of ['"changed"',"W/weak",undefined]) {
    const data = present(etag); if(etag === undefined) delete data.etag;
    const f = fixture([response(data)],true); assert.notEqual((await f.run()).status,"acked"); assert.equal(f.marks(),0); assert.equal(f.completions.length,0);
    assert(f.calls.every(call=>call.method === "GET"));
  }
});
test("fresh second read detects an ETag race before DELETE", async () => {
  const f = fixture([response(present()),acl(),response(present('"changed"'))]); assert.equal((await f.run()).status,"conflict"); assert.equal(f.marks(),0);
});
test("DELETE refusal preserves protocol rejection and never retries unconditionally", async () => {
  const f = fixture([response(present()),acl(),response(present()),response({},412)]); assert.equal((await f.run()).status,"conflict");
  assert.equal(f.evidence.at(-1)!.provider,"rejected"); assert.equal(f.calls.filter(call=>call.method === "DELETE").length,1); assert.equal(f.completions.length,0);
});
test("reference requires absence after an accepted response", async () => {
  const f = fixture([response(present()),acl(),response(present()),response(null,204),response(present())]); assert.notEqual((await f.run()).status,"acked");
  assert.equal(f.evidence.at(-1)!.provider,"accepted"); assert.equal(f.completions.length,0);
});
test("malformed row action DELETE disagrees with UPDATE payload before credentials", async () => {
  const f = fixture([]); (f.claim.payload as any).operationEnvelope.operation.action = "update";
  f.store.getSession = async () => { assert.fail("Unsupported action cannot open credentials"); };
  assert.equal((await f.run()).status,"hold"); assert.equal(f.calls.length,0);
});
