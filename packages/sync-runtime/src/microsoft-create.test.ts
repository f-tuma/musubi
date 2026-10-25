import assert from "node:assert/strict";
import test from "node:test";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  runClaimedMicrosoftPersonalCreate, supportsMicrosoftPersonalCreateEnvelope, projectMicrosoftCreatedEvent,
  compareMicrosoftPersonalCreateShadow, type ClaimedMicrosoftPersonalCreate, type MicrosoftPersonalCreateHostPorts,
  type MicrosoftPersonalCreatePolicy, type MicrosoftCreateRuntimeProviderPorts, type MicrosoftRuntimeCreateCompletionEvidence,
  type MicrosoftRuntimeCreateNativeFacts, type MicrosoftRuntimeCreateFinishOutcome,
  type MicrosoftRuntimeCreateRecordedFrame, type MicrosoftRuntimeCreateDecisionContext,
} from "./index";

const operationId = "00000000-0000-4000-8000-000000000039", eventId = "graph-assigned-id";
const musubi: MicrosoftPersonalCreatePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-microsoft" };
const reference: MicrosoftPersonalCreatePolicy = { completion: "correlated-readback", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference" };
const event = EventSchema.parse({ id: "canonical", creatorID: "owner", organizer: "", title: "Accepted A", color: "red", calendars: [], isCanceled: false,
  isAllDay: false, start: "2026-10-25T08:00:00Z", end: "2026-10-25T09:00:00Z", description: "Notes", location: "Room" });
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const calendar = () => response({ canEdit: true, id: "native/calendar", owner: { address: "owner@example.test" } });
const me = () => response({ id: "self", mail: "owner@example.test" });
const native = (extra: Record<string, unknown> = {}) => ({ id: eventId, transactionId: operationId, "@odata.etag": 'W/"created"', subject: event.title,
  body: { contentType: "text", content: "Notes" }, location: { displayName: "Room" },
  start: { dateTime: "2026-10-25T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-25T09:00:00.0000000", timeZone: "UTC" },
  isAllDay: false, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null,
  attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, ...extra });
const listing = (items = [native()]) => response({ value: items });
const guards = (policy: MicrosoftPersonalCreatePolicy) => policy.nativeProfile === "strict-reference" ? [me(), calendar()] : [calendar()];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(replies: (Response | Error)[], policy: MicrosoftPersonalCreatePolicy = musubi, recovery = false) {
  const encoded = encodeEventV1("microsoft", event, undefined, { action: "create", operationId, acceptedAt: "2026-10-25T07:00:00.000Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    serializer: encoded.serializer, commandId: "command", operationId, hostObjectId: event.id,
    locator: { provider: "microsoft", connectionId: "logical:account", collectionId: "native/calendar", resourceId: null },
    sourceEpoch: { sourceId: "source", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private", allowedSideEffects: ["provider-content-write"],
    admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
  const input: ClaimedMicrosoftPersonalCreate = { operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "create", operationId, commandId: envelope.commandId, hostObjectId: event.id, provider: "microsoft",
      connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: null, acceptedRevision: 2,
      sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:oauth", connectionGeneration: "3", calendarId: "native/calendar" },
    recovery: { required: recovery, possibleDispatch: recovery }, priorProvider: recovery ? { kind: "uncertain" } : { kind: "not-dispatched" } };
  const calls: { url: string; init: RequestInit }[] = [], acks: MicrosoftRuntimeCreateCompletionEvidence[] = [], facts: MicrosoftRuntimeCreateNativeFacts[] = [],
    finishes: MicrosoftRuntimeCreateFinishOutcome[] = [], frames: MicrosoftRuntimeCreateRecordedFrame[] = [], contexts: MicrosoftRuntimeCreateDecisionContext[] = [];
  let credentials = 0, marks = 0, renewals = 0, observations = 0, normalizations = 0;
  const host: MicrosoftPersonalCreateHostPorts = {
    async renew() { renewals++; return true; },
    accountSession: { async open(connection) { credentials++; assert.equal(connection.connectionId, "physical:oauth");
      return { ...connection, accessToken: "PRIVATE_CREDENTIAL", eventWriteAllowed: true }; } },
    async beforeMutation() { marks++; }, normalizeObservation(read) { normalizations++; return projectMicrosoftCreatedEvent(read.event); },
    async recordEvidence(value) { facts.push(value); }, async ack(value) { acks.push(value); return { kind: "acknowledged" }; },
    async finish(value) { finishes.push(value); }, observationId: () => `observation:${++observations}`,
    recordDecision(context, frame) { contexts.push(context); frames.push(frame); },
  };
  const ports: MicrosoftCreateRuntimeProviderPorts = { http: { async fetch(url, init) {
    calls.push({ url, init }); const reply = replies.shift(); if (!reply) throw new Error("Unplanned fixture request"); if (reply instanceof Error) throw reply; return reply;
  } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  return { input, envelope, host, ports, calls, acks, facts, finishes, frames, contexts,
    counts: () => ({ credentials, marks, renewals, observations, normalizations }),
    run: (options = {}) => runClaimedMicrosoftPersonalCreate(input, host, ports, policy, options) };
}

test("Graph CREATE sends the actual admitted body and adopts only provider-assigned identity", async () => {
  for (const policy of [musubi, reference]) {
    const f = fixture([...guards(policy), response({ id: eventId, "@odata.etag": 'W/"created"' }, 201), ...(policy === reference ? [listing()] : [])], policy);
    assert.equal((await f.run()).status, "acked");
    assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), policy === reference ? ["GET", "GET", "POST", "GET"] : ["GET", "POST"]);
    const post = f.calls.find(call => call.init.method === "POST")!;
    assert.equal(post.init.body, JSON.stringify(f.envelope.nativePlan.data.body)); assert.equal(new Headers(post.init.headers).has("if-match"), false);
    assert.equal(JSON.parse(String(post.init.body)).transactionId, operationId); assert.equal(f.envelope.locator.resourceId, null);
    assert.equal(f.acks[0]!.eventId, eventId); assert.equal(f.counts().marks, 1);
    assert.equal(f.counts().normalizations, policy === reference ? 1 : 0);
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE_CREDENTIAL"));
  }
});

test("fresh ID-only response preserves arbitrary string or null native versions without normalization", async () => {
  for (const etag of [undefined, null, "", "arbitrary opaque", '"strong"', 'W/"weak"']) {
    const f = fixture([calendar(), response({ id: eventId, "@odata.etag": etag }, 201)]);
    f.host.normalizeObservation = () => { throw new Error("Fresh response must not be normalized"); };
    assert.equal((await f.run()).status, "acked"); assert.equal(f.acks[0]!.validator, typeof etag === "string" ? etag : null); assert.equal(f.calls.length, 2);
  }
});

test("strict readback allows native weak or null versions and retains raw acceptance separately", async () => {
  for (const etag of [null, 'W/"weak"']) {
    const f = fixture([...guards(reference), response({ id: eventId, "@odata.etag": "raw acceptance" }, 201), listing([native({ "@odata.etag": etag })])], reference);
    const result = await f.run(); assert.equal(result.status, "acked"); assert.equal(f.acks[0]!.validator, etag);
    assert.deepEqual(result.facts.provider, { kind: "accepted", eventId, validator: "raw acceptance", status: 201 });
  }
  const f = fixture([...guards(reference), response({ id: eventId, "@odata.etag": "raw acceptance" }, 201), listing([native({ "@odata.etag": '"strong"' })])], reference);
  const result = await f.run(); assert.equal(result.status, "conflict"); assert.equal(result.facts.provider.kind, "accepted"); assert.equal(f.acks.length, 0);
});

test("lost reply uses a complete unique correlation and never sends another POST", async () => {
  for (const policy of [musubi, reference]) {
    const f = fixture([...guards(policy), new Error("PRIVATE lost reply"), ...(policy === reference ? [listing()] : [])], policy);
    const result = await f.run(); assert.equal(result.status, policy === reference ? "acked" : "hold"); assert.equal(result.facts.provider.kind, "uncertain");
    assert.equal(f.calls.filter(call => call.init.method === "POST").length, 1);
  }
  const recovery = fixture([listing()], musubi, true); assert.equal((await recovery.run()).status, "acked");
  assert.deepEqual(recovery.calls.map(call => call.init.method ?? "GET"), ["GET"]); assert.equal(recovery.acks[0]!.facts.provider.kind, "uncertain");
});

test("zero, duplicate, partial, unsafe-page and failed listing never grant CREATE replay", async () => {
  const next = "https://graph.microsoft.com/v1.0/me/calendars/native%2Fcalendar/events?$skiptoken=2";
  for (const replies of [[listing([])], [listing([native(), native()])], [response({ value: [native()] }, 206)],
    [response({ value: [native()], "@odata.nextLink": "https://foreign.invalid/events" })],
    [response({ value: [native()], "@odata.nextLink": next }), response({}, 500)], [response({}, 404)], [response({}, 410)]]) {
    const f = fixture(replies, musubi, true); const result = await f.run(); assert.notEqual(result.status, "acked");
    assert.equal(f.counts().marks, 0); assert.equal(f.acks.length, 0); assert.equal(f.calls.some(call => call.init.method === "POST"), false);
    assert.equal(result.facts.provider.kind, "uncertain");
  }
  const missing = fixture([listing([])], musubi, true), result = await missing.run();
  assert.equal(result.error!.code, "runtime-create-outcome-unknown"); assert.equal(result.facts.remote.kind, "missing");
});

test("saved native acceptance cannot be rebound to another correlated resource ID", async () => {
  const f = fixture([listing([native({ id: "different-id" })])], reference, true);
  (f.input as any).priorProvider = { kind: "accepted", eventId, validator: null, status: 201 };
  const result = await f.run(); assert.equal(result.status, "conflict"); assert.equal(f.acks.length, 0); assert.equal(f.counts().marks, 0);
  assert.deepEqual(result.facts.provider, { kind: "accepted", eventId, validator: null, status: 201 });
});

test("actual host normalization runs before comparison and its raw failure remains host-local", async () => {
  const f = fixture([listing()], musubi, true), error = new TypeError("PRIVATE invalid native content");
  f.host.normalizeObservation = () => { throw error; };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(f.finishes[0]!.cause, error); assert.equal(f.counts().marks, 0);
  assert.equal(f.acks.length, 0); assert.ok(!JSON.stringify(result).includes("PRIVATE invalid native content"));
});

test("a durable correlated candidate remains pinned without inventing provider acceptance", async () => {
  for (const same of [true, false]) {
    const f = fixture([listing([native({ id: same ? eventId : "replacement" })])], reference, true);
    (f.input as any).priorCandidateEventId = eventId;
    const result = await f.run(); assert.equal(result.status, same ? "acked" : "conflict");
    assert.equal(result.facts.provider.kind, "uncertain"); assert.equal(f.counts().marks, 0);
    assert.equal(f.acks.length, same ? 1 : 0);
  }
  const invalid = fixture([]); (invalid.input as any).priorCandidateEventId = eventId;
  assert.equal((await invalid.run()).status, "hold"); assert.equal(invalid.counts().credentials, 0);
});

test("malformed selected family, nonnull admitted ID and changed transaction identity have zero capabilities", async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { (f.input as any).operationId = "opaque"; }, f => { (f.envelope as any).operationId = "opaque"; },
    f => { (f.envelope.nativePlan.data.body as any).transactionId = "00000000-0000-4000-8000-000000000099"; },
    f => { f.envelope.locator.resourceId = eventId; }, f => { (f.input.binding as any).resourceId = eventId; },
    f => { f.envelope.admittedProjection.data.title = "Changed"; }, f => { f.envelope.admittedProjection.data.isAllDay = true; },
    f => { f.envelope.admittedProjection.data.recurrence = "FREQ=DAILY"; }, f => { (f.input.payload as any).operationEnvelope.schemaVersion = 2; },
    f => { (f.input as any).priorProvider = { kind: "uncertain" }; }, f => { (f.input as any).recovery = { required: false, possibleDispatch: true }; },
  ];
  for (const mutate of mutations) {
    const f = fixture([]); let prepared = 0; f.host.prepare = async () => { prepared++; }; mutate(f);
    assert.equal((await f.run()).status, "hold"); assert.equal(prepared, 0); assert.equal(f.finishes.length, 1);
    assert.deepEqual(f.counts(), { credentials: 0, marks: 0, renewals: 0, observations: 0, normalizations: 0 }); assert.equal(f.calls.length, 0);
  }
});

test("admitted body, collection, policy and prior candidate are captured before preparation awaits", async () => {
  const policy = { ...musubi }, f = fixture([calendar(), response({ id: eventId }, 201)], policy), entered = deferred<void>(), resume = deferred<void>();
  f.host.prepare = async () => { entered.resolve(); await resume.promise; };
  const body = JSON.stringify(f.envelope.nativePlan.data.body), running = f.run(); await entered.promise;
  (f.envelope.nativePlan.data.body as any).subject = "Late"; (f.input.nativeTarget as any).calendarId = "late"; policy.completion = "correlated-readback";
  resume.resolve(); assert.equal((await running).status, "acked"); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.init.body, body); assert.ok(f.calls[1]!.url.includes("native%2Fcalendar"));
});

test("known rejections retain native status and delay while ambiguous results remain uncertain", async () => {
  for (const status of [400, 401, 403, 408, 409, 412, 429]) {
    const f = fixture([calendar(), response({}, status, { "retry-after": "9" })]); const result = await f.run();
    assert.equal(result.status, status === 412 ? "conflict" : "hold"); assert.equal(result.facts.provider.kind, "rejected");
    assert.equal(result.error!.outcome, "not-written"); assert.equal(result.error!.providerStatus, status); assert.equal(f.calls.length, 2);
    if (status === 429) assert.equal(f.finishes[0]!.retryAfterMs, 9000);
  }
  for (const reply of [response({}, 201), response({}, 202), response({}, 500), new Error("lost")]) {
    const f = fixture([calendar(), reply]); const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "uncertain");
  }
});

