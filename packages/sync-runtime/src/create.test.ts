import assert from "node:assert/strict";
import test from "node:test";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  runClaimedGooglePersonalCreate, supportsGooglePersonalCreateEnvelope, compareGooglePersonalCreateShadow,
  type ClaimedGooglePersonalCreate, type GooglePersonalCreateHostPorts, type GooglePersonalCreatePolicy,
  type GoogleCreateRuntimeProviderPorts, type RuntimeCreateCompletionEvidence, type RuntimeCreateNativeFacts,
  type RuntimeCreateFinishOutcome, type RuntimeCreateRecordedFrame, type RuntimeCreateDecisionContext,
} from "./index";

const operationId = "00000000-0000-4000-8000-000000000039";
const eventId = `musubi${operationId.replace(/-/g, "")}`;
const musubi: GooglePersonalCreatePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty", nativeProfile: "existing-google", requireStrongReadback: false };
const reference: GooglePersonalCreatePolicy = { completion: "exact-readback", ambiguousRecovery: "within-attempt", compareContent: "literal", nativeProfile: "strict-reference", requireStrongReadback: true };
const event = EventSchema.parse({ id: "canonical", creatorID: "owner", organizer: "", title: "Accepted A", color: "red", calendars: [], isCanceled: false, isAllDay: false,
  start: "2026-10-24T08:00:00Z", end: "2026-10-24T09:00:00Z", description: null, location: "Room" });
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const calendar = () => response({ id: "native/calendar", accessRole: "owner" });
const native = (extra: Record<string, unknown> = {}) => ({ id: eventId, etag: '"created"', status: "confirmed", eventType: "default", summary: event.title,
  description: null, location: "Room", start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() },
  organizer: { self: true }, extendedProperties: { private: { musubiOperationID: operationId } }, ...extra });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(replies: (Response | Error)[], policy: GooglePersonalCreatePolicy = musubi, recovery = false) {
  const encoded = encodeEventV1("google", event, undefined, { action: "create", operationId, acceptedAt: "2026-10-24T07:00:00.000Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    serializer: encoded.serializer, commandId: "command", operationId, hostObjectId: event.id,
    locator: { provider: "google", connectionId: "logical:account", collectionId: "native/calendar", resourceId: eventId },
    sourceEpoch: { sourceId: "source", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private", allowedSideEffects: ["provider-content-write"],
    admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
  const input: ClaimedGooglePersonalCreate = { operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "create", operationId, commandId: envelope.commandId, hostObjectId: event.id,
      provider: "google", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId,
      resourceId: null, acceptedRevision: 2, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:oauth", connectionGeneration: "3", calendarId: "native/calendar", eventId },
    recovery: { required: recovery, possibleDispatch: recovery }, priorProvider: recovery ? { kind: "uncertain" } : { kind: "not-dispatched" } };
  const calls: { url: string; init: RequestInit }[] = [], acks: RuntimeCreateCompletionEvidence[] = [], facts: RuntimeCreateNativeFacts[] = [], finishes: RuntimeCreateFinishOutcome[] = [];
  const frames: RuntimeCreateRecordedFrame[] = [], contexts: RuntimeCreateDecisionContext[] = [];
  let credentials = 0, marks = 0, renewals = 0, observations = 0;
  const host: GooglePersonalCreateHostPorts = {
    async renew() { renewals++; return true; },
    accountSession: { async open(connection) { credentials++; assert.equal(connection.connectionId, "physical:oauth"); return { ...connection, accessToken: "PRIVATE_CREDENTIAL", eventWriteAllowed: true }; } },
    async beforeMutation() { marks++; }, async recordEvidence(value) { facts.push(value); },
    async ack(value) { acks.push(value); return { kind: "acknowledged" }; }, async finish(value) { finishes.push(value); },
    observationId: () => `observation:${++observations}`, recordDecision(context, frame) { contexts.push(context); frames.push(frame); },
  };
  const ports: GoogleCreateRuntimeProviderPorts = { http: { async fetch(url, init) {
    calls.push({ url, init }); const reply = replies.shift(); if (!reply) throw new Error("Unplanned fixture request"); if (reply instanceof Error) throw reply; return reply;
  } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  return { input, envelope, host, ports, calls, acks, facts, finishes, frames, contexts,
    counts: () => ({ credentials, marks, renewals, observations }), run: (options = {}) => runClaimedGooglePersonalCreate(input, host, ports, policy, options) };
}

test("CREATE uses the pinned body and distinct physical session, with each host's completion wire", async () => {
  for (const policy of [musubi, reference]) {
    const f = fixture([calendar(), response({ id: eventId, etag: '"created"' }, 201), ...(policy === reference ? [response(native())] : [])], policy);
    assert.equal((await f.run()).status, "acked");
    assert.deepEqual(f.calls.map(call => call.init.method), policy === reference ? ["GET", "POST", "GET"] : ["GET", "POST"]);
    assert.equal(f.counts().marks, 1); assert.equal(new Headers(f.calls[1]!.init.headers).get("if-match"), null);
    assert.equal(f.calls[1]!.init.body, JSON.stringify(f.envelope.nativePlan.data.body));
    assert.equal(f.acks[0]!.kind, policy === reference ? "exact-readback" : "provider-response");
    assert.equal(f.acks[0]!.eventId, eventId); assert.equal(f.acks[0]!.validator, '"created"');
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE_CREDENTIAL"));
  }
});

test("CREATE Musubi preserves nullable native validators without weakening reference readback", async () => {
  for (const etag of [undefined, null, 'W/"weak"']) {
    const fresh = fixture([calendar(), response({ id: eventId, etag }, 201)]);
    assert.equal((await fresh.run()).status, "acked"); assert.equal(fresh.acks[0]!.validator, null); assert.equal(fresh.calls.length, 2);
    const old = fixture([response(native({ etag }))], musubi, true);
    assert.equal((await old.run()).status, "acked"); assert.equal(old.acks[0]!.validator, null); assert.equal(old.calls.length, 1);
    const strict = fixture([response(native({ etag }))], reference, true);
    assert.equal((await strict.run()).status, "conflict"); assert.equal(strict.acks.length, 0); assert.equal(strict.calls.length, 1);
  }
});

test("lost CREATE reply recovers with exact owned GET and never issues a second POST", async () => {
  const first = fixture([calendar(), new Error("PRIVATE lost reply")]);
  const result = await first.run(); assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "uncertain");
  assert.equal(result.facts.possibleDispatch, true); assert.equal(first.acks.length, 0);
  const recovered = fixture([response(native())], musubi, true);
  assert.equal((await recovered.run()).status, "acked"); assert.deepEqual(recovered.calls.map(call => call.init.method), ["GET"]);
  assert.equal(recovered.acks[0]!.facts.provider.kind, "uncertain");
  const within = fixture([calendar(), new Error("lost"), response(native())], reference);
  assert.equal((await within.run()).status, "acked"); assert.deepEqual(within.calls.map(call => call.init.method), ["GET", "POST", "GET"]);
  assert.equal(within.acks[0]!.facts.provider.kind, "uncertain");
});

test("recovery 404 permits only the same saved planned identity/body after a fresh preflight", async () => {
  const f = fixture([response({}, 404), calendar(), response({ id: eventId }, 201)], musubi, true);
  assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "POST"]);
  assert.equal(f.calls[2]!.init.body, JSON.stringify(f.envelope.nativePlan.data.body));
  assert.equal(JSON.parse(String(f.calls[2]!.init.body)).id, eventId);
});

test("410, cancelled, marker/content/scope mismatches cannot adopt or resend", async () => {
  for (const reply of [response({}, 410), response(native({ status: "cancelled" })), response(native({ id: "foreign" })),
    response(native({ extendedProperties: { private: { musubiOperationID: "foreign" } } })), response(native({ summary: "Changed" })),
    response(native({ start: { dateTime: "2026-10-24T07:00:00Z" } })), response(native({ recurrence: ["RRULE:FREQ=DAILY"] }))]) {
    const f = fixture([reply], musubi, true); const result = await f.run();
    assert.equal(result.status, "conflict"); assert.equal(f.acks.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
    assert.equal(result.facts.provider.kind, "uncertain");
  }
});

test("Musubi nullable/empty comparison stays distinct from strict literal reference", async () => {
  const ordinary = fixture([response(native({ description: "" }))], musubi, true);
  assert.equal((await ordinary.run()).status, "acked");
  const strict = fixture([response(native({ description: "" }))], reference, true);
  assert.equal((await strict.run()).status, "conflict"); assert.equal(strict.acks.length, 0);
});

test("POST 400/409 remain rejected without automatic GET/adoption, and 429 preserves delay", async () => {
  for (const status of [400, 409]) {
    const f = fixture([calendar(), response({}, status)], reference); const result = await f.run();
    assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "rejected"); assert.equal(f.calls.length, 2); assert.equal(f.acks.length, 0);
    assert.equal(result.error!.outcome, "not-written"); assert.equal(result.error!.providerStatus, status);
  }
  const rate = fixture([calendar(), response({}, 429, { "retry-after": "9" })]);
  assert.equal((await rate.run()).status, "hold"); assert.equal(rate.finishes[0]!.retryAfterMs, 9000); assert.equal(rate.calls.length, 2);
});

test("malformed success or5xx remains uncertain; readback404 never resends in the same attempt", async () => {
  for (const reply of [response({ id: "wrong" }, 201), new Response("{", { status: 201 }), response({}, 500)]) {
    const f = fixture([calendar(), reply]); const result = await f.run();
    assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "uncertain"); assert.equal(f.calls.length, 2);
  }
  const exact = fixture([calendar(), new Error("lost"), response({}, 404)], reference);
  assert.equal((await exact.run()).status, "conflict"); assert.equal(exact.calls.filter(call => call.init.method === "POST").length, 1);
});

test("CREATE identity, profile, payload and inconsistent recovery fail before every capability", async () => {
  const mutate: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { (f.input as any).operationId = "opaque-operation"; },
    f => { (f.envelope as any).operationId = "opaque-operation"; },
    f => { (f.envelope.nativePlan.data.body as any).extendedProperties.private.musubiOperationID = "00000000-0000-4000-8000-000000000099"; },
    f => { f.envelope.locator.resourceId = "other"; },
    f => { (f.input.nativeTarget as any).eventId = "other"; },
    f => { f.envelope.admittedProjection.data.title = "Changed"; },
    f => { f.envelope.admittedProjection.data.isAllDay = true; },
    f => { (f.input.payload as any).operationEnvelope.schemaVersion = 2; },
    f => { delete (f.input.payload as any).operationEnvelope; },
    f => { (f.input as any).priorProvider = { kind: "uncertain" }; },
    f => { (f.input as any).recovery = { required: false, possibleDispatch: true }; },
  ];
  for (const change of mutate) {
    const f = fixture([]); let prepared = 0; f.host.prepare = async () => { prepared++; }; change(f);
    assert.equal((await f.run()).status, "hold"); assert.equal(prepared, 0); assert.equal(f.finishes.length, 1);
    assert.deepEqual(f.counts(), { credentials: 0, marks: 0, renewals: 0, observations: 0 }); assert.equal(f.calls.length, 0);
  }
});

