import assert from "node:assert/strict";
import test from "node:test";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  runClaimedCaldavPersonalDelete, compareCaldavPersonalDeleteShadow,
  type ClaimedCaldavPersonalDelete, type CaldavPersonalDeletePolicy, type CaldavPersonalDeleteHostPorts,
  type CaldavDeleteRuntimeProviderPorts, type CaldavRuntimeDeleteNativeFacts, type CaldavRuntimeDeleteCompletionEvidence,
  type CaldavRuntimeDeleteFinishOutcome, type CaldavRuntimeDeleteRecordedFrame, type CaldavRuntimeDeleteDecisionContext,
} from "./index";
const collection = "https://dav.example.invalid/calendar/", resource = collection + "native.ics", uid = "accepted:uid";
const native = (identifier = uid) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Fixture//EN\r\nBEGIN:VEVENT\r\nUID:${identifier}\r\nDTSTART:20261013T080000Z\r\nDTEND:20261013T090000Z\r\nSUMMARY:NATIVE_CONTENT_PRIVATE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const response = (body: string | null, status = 200, etag?: string) => new Response(body, { status, headers: etag ? { etag } : {} });
const point = (etag = '"before"') => response(native(), 200, etag);
const acl = () => response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${collection}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 207);
const fresh = () => [point(), acl(), point(), response(null, 204)];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reference: CaldavPersonalDeletePolicy = { completion: "exact-absence", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", observeConflict: false };
function fixture(responses: (Response | Error)[] = [], policy: CaldavPersonalDeletePolicy = {
  completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-caldav", observeConflict: true,
}) {
  const event = EventSchema.parse({ id: "object:one", creatorID: "synthetic:user", organizer: "synthetic:user", calendars: ["calendar:one"],
    title: "Accepted", description: null, location: null, start: "2026-10-13T08:00:00.000Z", end: "2026-10-13T09:00:00.000Z", color: "#112233", isAllDay: false, isCanceled: false });
  const encoded = encodeEventV1("caldav", event, undefined, { action: "delete", operationId: "abcdef01-abcd-4000-8000-abcdefabcdef", uid, acceptedAt: "2026-10-13T07:00:00.000Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ ...encoded, schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "delete", version: 1 },
    commandId: "command:one", operationId: "opaque:delete:operation", hostObjectId: event.id,
    locator: { provider: "caldav", connectionId: "logical:account", collectionId: collection, resourceId: resource },
    sourceEpoch: { sourceId: "source:one", generation: 1 }, acceptedRevision: 2, privacyEpoch: "privacy:one", allowedSideEffects: ["provider-content-write"] });
  const input: ClaimedCaldavPersonalDelete = { operationId: envelope.operationId, attemptId: "attempt:one", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "delete", operationId: envelope.operationId, commandId: envelope.commandId, hostObjectId: event.id,
      provider: "caldav", connectionId: envelope.locator.connectionId, collectionId: collection, resourceId: resource, acceptedRevision: 2,
      sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account-row", connectionGeneration: "123456789", calendarUrl: collection, resourceUrl: resource, uid },
    acceptedEtag: '"before"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
  const calls: { url: string; init: RequestInit }[] = [], evidence: CaldavRuntimeDeleteNativeFacts[] = [], acks: CaldavRuntimeDeleteCompletionEvidence[] = [];
  const finishes: CaldavRuntimeDeleteFinishOutcome[] = [], frames: CaldavRuntimeDeleteRecordedFrame[] = [], contexts: CaldavRuntimeDeleteDecisionContext[] = [];
  let sessions = 0, marks = 0, dns = 0, identifiers = 0;
  const host: CaldavPersonalDeleteHostPorts = {
    async renew() { return true; }, accountSession: { async open(scope) { sessions++; return { ...scope, authorization: "Basic " + Buffer.from("fixture:SECRET_NEVER_LOGGED").toString("base64") }; } },
    async beforeMutation() { marks++; }, async recordEvidence(value) { evidence.push(value); },
    async ack(value) { acks.push(value); return { kind: "acknowledged" }; }, async finish(value) { finishes.push(value); },
    observationId() { return `observation:${++identifiers}`; }, recordDecision(context, frame) { contexts.push(context); frames.push(frame); },
  };
  const ports: CaldavDeleteRuntimeProviderPorts = {
    network: { allowPrivate: true, async lookupImpl() { dns++; return [{ address: "127.0.0.1", family: 4 }]; } },
    http: { async fetchPinned(url, init) { calls.push({ url: url.href, init }); const next = responses.shift(); assert.ok(next, "Unexpected HTTP capability"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  };
  const run = (options = {}) => runClaimedCaldavPersonalDelete(input, host, ports, policy, options);
  return { input, host, ports, calls, evidence, acks, finishes, frames, contexts, policy, run, counts: () => ({ sessions, marks, dns, identifiers }) };
}

test("DAV policies preserve Musubi response completion and reference exact absence", async () => {
  for (const policy of [undefined, reference]) {
    const f = fixture([...fresh(), ...(policy ? [response(null, 404)] : [])], policy);
    const result = await f.run(); assert.equal(result.status, "acked");
    assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), policy ? ["GET", "PROPFIND", "GET", "DELETE", "GET"] : ["GET", "PROPFIND", "GET", "DELETE"]);
    assert.equal(f.acks[0]!.kind, policy ? "exact-absence" : "provider-response");
    assert.equal(new Headers(f.calls[3]!.init.headers).get("if-match"), '"before"');
    assert.equal(f.calls[3]!.init.body, undefined); assert.equal(f.counts().marks, 1);
  }
});

test("DAV plan UID, address and policy are captured before host preparation", async () => {
  const f = fixture(fresh()); f.host.prepare = async () => {
    Object.assign(f.input.nativeTarget, { uid: "other", resourceUrl: collection + "other.ics", connectionId: "wrong" });
    Object.assign(f.policy, reference); return { acceptedUid: uid, acceptedEtag: '"before"' };
  };
  const result = await f.run(); assert.equal(result.status, "acked"); assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3]!.url, resource); assert.equal(f.counts().marks, 1);
});

test("DAV invalid selected admissions block every prepare, session, DNS and HTTP capability", async () => {
  for (const mutate of [
    (i: any) => { i.nativeTarget.uid = "different"; }, (i: any) => { i.binding.provider = "google"; },
    (i: any) => { i.nativeTarget.resourceUrl = collection + "other.ics"; },
    (i: any) => { i.payload.operationEnvelope.nativePlan.data = { planKind: "json-body", body: null }; },
    (i: any) => { i.payload.operationEnvelope.admittedProjection.data.isAllDay = true; },
    (i: any) => { i.payload.operationEnvelope.admittedProjection.data.recurrence = "RRULE:FREQ=DAILY"; },
    (i: any) => { i.payload.operationEnvelope.allowedSideEffects.push("provider-notification"); },
    (i: any) => { i.priorProvider = { kind: "accepted", status: 410 }; },
  ]) {
    const f = fixture(); let prepares = 0; f.host.prepare = async () => { prepares++; return { acceptedUid: uid, acceptedEtag: '"before"' }; };
    mutate(f.input); assert.equal((await f.run()).status, "hold"); assert.equal(prepares, 0);
    assert.deepEqual(f.counts(), { sessions: 0, marks: 0, dns: 0, identifiers: 0 }); assert.equal(f.calls.length, 0);
  }
});

test("DAV prepared UID cannot rebase the frozen admitted resource identity", async () => {
  const f = fixture(); f.host.prepare = async () => ({ acceptedUid: "other", acceptedEtag: '"before"' });
  assert.equal((await f.run()).error?.code, "operation-envelope-binding-mismatch");
  assert.equal(f.counts().sessions, 0); assert.equal(f.counts().dns, 0); assert.equal(f.calls.length, 0);
});

test("DAV uncertain conditional replay sends only the original UID, address and strong tag", async () => {
  const f = fixture(fresh()); Object.assign(f.input, { recovery: { required: true, possibleDispatch: true }, priorProvider: { kind: "uncertain" } });
  assert.equal((await f.run()).status, "acked"); assert.equal(f.counts().marks, 1);
  assert.equal(new Headers(f.calls[3]!.init.headers).get("if-match"), '"before"'); assert.equal(f.calls[3]!.url, resource);
});

test("DAV changed, missing or weak current validators never select a write", async () => {
  for (const etag of ['"changed"', 'W/"before"', undefined]) {
    const f = fixture([response(native(), 200, etag)]); assert.equal((await f.run()).status, "conflict");
    assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
  }
});

test("DAV initial404 proves scoped absence while preflight404 never ACKs", async () => {
  const absent = fixture([response(null, 404)]); const result = await absent.run(); assert.equal(result.status, "acked");
  assert.deepEqual(result.facts.provider, { kind: "not-dispatched" }); assert.equal(absent.calls.length, 1); assert.equal(absent.counts().marks, 0);
  const late = fixture([point(), acl(), response(null, 404)]); const failed = await late.run();
  assert.equal(failed.status, "hold"); assert.equal(failed.error?.code, "capability-evidence"); assert.equal(late.acks.length, 0); assert.equal(late.counts().marks, 0);
});

test("DAV host normalizer failure remains before native preflight and its data is private", async () => {
  const f = fixture([point()]); f.host.validateObservation = () => { throw new Error("PRIVATE_BODY_INVALID"); };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_BODY_INVALID"));
});

test("DAV timeout fences signal-ignoring preparation before any credential or DNS", async () => {
  const f = fixture(); const held = deferred<{ acceptedEtag: unknown; acceptedUid: unknown }>(); f.host.prepare = () => held.promise;
  assert.equal((await f.run({ timeoutMs: 12, heartbeatMs: 1000 })).status, "hold"); held.resolve({ acceptedUid: uid, acceptedEtag: '"before"' }); await pause(5);
  assert.equal(f.counts().sessions, 0); assert.equal(f.counts().dns, 0); assert.equal(f.calls.length, 0);
});

test("DAV timeout fences a signal-ignoring DNS lookup before pinned HTTP", async () => {
  const f = fixture(); const held = deferred<{ address: string; family: number }[]>(); Object.assign(f.ports.network, { lookupImpl: () => held.promise });
  assert.equal((await f.run({ timeoutMs: 12, heartbeatMs: 1000 })).status, "hold"); held.resolve([{ address: "127.0.0.1", family: 4 }]); await pause(5);
  assert.equal(f.calls.length, 0); assert.equal(f.counts().marks, 0);
});

test("DAV lease loss fences a signal-ignoring native GET continuation", async () => {
  const f = fixture(); const held = deferred<Response>(); let calls = 0; f.ports.http.fetchPinned = () => { calls++; return held.promise; }; f.host.renew = async () => false;
  assert.equal((await f.run({ timeoutMs: 1000, heartbeatMs: 5 })).error?.interruption, "lease-lost");
  held.resolve(point()); await pause(5); assert.equal(calls, 1); assert.equal(f.counts().marks, 0); assert.equal(f.acks.length, 0);
});

test("DAV timeout during durable dispatch marking cannot acquire a detached DELETE", async () => {
  const f = fixture(fresh()); const held = deferred<void>(); f.host.beforeMutation = () => held.promise;
  assert.equal((await f.run({ timeoutMs: 15, heartbeatMs: 1000 })).status, "hold"); held.resolve(); await pause(5);
  assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), ["GET", "PROPFIND", "GET"]); assert.equal(f.acks.length, 0);
});

