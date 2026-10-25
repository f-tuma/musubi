import assert from "node:assert/strict";
import test from "node:test";
import { decodeSyncOperationPayload } from "@musubi/types";
import { supportsMicrosoftPersonalCreateEnvelope } from "@musubi/sync-runtime";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { acceptedGraphCreateEnvelope, createAdmissionFingerprint, graphCreateAdmissionFingerprint, initialReceipt } from "./admission.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceClaim, ReferenceGraphCreateEvidence } from "./model.js";

const content = { name: "Exact Graph CREATE", notes: " Exact note ", place: " Room ", beginsAt: "2026-10-25T08:00:00.123Z", endsAt: "2026-10-25T09:00:00.456Z" };
const input = { bindingId: "graph:create:binding", expectedRevision: 1, commandId: "graph:create:command", operationId: "d24e77f9-ce35-4b75-a048-61e77a2e1b9c" };
const host = { objectId: "independent:object", connectionId: "graph:create:connection", calendarId: "native/calendar+id",
  capture: { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 1 } };
test("reference Graph CREATE uses the actual codec with UUID transactionId and permanently unknown admitted native ID", () => {
  const envelope = acceptedGraphCreateEnvelope(input, content, host), plan = parseNativeWritePlanV1(envelope.serializer, "create", "event", envelope.nativePlan.data);
  assert.equal(envelope.locator.provider, "microsoft"); assert.equal(envelope.locator.resourceId, null); assert.equal(envelope.serializer.id, "microsoft-personal-event");
  assert.equal(plan?.planKind, "json-body"); if (!plan || plan.planKind !== "json-body" || !plan.body) assert.fail("Real Graph CREATE plan missing");
  assert.equal(plan.body.transactionId, input.operationId); assert.equal(Object.hasOwn(plan.body, "id"), false);
  assert.deepEqual(plan.body.body, { contentType: "text", content: content.notes }); assert.equal(envelope.admittedProjection.data.description, "Exact note"); assert.equal(envelope.admittedProjection.data.location, "Room");
  assert.equal(envelope.admittedProjection.data.start, content.beginsAt); assert.equal(envelope.admittedProjection.data.end, content.endsAt); assert.equal(matchesPinnedProjectionV1(envelope.serializer, "create", envelope.admittedProjection.data, plan), true);
  assert.notEqual(graphCreateAdmissionFingerprint(input), createAdmissionFingerprint(input));
  assert.equal(initialReceipt(envelope).provider.kind, "not-dispatched"); assert.equal(initialReceipt(envelope).remote.kind, "unobserved");
});
test("new Graph CREATE reference identity is a canonical UUID; provider IDs never come from an attempt or host object", () => {
  for (const operationId of ["opaque-old-id", input.operationId.toUpperCase(), "not-a-uuid"]) assert.throws(() => acceptedGraphCreateEnvelope({ ...input, operationId }, content, host));
  const first = acceptedGraphCreateEnvelope(input, content, host), second = acceptedGraphCreateEnvelope(input, content, { ...host, objectId: "a-different-host-object" });
  assert.deepEqual(first.nativePlan, second.nativePlan); assert.equal(second.locator.resourceId, null);
});
test("decoder rejects a later guessed native ID instead of adopting it into the admitted binding", () => {
  const envelope = acceptedGraphCreateEnvelope(input, content, host);
  const binding = { kind: "event" as const, action: "create" as const, operationId: input.operationId, commandId: input.commandId, hostObjectId: host.objectId, provider: "microsoft" as const,
    connectionId: host.connectionId, collectionId: host.calendarId, resourceId: null, acceptedRevision: 2, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch };
  assert.equal(decodeSyncOperationPayload({ operationEnvelope: envelope }, binding, { supports: supportsMicrosoftPersonalCreateEnvelope }).kind, "pinned-v1");
  assert.notEqual(decodeSyncOperationPayload({ operationEnvelope: { ...envelope, locator: { ...envelope.locator, resourceId: "guessed-returned-id" } } }, binding, { supports: supportsMicrosoftPersonalCreateEnvelope }).kind, "pinned-v1");
});