test("the complete admitted plan, body order, target and policy are pinned before preparation awaits", async () => {
  const policy = { ...musubi }, f = fixture([calendar(), response({ id: eventId }, 201)], policy);
  const entered = deferred<void>(), resume = deferred<void>();
  f.host.prepare = async () => { entered.resolve(); await resume.promise; };
  const saved = JSON.stringify(f.envelope.nativePlan.data.body), pending = f.run(); await entered.promise;
  (f.envelope.nativePlan.data.body as any).summary = "Late B"; f.envelope.admittedProjection.data.title = "Late B";
  (f.input.nativeTarget as any).eventId = "late"; policy.completion = "exact-readback";
  resume.resolve(); assert.equal((await pending).status, "acked"); assert.equal(f.calls.length, 2); assert.equal(f.calls[1]!.init.body, saved);
});

test("literal policy validation does not invoke coercion hooks", async () => {
  let coercions = 0;
  const policy = { ...musubi, completion: { toString() { coercions++; return "provider-response"; } } } as unknown as GooglePersonalCreatePolicy;
  const f = fixture([], policy); assert.equal((await f.run()).status, "hold"); assert.equal(coercions, 0); assert.equal(f.calls.length, 0);
});

test("ignored initial GET and POST cannot acquire late evidence, ACK or a second dispatch", async () => {
  for (const mutation of [false, true]) {
    const f = fixture(mutation ? [calendar()] : [], reference, !mutation), pending = deferred<Response>(), original = f.ports.http.fetch;
    f.ports.http.fetch = async (url, init) => {
      if (mutation && init.method !== "POST") return original(url, init);
      f.calls.push({ url, init }); return pending.promise;
    };
    const result = await f.run({ timeoutMs: 20, heartbeatMs: 5 });
    assert.equal(result.status, "hold"); assert.equal(result.error!.interruption, "timeout"); assert.equal(f.acks.length, 0); assert.equal(f.finishes.length, 1);
    const before = f.calls.length, renewals = f.counts().renewals;
    pending.resolve(response(mutation ? { id: eventId } : native(), 200)); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.calls.length, before); assert.equal(f.acks.length, 0); assert.equal(f.finishes.length, 1); assert.equal(f.counts().renewals, renewals);
  }
});

