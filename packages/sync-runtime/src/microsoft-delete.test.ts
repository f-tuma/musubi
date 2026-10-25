import assert from "node:assert/strict";
import test from "node:test";
import {
  runClaimedMicrosoftPersonalDelete, compareMicrosoftPersonalDeleteShadow,
  type MicrosoftPersonalDeleteHostPorts, type MicrosoftPersonalDeletePolicy, type MicrosoftDeleteRuntimeProviderPorts,
  type MicrosoftRuntimeDeleteNativeFacts, type MicrosoftRuntimeDeleteCompletionEvidence,
  type MicrosoftRuntimeDeleteFinishOutcome, type MicrosoftRuntimeDeleteRecordedFrame, type MicrosoftRuntimeDeleteDecisionContext,
} from "./index";
import { claimedMicrosoftDeleteInput } from "./behavior/microsoft-delete";
const response = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const native = () => ({ id: "native/event", "@odata.etag": 'W/"before"', subject: "NATIVE_CONTENT_PRIVATE",
  start: { dateTime: "2026-10-13T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-13T09:00:00.0000000", timeZone: "UTC" },
  isAllDay: false, type: "singleInstance", isOrganizer: true, isCancelled: false, isDraft: false, recurrence: null,
  attendees: [], isOnlineMeeting: false });
const guard = () => [response({ id: "self", mail: "owner@example.invalid" }),
  response({ id: "native/calendar", canEdit: true, owner: { address: "owner@example.invalid" } }), response(native())];