const nativeId = "returned-native-id", native = (changes = {}) => ({ id: nativeId, transactionId: input.operationId, subject: content.name,
  body: { contentType: "text", content: content.notes }, location: { displayName: content.place }, isAllDay: false, recurrence: null,
  start: { dateTime: content.beginsAt, timeZone: "UTC" }, end: { dateTime: content.endsAt, timeZone: "UTC" }, type: "singleInstance", isCancelled: false,
  isOrganizer: true, isDraft: false, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, "@odata.etag": 'W/"readback-version"', ...changes });
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
const guards = () => [response({ id: "self-native", mail: "owner@example.test", userPrincipalName: "owner@example.test" }), response({ id: host.calendarId, canEdit: true, owner: { address: "OWNER@example.test" } })];
type Reply = Response | Error | ((init: RequestInit) => Response);
/** A real Graph server normally returns HTML unless the caller requests text. */
const listing = (event = native(), ignorePreference = false): Reply => init => {
  const requested = new Headers(init.headers).get("prefer")?.includes('outlook.body-content-type="text"');
  return response({ value: [{ ...event, body: requested && !ignorePreference ? event.body : { contentType: "html", content: "<p>Exact note</p>" } }] });
};
function fixture(replies: Reply[], recovery = false) {
  const envelope = acceptedGraphCreateEnvelope(input, content, host);
  const claim: ReferenceClaim = { operationId: input.operationId, attemptId: "graph:create:attempt", payload: { operationEnvelope: envelope }, envelope,
    binding: { kind: "event", action: "create", provider: "microsoft", operationId: input.operationId, commandId: input.commandId, hostObjectId: host.objectId,
      connectionId: host.connectionId, collectionId: host.calendarId, resourceId: null, acceptedRevision: 2, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    locator: { connectionId: host.connectionId, calendarId: host.calendarId, eventId: null }, etag: null, capture: host.capture,
    receipt: initialReceipt(envelope), recovery, endpointProfile: "microsoft-personal-event-create-v1", graphCreate: { candidateEventId: null, acceptanceStatus: null, acceptanceValidator: null } };
  if (recovery) claim.receipt.provider = { kind: "uncertain" };
  const calls: { url: string; init: RequestInit }[] = [], evidence: ReferenceGraphCreateEvidence[] = [], completions: unknown[] = [], finishes: unknown[] = [];
  let sessions = 0, marks = 0, mismatch = false;
  const store: ReferenceRunnerStore = {
    async claim() { return claim; }, async renew() { return true; }, async getSession() { sessions++; return { accessToken: "synthetic-graph-token", connectionId: host.connectionId, connectionGeneration: "1", scope: "Calendars.ReadWrite", eventWriteAllowed: true }; },
    async markDispatch() { marks++; return true; }, async recordEvidence() { assert.fail("Graph CREATE cannot use Google/DELETE evidence port"); }, async recordGraphCreateEvidence(_claim, facts) { evidence.push(facts); return true; },
    async complete() { assert.fail("Graph CREATE cannot use Google UPDATE completion"); }, async completeDelete() { assert.fail("Graph CREATE cannot use Google DELETE completion"); }, async completeCreate() { assert.fail("Graph CREATE cannot use Google CREATE completion"); },
    async completeGraphCreate(_claim, observation) { completions.push(observation); return true; }, async finish(_claim, status, outcome) { finishes.push({ status, ...outcome }); return true; },
  };
  const ports: ReferenceRunnerPorts = { http: { async fetch(url, init) { calls.push({ url, init }); const next = replies.shift(); if (!next) { mismatch = true; throw new Error("Unexpected synthetic native request"); } if (next instanceof Error) throw next; return typeof next === "function" ? next(init) : next; } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  const run = async () => { const result = await deliverReferenceOperation(store, input.operationId, ports); assert.equal(mismatch, false); assert.equal(replies.length, 0); return result; };
  return { claim, store, ports, calls, evidence, completions, finishes, run, counts: () => ({ sessions, marks }) };
}
test("actual reference Graph CREATE proves owner, posts the pinned UUID body and requests plain-text correlated readback", async () => {
  const f = fixture([...guards(), response({ id: nativeId, "@odata.etag": "raw-not-a-conditional-validator" }, 201), listing()]); assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(c => c.init.method), ["GET", "GET", "POST", "GET"]); assert.equal(f.counts().marks, 1);
  assert.deepEqual(JSON.parse(f.calls[2]!.init.body as string), acceptedGraphCreateEnvelope(input, content, host).nativePlan.data.body);
  assert.equal(new Headers(f.calls[3]!.init.headers).get("prefer")?.includes('outlook.body-content-type="text"'), true);
  assert.deepEqual(f.evidence[0]!.createAcceptance, { status: 201, validator: "raw-not-a-conditional-validator" }); assert.equal(f.evidence[0]!.candidateEventId, nativeId);
  assert.equal(f.completions.length, 1); assert.equal((f.completions[0] as { correlation: { matches: number } }).correlation.matches, 1); assert.equal(f.claim.binding.resourceId, null); assert.equal(f.claim.locator.eventId, null);
});
test("HTML despite explicit text preference refuses adoption while retaining the native acceptance fact", async () => {
  const f = fixture([...guards(), response({ id: nativeId, "@odata.etag": "raw-metadata" }, 201), listing(native(), true)]); assert.equal((await f.run()).status, "conflict");
  assert.equal(f.completions.length, 0); assert.equal(f.evidence.at(-1)!.provider, "accepted"); assert.equal(f.evidence.at(-1)!.createAcceptance?.validator, "raw-metadata"); assert.equal(f.calls.filter(c => c.init.method === "POST").length, 1);
});
test("uncertain unique recovery is collection-read-only and captures an observed candidate without invented acceptance", async () => {
  const f = fixture([listing()], true); assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(c => c.init.method), ["GET"]); assert.equal(f.counts().marks, 0);
  assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.evidence.at(-1)!.candidateEventId, nativeId); assert.equal(f.evidence.at(-1)!.createAcceptance, undefined);
});
test("missing complete correlation never permits replay or produces native absence confirmation", async () => {
  const f = fixture([response({ value: [] })], true); assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().marks, 0); assert.equal(f.completions.length, 0); assert.equal(f.evidence.at(-1)!.remote, "conflict");
});
test("duplicate markers and incomplete scoped listing cannot select a first candidate or POST", async () => {
  for (const body of [{ value: [native(), native({ id: "second-native-id" })] }, { value: [native()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/other/events?page=2" }]) {
    const f = fixture([response(body)], true); assert.notEqual((await f.run()).status, "acked"); assert.equal(f.counts().marks, 0); assert.equal(f.completions.length, 0);
  }
});
test("accepted or durably observed candidate identity survives uncertainty and cannot be replaced by a later unique ID", async () => {
  for (const accepted of [false, true]) {
    const f = fixture([listing(native({ id: "different-native-id" }))], true); f.claim.graphCreate!.candidateEventId = nativeId;
    if (accepted) { f.claim.receipt.provider = { kind: "accepted" }; f.claim.graphCreate!.acceptanceStatus = 201; f.claim.graphCreate!.acceptanceValidator = "raw-original"; }
    assert.equal((await f.run()).status, "conflict"); assert.equal(f.completions.length, 0); assert.equal(f.counts().marks, 0);
  }
});
test("native nullable readback validator is explicit without requiring a Google strong validator", async () => {
  const f = fixture([...guards(), response({ id: nativeId }, 201), listing(native({ "@odata.etag": null }))]); assert.equal((await f.run()).status, "acked"); assert.equal((f.completions[0] as { etag: unknown }).etag, null);
});
test("Graph CREATE capabilities and exact null admitted locator are required before any account session", async () => {
  for (const missing of ["evidence", "completion", "identity"]) {
    const f = fixture([]); if (missing === "evidence") delete f.store.recordGraphCreateEvidence; else if (missing === "completion") delete f.store.completeGraphCreate; else (f.claim.locator as { eventId: string | null }).eventId = "guessed";
    assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0);
  }
});
test("known rejection respects Retry-After and later read-only recovery never repeats POST", async () => {
  const rejected = fixture([...guards(), response({}, 429, { "retry-after": "9" })]); assert.equal((await rejected.run()).status, "hold"); assert.equal((rejected.finishes.at(-1) as { retryAfterMs: number }).retryAfterMs, 9000);
  const later = fixture([response({ value: [] })], true); later.claim.receipt.provider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 } }; assert.equal((await later.run()).status, "hold"); assert.equal(later.counts().marks, 0); assert.equal(later.completions.length, 0);
});