test("known atomic CREATE ACK wins a racing timeout and waiting or rejected finish", async () => {
  for (const rejected of [false, true]) {
    const f = fixture([calendar(), response({ id: eventId }, 201)]), ack = deferred<{ kind: "acknowledged" }>(), finish = deferred<void>();
    let finished = false;
    f.host.ack = async () => ack.promise;
    f.host.finish = async () => { finished = true; await finish.promise; if (rejected) throw new Error("lost finish"); };
    const pending = f.run({ timeoutMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(finished, true);
    ack.resolve({ kind: "acknowledged" }); await new Promise(resolve => setTimeout(resolve, 0)); finish.resolve();
    assert.equal((await pending).status, "acked"); assert.equal(f.calls.length, 2);
  }
});

test("CREATE shadow decisions replay without credentials, HTTP or host effects", async () => {
  const f = fixture([calendar(), response({ id: eventId }, 201), response(native())], reference);
  assert.equal((await f.run()).status, "acked"); const before = f.calls.length;
  assert.deepEqual(compareGooglePersonalCreateShadow(f.contexts[0]!, f.frames), { matches: true, compared: f.frames.length, mismatches: [] });
  assert.equal(f.calls.length, before);
  const changed = structuredClone(f.frames); changed[0] = { ...changed[0]!, authoritative: { ...changed[0]!.authoritative, decision: "hold" } };
  assert.equal(compareGooglePersonalCreateShadow(f.contexts[0]!, changed).matches, false);
  assert.equal(supportsGooglePersonalCreateEnvelope(f.envelope), true);
});