const fresh = () => [response(native()), ...guard(), ...guard(), response(null, 204), response(null, 404)];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(responses: (Response | Error)[] = [], policy: MicrosoftPersonalDeletePolicy = { preflightPasses: 2, ambiguousRecovery: "deferred" }) {
  const input = claimedMicrosoftDeleteInput({ attemptNumber: 1, resolution: null,
    recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } });
  const calls: { url: string; init: RequestInit }[] = [], evidence: MicrosoftRuntimeDeleteNativeFacts[] = [], acks: MicrosoftRuntimeDeleteCompletionEvidence[] = [];
  const finishes: MicrosoftRuntimeDeleteFinishOutcome[] = [], frames: MicrosoftRuntimeDeleteRecordedFrame[] = [], contexts: MicrosoftRuntimeDeleteDecisionContext[] = [];
  let sessions = 0, marks = 0, renewals = 0, identifiers = 0;
  const host: MicrosoftPersonalDeleteHostPorts = {
    async renew() { renewals++; return true; },
    accountSession: { async open(scope) { sessions++; return { ...scope, accessToken: "TOKEN_NEVER_IN_RESULT", eventWriteAllowed: true }; } },
    async beforeMutation() { marks++; }, async recordEvidence(facts) { evidence.push(facts); },
    async ack(value) { acks.push(value); return { kind: "acknowledged" }; }, async finish(value) { finishes.push(value); },
    observationId() { return `observation:${++identifiers}`; }, recordDecision(context, frame) { contexts.push(context); frames.push(frame); },
  };
  const ports: MicrosoftDeleteRuntimeProviderPorts = {
    http: { async fetch(url, init) { calls.push({ url, init }); const next = responses.shift();
      assert.ok(next, "Unexpected transport capability"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  };
  const run = (options = {}) => runClaimedMicrosoftPersonalDelete(input, host, ports, policy, options);
  return { input, host, ports, calls, evidence, acks, finishes, frames, contexts, policy, run,
    counts: () => ({ sessions, marks, renewals, identifiers }) };
}

test("Graph snapshot captures plan, scope, policy and first resolution before host preparation", async () => {
  const f = fixture(fresh());
  Object.assign(f.input, { recovery: { required: true, possibleDispatch: true }, priorProvider: { kind: "uncertain" },
    resolution: { expectedRemoteExists: true, expectedRemoteEtag: 'W/"before"' } });
  f.host.prepare = async () => {
    Object.assign(f.input.nativeTarget, { eventId: "wrong", calendarId: "wrong", connectionId: "wrong" });
    Object.assign(f.input, { attemptNumber: 2, resolution: undefined, priorProvider: { kind: "accepted", status: 204 } });
    Object.assign(f.policy, { preflightPasses: 1, ambiguousRecovery: "within-attempt" });
    return { acceptedEtag: 'W/"before"' };
  };
  assert.equal((await f.run()).status, "acked"); assert.equal(f.calls.length, 9); assert.equal(f.counts().marks, 1);
  assert.ok(f.calls.every(call => !call.url.includes("wrong")));
  assert.equal(new Headers(f.calls[7]!.init.headers).get("if-match"), 'W/"before"');
});

test("Graph malformed selected admissions never acquire prepare, credential or transport capabilities", async () => {
  for (const mutate of [
    (i: any) => { i.binding.provider = "google"; }, (i: any) => { i.nativeTarget.eventId = "other"; },
    (i: any) => { i.payload.operationEnvelope.operation.action = "update"; },
    (i: any) => { i.payload.operationEnvelope.nativePlan.data.body = {}; },
    (i: any) => { i.payload.operationEnvelope.allowedSideEffects.push("provider-notification"); },
    (i: any) => { i.payload.operationEnvelope.admittedProjection.data.isAllDay = true; },
    (i: any) => { i.payload.operationEnvelope.admittedProjection.data.recurrence = "RRULE:FREQ=DAILY"; },
    (i: any) => { i.attemptNumber = 0; }, (i: any) => { i.recovery.required = true; },
    (i: any) => { i.priorProvider = { kind: "accepted", status: 204 }; },
    (i: any) => { i.resolution = { expectedRemoteExists: false, expectedRemoteEtag: 'W/"before"' }; },
  ]) {
    const f = fixture(); let prepares = 0; f.host.prepare = async () => { prepares++; return { acceptedEtag: 'W/"before"' }; };
    mutate(f.input); const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(prepares, 0);
    assert.deepEqual(f.counts(), { sessions: 0, marks: 0, renewals: 0, identifiers: 0 }); assert.equal(f.calls.length, 0);
  }
});

test("Graph weak baseline is never replaced with strong ETag or changeKey", async () => {
  for (const acceptedEtag of [null, undefined, '"strong"', "changeKey", 'W/""']) {
    const f = fixture(); Object.assign(f.input, { acceptedEtag });
    assert.equal((await f.run()).error?.code, "runtime-baseline-validator-unavailable");
    assert.equal(f.counts().sessions, 0); assert.equal(f.calls.length, 0);
  }
});

test("Graph second resolution attempt and mismatched comparison remain observe-only", async () => {
  for (const [attemptNumber, expectedRemoteEtag, priorProvider] of [
    [2, 'W/"before"', { kind: "uncertain" }], [1, 'W/"other"', { kind: "uncertain" }],
    [1, 'W/"before"', { kind: "accepted", status: 204 }],
  ] as const) {
    const f = fixture([response(native())]); Object.assign(f.input, { attemptNumber, priorProvider,
      recovery: { required: true, possibleDispatch: true }, resolution: { expectedRemoteExists: true, expectedRemoteEtag } });
    const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.error?.code, "runtime-possible-dispatch-present");
    assert.equal(result.error?.outcome, "unconfirmed"); assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
    assert.deepEqual(result.facts.provider, priorProvider);
  }
});

test("Graph verification denial, 410 and malformed response preserve accepted native DELETE", async () => {
  for (const verification of [response({}, 403), response({}, 410), new Response("{", { status: 200 })]) {
    const responses = fresh(); responses[8] = verification; const f = fixture(responses); const result = await f.run();
    assert.equal(result.status, "hold"); assert.equal(result.error?.code, "provider-write-failed");
    assert.equal(result.error?.outcome, "unconfirmed"); assert.equal(result.error?.phase, "readback");
    assert.deepEqual(result.facts.provider, { kind: "accepted", status: 204 }); assert.equal(f.calls.length, 9);
    assert.equal(f.evidence[0]!.provider.kind, "accepted"); assert.equal(f.acks.length, 0);
  }
});

test("Graph exact absence retains prior uncertainty or acceptance without inventing a write", async () => {
  for (const priorProvider of [{ kind: "not-dispatched" }, { kind: "uncertain" }, { kind: "accepted", status: 204 }] as const) {
    const f = fixture([response(null, 404)]); const possible = priorProvider.kind !== "not-dispatched";
    Object.assign(f.input, { priorProvider, recovery: { required: possible, possibleDispatch: possible } });
    const result = await f.run(); assert.equal(result.status, "acked"); assert.deepEqual(result.facts.provider, priorProvider);
    assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0); assert.equal(f.acks[0]!.kind, "exact-absence");
  }
});

