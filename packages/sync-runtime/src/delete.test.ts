import assert from "node:assert/strict";
import test from "node:test";
import { SyncOperationEnvelopeSchema } from "@musubi/types";
import {
  runClaimedGooglePersonalDelete, compareGooglePersonalDeleteShadow, evaluateGooglePersonalDeleteFact, SyncRuntimeHostError,
  type ClaimedGooglePersonalDelete, type GooglePersonalDeleteHostPorts, type GooglePersonalDeletePolicy,
  type GoogleDeleteRuntimeProviderPorts, type RuntimeDeleteCompletionEvidence, type RuntimeDeleteNativeFacts,
  type RuntimeDeleteFinishOutcome, type RuntimeDeleteRecordedFrame, type RuntimeDeleteDecisionContext,
} from "./index";
const reference: GooglePersonalDeletePolicy = { completion: "exact-absence", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", observeConflict: false };
const musubi: GooglePersonalDeletePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-google", observeConflict: true };
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
const native = (etag: string = '"before"') => ({ id: "native/event", etag, status: "confirmed", eventType: "default", summary: "OLD_CONTENT_NEVER_IN_RESULT_TRACE",
  start: { dateTime: "2026-10-13T08:00:00Z" }, end: { dateTime: "2026-10-13T09:00:00Z" }, organizer: { self: true, email: "owner@test.example" } });
const calendar = () => response({ id: "native/calendar", accessRole: "writer" });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(responses: (Response | Error)[], policy: GooglePersonalDeletePolicy = reference) {
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "delete", version: 1 },
    serializer: { id: "google-personal-event", version: 1 }, commandId: "command:one", operationId: "operation:one", hostObjectId: "object:one",
    locator: { provider: "google", connectionId: "logical:account", collectionId: "native/calendar", resourceId: "native/event" },
    sourceEpoch: { sourceId: "source:one", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:one", allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: { title: "Accepted", description: null, location: null, start: "2026-10-13T08:00:00.000Z", end: "2026-10-13T09:00:00.000Z", isAllDay: false, recurrence: null } },
    nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: null } } });
  const input: ClaimedGooglePersonalDelete = { operationId: envelope.operationId, attemptId: "attempt:one", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "delete", operationId: envelope.operationId, commandId: envelope.commandId, hostObjectId: envelope.hostObjectId,
      provider: "google", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: envelope.locator.resourceId,
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account-row", connectionGeneration: "11", calendarId: "native/calendar", eventId: "native/event" },
    acceptedEtag: '"before"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
  const calls: { url: string; init: RequestInit }[] = [], evidence: RuntimeDeleteNativeFacts[] = [], finishes: RuntimeDeleteFinishOutcome[] = [];
  const frames: RuntimeDeleteRecordedFrame[] = [], contexts: RuntimeDeleteDecisionContext[] = [], acks: RuntimeDeleteCompletionEvidence[] = [];
  let sessions = 0, marks = 0, renewals = 0, identifiers = 0;
  const host: GooglePersonalDeleteHostPorts = {
    async renew() { renewals++; return true; }, accountSession: { async open(scope) { sessions++; assert.equal(scope.connectionId, "physical:account-row"); return { ...scope, accessToken: "CREDENTIAL_PRIVATE", eventWriteAllowed: true }; } },
    async beforeMutation() { marks++; }, async recordEvidence(facts) { evidence.push(facts); }, async ack(value) { acks.push(value); return { kind: "acknowledged" }; },
    async finish(value) { finishes.push(value); }, observationId() { return `observation:${++identifiers}`; }, recordDecision(context, frame) { contexts.push(context); frames.push(frame); },
  };
  const ports: GoogleDeleteRuntimeProviderPorts = { http: { async fetch(url, init) { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error("Unexpected dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  const run = (options = {}) => runClaimedGooglePersonalDelete(input, host, ports, policy, options);
  return { input, host, ports, calls, evidence, finishes, frames, contexts, acks, run, counts: () => ({ sessions, marks, renewals, identifiers }) };
}

test("DELETE host policies share exact read/preflight/dispatch and differ only at completion", async () => {
  for (const policy of [musubi, reference]) {
    const f = fixture([response(native()), calendar(), response(native()), response({}, 204), ...(policy === reference ? [response({}, 404)] : [])], policy);
    const result = await f.run(); assert.equal(result.status, "acked");
    assert.deepEqual(f.calls.map(c => c.init.method), policy === musubi ? ["GET", "GET", "GET", "DELETE"] : ["GET", "GET", "GET", "DELETE", "GET"]);
    assert.ok(f.calls[0]!.url.endsWith("/calendars/native%2Fcalendar/events/native%2Fevent"));
    assert.ok(f.calls[1]!.url.endsWith("/users/me/calendarList/native%2Fcalendar"));
    assert.equal(f.acks[0]!.kind, policy === musubi ? "provider-response" : "exact-absence");
    assert.deepEqual(result.facts.provider, { kind: "accepted", status: 204 }); assert.equal(f.counts().marks, 1);
    assert.equal(new Headers(f.calls[3]!.init.headers).get("if-match"), '"before"'); assert.equal(f.calls[3]!.init.body, undefined);
    assert.ok(!JSON.stringify(result.trace).includes("OLD_CONTENT_NEVER_IN_RESULT_TRACE")); assert.ok(!JSON.stringify(result).includes("CREDENTIAL_PRIVATE"));
  }
});

test("a refused Google conditional DELETE retry preserves older native facts", async () => {
  for (const policy of [musubi, reference]) for (const prior of ["uncertain", "accepted"] as const) for (const status of [412, 429]) {
    const observesConflict = policy.observeConflict && status === 412;
    const f = fixture([response(native()), calendar(), response(native()), response({}, status, { "retry-after": "9" }), ...(observesConflict ? [response(native())] : [])], policy);
    const priorProvider = prior === "accepted" ? { kind: "accepted" as const, status: 204 as const } : { kind: "uncertain" as const };
    Object.assign(f.input, { recovery: { required: true, possibleDispatch: true }, priorProvider });
    const result = await f.run(); assert.deepEqual(result.facts.provider, priorProvider); assert.equal(result.facts.possibleDispatch, true);
    if (!observesConflict) { assert.equal(result.error?.providerStatus, status); assert.equal(result.error?.outcome, "not-written"); }
    else assert.equal(result.status, "conflict");
    assert.equal(f.calls.length, observesConflict ? 5 : 4); assert.equal(f.acks.length, 0);
    if (status === 429) assert.equal(f.finishes[0]!.retryAfterMs, 9000);
  }
});

test("a lost Google conditional DELETE retry preserves earlier acceptance", async () => {
  for (const policy of [musubi, reference]) {
    const f = fixture([response(native()), calendar(), response(native()), new Error("owned lost retry"), ...(policy === reference ? [response({}, 404)] : [])], policy);
    Object.assign(f.input, { recovery: { required: true, possibleDispatch: true }, priorProvider: { kind: "accepted", status: 204 } });
    const result = await f.run(); assert.deepEqual(result.facts.provider, { kind: "accepted", status: 204 }); assert.equal(result.facts.possibleDispatch, true);
    assert.equal(result.status, policy === reference ? "acked" : "hold"); assert.equal(f.calls.filter(call => call.init.method === "DELETE").length, 1);
  }
});

test("DELETE exact absence ACK skips ACL and mutation without fabricating acceptance or validator", async () => {
  for (const observed of [response({}, 404), response({}, 410), response({ id: "native/event", status: "cancelled" })]) {
    const f = fixture([observed], musubi); const result = await f.run(); assert.equal(result.status, "acked"); assert.equal(f.calls.length, 1);
    assert.equal(f.acks[0]!.kind, "exact-absence"); assert.deepEqual(result.facts.provider, { kind: "not-dispatched" });
    assert.equal(result.facts.remote.kind, "absent"); assert.equal(result.facts.possibleDispatch, false); assert.equal(f.counts().marks, 0);
    assert.ok(!JSON.stringify(f.acks[0]).includes("validator")); assert.ok(!JSON.stringify(f.acks[0]).includes("projection"));
  }
});

test("DELETE remote weak/missing/changed strong tag conflicts after exactly one GET", async () => {
  for (const etag of [undefined, null, 'W/"weak"', '"changed"']) {
    const value = { ...native(), etag }; const f = fixture([response(value)], musubi); const result = await f.run();
    assert.equal(result.status, "conflict"); assert.equal(result.error!.phase, "recovery-read"); assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
    assert.equal(result.facts.remote.kind, "conflict"); assert.equal(result.facts.provider.kind, "not-dispatched"); assert.equal(f.finishes.length, 1);
  }
});

test("DELETE admitted envelope/plan/binding failures HOLD before every host capability", async () => {
  for (const mutate of [(i: any) => { i.binding.action = "update"; }, (i: any) => { i.binding.resourceId = "other"; },
    (i: any) => { i.payload.operationEnvelope.schemaVersion = 2; }, (i: any) => { delete i.payload.operationEnvelope; },
    (i: any) => { i.payload.operationEnvelope.nativePlan.data.body = {}; }, (i: any) => { i.nativeTarget.calendarId = "other"; },
    (i: any) => { i.payload.operationEnvelope.admittedProjection.data.isAllDay = true; }, (i: any) => { i.payload.operationEnvelope.admittedProjection.data.recurrence = "RRULE:FREQ=DAILY"; },
    (i: any) => { i.payload.operationEnvelope.allowedSideEffects.push("provider-notification"); }, (i: any) => { i.payload.operationEnvelope.locator.resourceId = null; }]) {
    const f = fixture([]); let prepares = 0; f.host.prepare = async () => { prepares++; return { acceptedEtag: '"before"' }; }; mutate(f.input);
    assert.equal((await f.run()).status, "hold"); assert.equal(prepares, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.counts(), { sessions: 0, marks: 0, renewals: 0, identifiers: 0 }); assert.equal(f.finishes.length, 1);
  }
});

test("DELETE synchronous snapshot pins payload, binding, target, policy and prior native rejection", async () => {
  const policy = { ...reference }, f = fixture([response(native()), calendar(), response(native()), response({}, 204), response({}, 410)], policy);
  const entered = deferred<void>(), resume = deferred<void>(); f.host.prepare = async () => { entered.resolve(); await resume.promise; return { acceptedEtag: '"before"' }; };
  const pending = f.run(); await entered.promise;
  (f.input.payload as any).operationEnvelope.nativePlan.data.body = { poison: true }; (f.input.payload as any).operationEnvelope.admittedProjection.data.isAllDay = true;
  f.input.binding.collectionId = "late"; (f.input.nativeTarget as any).eventId = "late"; policy.completion = "provider-response";
  resume.resolve(); assert.equal((await pending).status, "acked"); assert.equal(f.calls.length, 5); assert.ok(f.calls[3]!.url.endsWith("native%2Fevent"));
  const prior = fixture([response({}, 429, { "retry-after": "30" })]);
  (prior.input as any).priorProvider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 1000 } };
  const enteredPrior = deferred<void>(), resumePrior = deferred<void>(); prior.host.prepare = async () => { enteredPrior.resolve(); await resumePrior.promise; return { acceptedEtag: '"before"' }; };
  const waiting = prior.run(); await enteredPrior.promise; (prior.input.priorProvider as any).error.code = "conflict"; resumePrior.resolve();
  assert.deepEqual((await waiting).facts.provider, { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 1000 } });
});

test("DELETE predecessor validator alone may resolve inside one existing lifecycle", async () => {
  const f = fixture([response(native('"successor"')), calendar(), response(native('"successor"')), response({}, 204)], musubi);
  f.host.prepare = async () => ({ acceptedEtag: '"successor"' }); assert.equal((await f.run()).status, "acked");
  assert.equal(new Headers(f.calls[3]!.init.headers).get("if-match"), '"successor"');
  const invalid = fixture([]); (invalid.input as any).acceptedEtag = 'W/"weak"'; assert.equal((await invalid.run()).status, "hold"); assert.equal(invalid.calls.length, 0);
});

test("DELETE late preflight absence completes and version change cannot mutate", async () => {
  const absent = fixture([response(native()), calendar(), response({}, 404)], musubi); const result = await absent.run();
  assert.equal(result.status, "acked"); assert.equal(absent.calls.length, 3); assert.equal(absent.counts().marks, 0); assert.equal(result.facts.provider.kind, "not-dispatched");
  const changed = fixture([response(native()), calendar(), response(native('"changed"'))], reference);
  assert.equal((await changed.run()).status, "conflict"); assert.equal(changed.counts().marks, 0); assert.equal(changed.calls.length, 3);
});

test("DELETE lost reply is deferred in Musubi and exact absence is observed within reference's same budget", async () => {
  const old = fixture([response(native()), calendar(), response(native()), new Error("lost SECRET")], musubi); const ordinary = await old.run();
  assert.equal(ordinary.status, "hold"); assert.equal(ordinary.facts.provider.kind, "uncertain"); assert.equal(old.calls.length, 4); assert.equal(old.acks.length, 0);
  const exact = fixture([response(native()), calendar(), response(native()), new Error("lost SECRET"), response({}, 404)]); const result = await exact.run();
  assert.equal(result.status, "acked"); assert.equal(result.facts.provider.kind, "uncertain"); assert.equal(result.facts.remote.kind, "absent"); assert.equal(exact.calls.length, 5);
  assert.equal(exact.calls.filter(c => c.init.method === "DELETE").length, 1); assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("DELETE explicit 412 rejection and actual mutation rate/reconnect metadata remain independent from later GET", async () => {
  const conflict = fixture([response(native()), calendar(), response(native()), response({}, 412), response(native())], musubi);
  const result = await conflict.run(); assert.equal(result.status, "conflict"); assert.deepEqual(result.facts.provider, { kind: "rejected", error: { code: "conflict", retry: "never" } });
  assert.equal(conflict.calls.filter(c => c.init.method === "DELETE").length, 1); assert.equal(conflict.calls.length, 5);
  const rate = fixture([response(native()), calendar(), response(native()), response({}, 429, { "retry-after": "9" })]);
  assert.equal((await rate.run()).status, "hold"); assert.equal(rate.finishes[0]!.retryAfterMs, 9000);
  assert.deepEqual(rate.finishes[0]!.facts.provider, { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 } });
  for (const status of [401, 403]) {
    const f = fixture([response(native()), calendar(), response(native()), response({}, status)]); assert.equal((await f.run()).status, "hold");
    assert.equal(f.finishes[0]!.retryAfterMs, Infinity); assert.deepEqual(f.finishes[0]!.facts.provider, { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } });
  }
});

test("DELETE present readback conflicts while preserving accepted or uncertain provider fact", async () => {
  for (const reply of [response({}, 204), new Error("lost")]) {
    const f = fixture([response(native()), calendar(), response(native()), reply, response(native('"after"'))]); const result = await f.run();
    assert.equal(result.status, "conflict"); assert.equal(result.facts.provider.kind, reply instanceof Error ? "uncertain" : "accepted"); assert.equal(result.facts.remote.kind, "conflict");
    assert.equal(f.calls.filter(c => c.init.method === "DELETE").length, 1); assert.equal(f.acks.length, 0);
  }
});

test("DELETE every exact-read failure preserves independent prior acceptance, uncertainty or rejection", async () => {
  for (const prior of [{ kind: "accepted", status: 204 }, { kind: "uncertain" }, { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 1000 } }] as const) {
    const f = fixture([response({}, 429, { "retry-after": "30" })]); (f.input as any).priorProvider = prior;
    (f.input as any).recovery = { required: true, possibleDispatch: true }; const result = await f.run();
    assert.equal(result.status, "hold"); assert.deepEqual(result.facts.provider, prior); assert.equal(f.calls.length, 1);
    const absence = fixture([response({}, 404)]); (absence.input as any).priorProvider = prior; (absence.input as any).recovery = { required: true, possibleDispatch: true };
    assert.deepEqual((await absence.run()).facts.provider, prior); assert.equal(absence.acks.length, 1);
  }
});