test("preparation, signal-ignoring credentials and late HTTP cannot continue after timeout", async () => {
  for (const blocked of ["prepare", "credentials", "read", "post"] as const) {
    const f = fixture(blocked === "post" ? [calendar()] : [], musubi, blocked === "read"), gate = deferred<any>(), original = f.ports.http.fetch;
    if (blocked === "prepare") f.host.prepare = async () => gate.promise;
    else if (blocked === "credentials") f.host.accountSession.open = async () => gate.promise;
    else f.ports.http.fetch = async (url, init) => {
      if (blocked === "post" && init.method !== "POST") return original(url, init);
      f.calls.push({ url, init }); return gate.promise;
    };
    const result = await f.run({ timeoutMs: 20, heartbeatMs: 5 }); assert.equal(result.status, "hold"); assert.equal(result.error!.interruption, "timeout");
    const before = f.calls.length; gate.resolve(blocked === "credentials" ? { ...f.input.nativeTarget, accessToken: "late", eventWriteAllowed: true } : response({ id: eventId }));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, before); assert.equal(f.acks.length, 0); assert.equal(f.finishes.length, 1);
  }
});

test("lease loss and slow normalization fence acceptance, evidence and ACK", async () => {
  for (const lease of [false, true]) {
    const f = fixture([listing()], musubi, true), gate = deferred<any>(); f.host.normalizeObservation = async () => gate.promise;
    if (lease) f.host.renew = async () => false;
    const result = await f.run({ timeoutMs: 30, heartbeatMs: 5 });
    assert.equal(result.error!.interruption, lease ? "lease-lost" : "timeout");
    gate.resolve(projectMicrosoftCreatedEvent(native())); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.acks.length, 0); assert.equal(f.facts.length, 0); assert.equal(f.counts().marks, 0);
  }
});