test("DAV known atomic ACK wins a timeout racing host finish", async () => {
  const f = fixture([response(null, 404)]), ack = deferred<any>(), finishing = deferred<void>(), started = deferred<void>();
  f.host.ack = () => ack.promise; f.host.finish = async () => { started.resolve(); await finishing.promise; throw new Error("PRIVATE_FINISH_FAILURE"); };
  const running = f.run({ timeoutMs: 12, heartbeatMs: 1000 }); await started.promise; ack.resolve({ kind: "acknowledged" }); await pause(2); finishing.resolve();
  assert.equal((await running).status, "acked"); assert.equal(f.calls.length, 1);
});

test("DAV shadow replay has no capability and traces exclude Basic credentials and ICS", async () => {
  const f = fixture(fresh()); const result = await f.run(); assert.equal(result.status, "acked");
  assert.equal(compareCaldavPersonalDeleteShadow(f.contexts[0]!, f.frames).matches, true);
  const altered = f.frames.map((frame, i) => i ? frame : { ...frame, authoritative: { decision: "hold" as const } });
  assert.equal(compareCaldavPersonalDeleteShadow(f.contexts[0]!, altered).matches, false); assert.equal(f.calls.length, 4);
  assert.ok(!JSON.stringify(result.trace).includes("NATIVE_CONTENT_PRIVATE")); assert.ok(!JSON.stringify(result).includes("SECRET_NEVER_LOGGED"));
});