test("DELETE credential failure before actual dispatch cannot become native rejection or reference recovery", async () => {
  const f = fixture([response(native()), calendar(), response(native())]); const local = new SyncRuntimeHostError({ code: "host-session-failed", outcome: "unconfirmed", providerStatus: 401 });
  let opened = 0; const open = f.host.accountSession.open; f.host.accountSession.open = async (...args) => { if (++opened === 3) throw local; return open(...args); };
  (f.input as any).priorProvider = { kind: "accepted", status: 204 }; (f.input as any).recovery = { required: true, possibleDispatch: true };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.error!.phase, "credentials"); assert.deepEqual(result.facts.provider, { kind: "accepted", status: 204 });
  assert.equal(f.calls.length, 3); assert.equal(f.counts().marks, 0); assert.equal(f.finishes[0]!.cause, local);
});

test("DELETE timeout races ignored initial GET and bars every late capability", async () => {
  const f = fixture([]), late = deferred<Response>(); f.ports.http.fetch = async (url, init) => { f.calls.push({ url, init }); return late.promise; };
  const result = await f.run({ timeoutMs: 20, heartbeatMs: 5 }); assert.equal(result.error!.interruption, "timeout"); assert.equal(f.finishes.length, 1);
  const renewals = f.counts().renewals; late.resolve(response(native())); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.calls.length, 1); assert.equal(f.counts().renewals, renewals); assert.equal(f.evidence.length, 0); assert.equal(f.acks.length, 0); assert.equal(f.finishes.length, 1);
});

