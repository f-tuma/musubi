import assert from "node:assert/strict";
import test from "node:test";
import { acceptedGraphDeleteEnvelope, graphDeleteAdmissionFingerprint, deleteAdmissionFingerprint, graphDeleteEtag, initialReceipt, REFERENCE_GRAPH_DELETE_PROFILE } from "./admission.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceClaim, ReferenceContent, ReferenceEvidence } from "./model.js";

const content: ReferenceContent = { name: "Guarded synthetic DELETE", notes: null, place: "Room", beginsAt: "2026-10-24T08:00:00.000Z", endsAt: "2026-10-24T09:00:00.000Z" };
const input = { bindingId: "graph:binding", expectedRevision: 1, commandId: "graph:command", operationId: "graph:operation" };
const host = { objectId: "graph:object", connectionId: "graph:connection", calendarId: "own/calendar+id", eventId: "native/event+id",
  capture: { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 2 } };
const etag = 'W/"accepted-native-version"';
const envelope = () => acceptedGraphDeleteEnvelope(input, content, host);
const native = (overrides = {}) => ({ id: host.eventId, "@odata.etag": etag, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, isAllDay: false,
  recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, subject: content.name,
  body: { contentType: "text", content: "" }, location: { displayName: content.place },
  start: { dateTime: "2026-10-24T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-24T09:00:00.0000000", timeZone: "UTC" }, ...overrides });
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const guards = () => [response(native()), response({ id: "graph-native-owner", mail: "owner@example.test", userPrincipalName: "owner@example.test" }),
  response({ id: host.calendarId, canEdit: true, owner: { address: "owner@example.test" } }), response(native())];