test("Graph timed-out signal-ignoring prepare cannot acquire later credentials", async () => {
  const f = fixture(); const held = deferred<{ acceptedEtag: unknown }>(); f.host.prepare = () => held.promise;
  const result = await f.run({ timeoutMs: 12, heartbeatMs: 1000 }); assert.equal(result.status, "hold");
  held.resolve({ acceptedEtag: 'W/"before"' }); await pause(5);
  assert.equal(f.counts().sessions, 0); assert.equal(f.calls.length, 0); assert.equal(f.acks.length, 0);
});

test("Graph host normalization refuses malformed content before any native write guard", async () => {
  const f = fixture([response(native())]); f.host.validateObservation = () => { throw new TypeError("PRIVATE_NATIVE_BODY"); };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.error?.phase, "recovery-read");
  assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_NATIVE_BODY"));
});

test("Graph timed-out host normalization cannot acquire a later native preflight", async () => {
  const f = fixture([response(native())]); const held = deferred<void>(); f.host.validateObservation = () => held.promise;
  const result = await f.run({ timeoutMs: 12, heartbeatMs: 1000 }); assert.equal(result.status, "hold");
  held.resolve(); await pause(5); assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0);
});

test("Graph timed-out signal-ignoring credentials cannot acquire HTTP or mutation", async () => {
  const f = fixture(); const held = deferred<any>();
  f.host.accountSession.open = scope => held.promise.then(() => ({ ...scope, accessToken: "TOKEN_NEVER_IN_RESULT", eventWriteAllowed: true }));
  const result = await f.run({ timeoutMs: 12, heartbeatMs: 1000 }); assert.equal(result.status, "hold");
  held.resolve(undefined); await pause(5); assert.equal(f.calls.length, 0); assert.equal(f.counts().marks, 0);
});

test("Graph lease loss fences a signal-ignoring observation continuation", async () => {
  const f = fixture(); const held = deferred<Response>(); let calls = 0;
  f.ports.http.fetch = async () => { calls++; return held.promise; }; f.host.renew = async () => false;
  const result = await f.run({ timeoutMs: 1000, heartbeatMs: 5 }); assert.equal(result.error?.interruption, "lease-lost");
  held.resolve(response(native())); await pause(5); assert.equal(calls, 1); assert.equal(f.counts().marks, 0); assert.equal(f.acks.length, 0);
});

test("Graph timeout during durable dispatch fence permits no detached DELETE", async () => {
  const responses = fresh(); const f = fixture(responses); const held = deferred<void>();
  f.host.beforeMutation = () => held.promise;
  const result = await f.run({ timeoutMs: 15, heartbeatMs: 1000 }); assert.equal(result.status, "hold");
  held.resolve(); await pause(5); assert.equal(f.calls.length, 7); assert.equal(f.acks.length, 0);
  assert.ok(f.calls.every(call => call.init.method === "GET"));
});

test("Graph known atomic ACK wins timeout racing a waiting finish", async () => {
  const f = fixture([response(null, 404)]); const ack = deferred<any>(), finishing = deferred<void>(), started = deferred<void>();
  f.host.ack = async () => ack.promise;
  f.host.finish = async () => { started.resolve(); await finishing.promise; throw new Error("PRIVATE_FINISH_FAILURE"); };
  const running = f.run({ timeoutMs: 12, heartbeatMs: 1000 }); await started.promise;
  ack.resolve({ kind: "acknowledged" }); await pause(2); finishing.resolve();
  const result = await running; assert.equal(result.status, "acked"); assert.equal(f.calls.length, 1);
});

test("Graph pure replay cannot dispatch and traces exclude native content and credentials", async () => {
  const f = fixture(fresh()); const result = await f.run(); assert.equal(result.status, "acked");
  assert.equal(compareMicrosoftPersonalDeleteShadow(f.contexts[0]!, f.frames).matches, true);
  const tampered = f.frames.map((frame, index) => index ? frame : { ...frame, authoritative: { decision: "dispatch" as const } });
  assert.equal(compareMicrosoftPersonalDeleteShadow(f.contexts[0]!, tampered).matches, false);
  assert.equal(f.calls.length, 9); assert.ok(!JSON.stringify(result.trace).includes("NATIVE_CONTENT_PRIVATE"));
  assert.ok(!JSON.stringify(result).includes("TOKEN_NEVER_IN_RESULT"));
});