test("DELETE timeout races ignored mutation and cannot acquire late evidence/read/ACK/finish", async () => {
  const f = fixture([response(native()), calendar(), response(native())]), late = deferred<Response>(), fetch = f.ports.http.fetch;
  f.ports.http.fetch = async (url, init) => { if (init.method !== "DELETE") return fetch(url, init); f.calls.push({ url, init }); return late.promise; };
  const result = await f.run({ timeoutMs: 20 }); assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "uncertain"); assert.equal(f.finishes.length, 1);
  late.resolve(response({}, 204)); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.calls.length, 4); assert.equal(f.evidence.length, 0); assert.equal(f.acks.length, 0); assert.equal(f.finishes.length, 1);
});

test("DELETE host prepare timeout, lease loss, and known atomic ACK share C06's bounded lifecycle", async () => {
  const prepare = fixture([]), pending = deferred<{ acceptedEtag: string }>(); prepare.host.prepare = () => pending.promise;
  assert.equal((await prepare.run({ timeoutMs: 20 })).status, "hold"); pending.resolve({ acceptedEtag: '"before"' }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(prepare.calls.length, 0);
  const lease = fixture([]); lease.host.renew = async () => false; lease.ports.http.fetch = () => new Promise(() => {});
  assert.equal((await lease.run({ timeoutMs: 100, heartbeatMs: 5 })).error!.interruption, "lease-lost"); assert.equal(lease.finishes.length, 1);
  const ack = fixture([response({}, 404)]), controller = new AbortController();
  ack.host.ack = async () => { controller.abort(); return { kind: "acknowledged" }; };
  assert.equal((await ack.run({ signal: controller.signal })).status, "acked"); assert.equal(ack.finishes.length, 0);
});

test("DELETE policy snapshot and capability-free shadow compare saved decisions with no side effects", async () => {
  const f = fixture([response(native()), calendar(), response(native()), response({}, 204)], musubi); assert.equal((await f.run()).status, "acked");
  const counts = { calls: f.calls.length, ...f.counts(), evidence: f.evidence.length, acks: f.acks.length };
  assert.equal(Object.isFrozen(f.contexts[0]), true); assert.equal(Object.isFrozen(f.frames[0]!.fact), true);
  assert.equal(compareGooglePersonalDeleteShadow(f.contexts[0]!, f.frames).matches, true);
  const corrupted = f.frames.map(frame => ({ ...frame, authoritative: { decision: "hold" as const } }));
  assert.deepEqual(compareGooglePersonalDeleteShadow(f.contexts[0]!, corrupted).mismatches, ["decision"]);
  assert.deepEqual(compareGooglePersonalDeleteShadow(f.contexts[0]!, Array(33).fill(f.frames[0])).mismatches, ["too-many-frames"]);
  assert.deepEqual({ calls: f.calls.length, ...f.counts(), evidence: f.evidence.length, acks: f.acks.length }, counts);
  const fact = { kind: "delete-read" as const, read: { kind: "present" as const, event: native(), etag: null } };
  assert.deepEqual(evaluateGooglePersonalDeleteFact(f.contexts[0]!, fact), { decision: "conflict", reason: "remote-validator-unavailable" });
});

test("DELETE known atomic ACK wins timeout while losing finish waits or rejects", async () => {
  for (const failFinish of [false, true]) {
    const f = fixture([response({}, 404)]), commit = deferred<void>(), ackReturned = deferred<void>();
    f.host.ack = async () => { await commit.promise; ackReturned.resolve(); return { kind: "acknowledged" }; };
    f.host.finish = async outcome => { f.finishes.push(outcome); commit.resolve(); await ackReturned.promise; await Promise.resolve(); if (failFinish) throw new Error("Losing finish failed"); };
    const result = await f.run({ timeoutMs: 20 }); assert.equal(result.status, "acked"); assert.equal(f.finishes.length, 1);
  }
  const f = fixture([response({}, 404)]); f.host.checkpoint = async phase => { if (phase === "afterAck") await new Promise<void>(() => {}); };
  assert.equal((await f.run({ timeoutMs: 20 })).status, "acked"); assert.equal(f.finishes.length, 0);
});

test("DELETE safe host metadata never serializes local causes, payloads or coercion hooks", async () => {
  const f = fixture([]), secret = new Error("SECRET_LOCAL_CAUSE"); f.host.accountSession.open = async () => { throw secret; };
  const result = await f.run(); assert.ok(!JSON.stringify(result).includes("SECRET_LOCAL_CAUSE")); assert.equal(f.finishes[0]!.cause, secret);
  const untouched = fixture([]), policy: any = { ...reference }; let hooks = 0;
  Object.defineProperty(policy, "completion", { get() { hooks++; return "exact-absence"; } });
  assert.equal((await runClaimedGooglePersonalDelete(untouched.input, untouched.host, untouched.ports, policy)).status, "hold"); assert.equal(hooks, 0); assert.equal(untouched.calls.length, 0);
  await assert.rejects(untouched.run({ timeoutMs: Infinity }), RangeError);
});

test("DELETE strict native profile rejects recurrence, specialized type, invalid or reversed timed frames", async () => {
  const f = fixture([response({}, 404)]); await f.run(); const context = f.contexts[0]!;
  for (const event of [{ ...native(), recurrence: ["RRULE:FREQ=DAILY"] }, { ...native(), eventType: "birthday" },
    { ...native(), start: { dateTime: "invalid" } }, { ...native(), end: { dateTime: "2026-10-13T07:00:00Z" } },
    { ...native(), start: { date: "2026-10-13" }, end: { date: "2026-10-14" } }]) {
    assert.deepEqual(evaluateGooglePersonalDeleteFact(context, { kind: "delete-read", read: { kind: "present", event, etag: '"before"' } }), { decision: "conflict", reason: "profile-unavailable" });
  }
});