test("a durable before-dispatch marker wins no authority after an ignored timeout", async () => {
  const f = fixture([calendar()]), gate = deferred<void>(); f.host.beforeMutation = async () => gate.promise;
  const result = await f.run({ timeoutMs: 20, heartbeatMs: 5 }); assert.equal(result.status, "hold");
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, 1); assert.equal(f.acks.length, 0);
});

test("a known committed ACK wins a racing timeout without a later finish", async () => {
  const f = fixture([calendar(), response({ id: eventId }, 201)]), entered = deferred<void>(), release = deferred<void>();
  f.host.checkpoint = async phase => { if (phase === "afterAck") { entered.resolve(); await release.promise; } };
  const running = f.run({ timeoutMs: 30, heartbeatMs: 5 }); await entered.promise;
  assert.equal((await running).status, "acked"); assert.equal(f.acks.length, 1); assert.equal(f.finishes.length, 0); release.resolve();
});

test("private pure replay has no native capabilities and preserves evaluated context", async () => {
  const f = fixture([listing()], reference, true); assert.equal((await f.run()).status, "acked");
  assert.equal(supportsMicrosoftPersonalCreateEnvelope(f.envelope), true);
  assert.equal(compareMicrosoftPersonalCreateShadow(f.contexts[0]!, f.frames).matches, true);
  const before = f.calls.length; for (let n = 0; n < 100; n++) assert.equal(compareMicrosoftPersonalCreateShadow(f.contexts[0]!, f.frames).matches, true);
  assert.equal(f.calls.length, before); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE_CREDENTIAL"));
  assert.equal(compareMicrosoftPersonalCreateShadow(f.contexts[0]!, [...f.frames, { ...f.frames[0]!, authoritative: { decision: "dispatch" } }]).matches, false);
});