function fixture(replies: (Response | Error)[], recovery = false) {
  const admitted = envelope();
  const claim: ReferenceClaim = { operationId: input.operationId, attemptId: "graph:attempt", payload: { operationEnvelope: admitted }, envelope: admitted,
    binding: { kind: "event", action: "delete", operationId: input.operationId, commandId: input.commandId, hostObjectId: host.objectId, provider: "microsoft",
      connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId, acceptedRevision: 2, sourceEpoch: admitted.sourceEpoch, privacyEpoch: admitted.privacyEpoch },
    capture: { ...host.capture }, locator: { connectionId: host.connectionId, calendarId: host.calendarId, eventId: host.eventId }, etag,
    endpointProfile: REFERENCE_GRAPH_DELETE_PROFILE, attemptNumber: recovery ? 2 : 1, receipt: initialReceipt(admitted), recovery, deleteAcceptanceStatus: null };
  if (recovery) claim.receipt.provider = { kind: "uncertain" };
  const calls: { url: string; init: RequestInit }[] = [], evidence: ReferenceEvidence[] = [], completions: unknown[] = [], finishes: unknown[] = [];
  let sessions = 0, marks = 0, mismatch = false;
  const store: ReferenceRunnerStore = {
    async claim() { return claim; }, async renew() { return true; }, async markDispatch() { marks++; return true; },
    async getSession() { sessions++; return { accessToken: "synthetic-graph-token", connectionId: host.connectionId, connectionGeneration: "1", scope: "Calendars.ReadWrite", eventWriteAllowed: true }; },
    async recordEvidence(_claim, value) { evidence.push(value); return true; }, async finish(_claim, status, outcome) { finishes.push({ status, ...outcome }); return true; },
    async complete() { assert.fail("Graph DELETE cannot use Google UPDATE completion"); }, async completeDelete() { assert.fail("Graph DELETE cannot use Google absence completion"); },
    async completeGraphDelete(_claim, observation) { completions.push(observation); return true; },
  };
  const ports: ReferenceRunnerPorts = { http: { async fetch(url, init) { calls.push({ url, init }); const next = replies.shift(); if (!next) { mismatch = true; throw new Error("Unplanned synthetic HTTP"); } if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  const run = async () => { const result = await deliverReferenceOperation(store, input.operationId, ports, { attemptId: claim.attemptId }); assert.equal(mismatch, false); assert.equal(replies.length, 0); return result; };
  return { claim, store, calls, evidence, completions, finishes, run, counts: () => ({ sessions, marks }) };
}
test("Graph DELETE has its own immutable serializer, profile fingerprint and original weak ETag", () => {
  const admitted = envelope(); assert.equal(admitted.locator.provider, "microsoft"); assert.equal(admitted.serializer.id, "microsoft-personal-event");
  assert.deepEqual(admitted.nativePlan.data, { planKind: "json-body", body: null }); assert.notEqual(graphDeleteAdmissionFingerprint(input), deleteAdmissionFingerprint(input));
  assert.equal(graphDeleteEtag(etag), true); for (const value of ['"strong"', "changeKey", "W/empty", null]) assert.equal(graphDeleteEtag(value), false);
});
test("fresh guarded DELETE performs one native guard pass, retains best-effort If-Match and requires exact 404", async () => {
  const f = fixture([...guards(), response(null, 204), response({}, 404)]); assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "GET", "GET", "DELETE", "GET"]);
  assert.equal(new Headers(f.calls[4]!.init.headers).get("if-match"), etag); assert.equal(f.calls[4]!.init.body, undefined); assert.equal(f.counts().marks, 1);
  assert.deepEqual(f.completions, [{ kind: "exact-absence", read: { kind: "absent", status: 404 } }]); assert.equal(f.evidence.at(-1)!.provider, "accepted"); assert.equal(f.evidence.at(-1)!.acceptanceStatus, 204);
});
test("early exact scoped 404 confirms absence without native dispatch or invented acceptance", async () => {
  const f = fixture([response({}, 404)]); assert.equal((await f.run()).status, "acked"); assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
  assert.equal(f.evidence.at(-1)!.provider, "not-dispatched"); assert.equal(f.evidence.at(-1)!.remote, "confirmed");
});
test("lost reply with observed absence ACKs after one DELETE and preserves uncertainty", async () => {
  const f = fixture([...guards(), new Error("Owned lost reply"), response({}, 404)]); assert.equal((await f.run()).status, "acked");
  assert.equal(f.calls.filter(call => call.init.method === "DELETE").length, 1); assert.equal(f.evidence.at(-1)!.provider, "uncertain");
});
test("lost reply with a retained same-version event stays HOLD and never resends", async () => {
  const f = fixture([...guards(), new Error("Owned lost reply"), response(native())]); assert.equal((await f.run()).status, "hold");
  assert.equal(f.calls.filter(call => call.init.method === "DELETE").length, 1); assert.equal(f.completions.length, 0); assert.equal(f.evidence.at(-1)!.remote, "conflict");
});
test("every possible-dispatch presence remains observe-only irrespective of native version", async () => {
  for (const version of [etag, 'W/"new-version"', null, '"strong-is-not-native"']) {
    const f = fixture([response(native({ "@odata.etag": version }))], true); assert.equal((await f.run()).status, "hold");
    assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]); assert.equal(f.counts().marks, 0); assert.equal(f.completions.length, 0);
  }
});
test("possible-dispatch exact absence preserves previous native acceptance or uncertainty", async () => {
  for (const accepted of [false, true]) {
    const f = fixture([response({}, 404)], true);
    if (accepted) { f.claim.receipt.provider = { kind: "accepted" }; (f.claim as { deleteAcceptanceStatus: number }).deleteAcceptanceStatus = 204; }
    assert.equal((await f.run()).status, "acked"); assert.equal(f.calls.length, 1); assert.equal(f.evidence.at(-1)!.provider, accepted ? "accepted" : "uncertain");
  }
});
test("410 and fresh changed-version reads never become Graph absence or mutation permission", async () => {
  const gone = fixture([response({}, 410)], true); assert.notEqual((await gone.run()).status, "acked"); assert.equal(gone.completions.length, 0);
  const changed = fixture([response(native({ "@odata.etag": 'W/"changed"' }))]); assert.equal((await changed.run()).status, "conflict"); assert.equal(changed.counts().marks, 0);
});
test("wrong explicit provider/profile or payload cannot fall back to the Google writer", async () => {
  const wrongProfile = fixture([]); (wrongProfile.claim as { endpointProfile: string }).endpointProfile = "google-personal-event-delete-v1";
  assert.equal((await wrongProfile.run()).status, "hold"); assert.equal(wrongProfile.counts().sessions, 0);
  const wrongPayload = fixture([]); (wrongPayload.claim.payload as { operationEnvelope: { serializer: { id: string } } }).operationEnvelope.serializer.id = "google-personal-event";
  assert.equal((await wrongPayload.run()).status, "hold"); assert.equal(wrongPayload.counts().sessions, 0);
});
test("reference cannot gain a resolution exception through untrusted extra claim properties", async () => {
  const f = fixture([response(native())], true);
  Object.assign(f.claim, { attemptNumber: 1, resolution: { expectedRemoteExists: true, expectedRemoteEtag: etag } });
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().marks, 0); assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]);
});
test("Graph completion capability is required before credentials and HTTP", async () => {
  const f = fixture([]); delete f.store.completeGraphDelete; assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0);
});
test("429 preserves Retry-After and a rejected operation remains observe-only on a later claim", async () => {
  const f = fixture([...guards(), response({}, 429, { "retry-after": "9" })]); assert.equal((await f.run()).status, "hold");
  assert.equal((f.finishes.at(-1) as { retryAfterMs: number }).retryAfterMs, 9000); assert.equal(f.evidence.at(-1)!.provider, "rejected");
  const recovery = fixture([response(native())], true); recovery.claim.receipt.provider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 } };
  assert.equal((await recovery.run()).status, "hold"); assert.equal(recovery.counts().marks, 0); assert.equal(recovery.evidence.at(-1)!.provider, "rejected");
});
