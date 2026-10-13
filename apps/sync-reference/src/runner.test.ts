import assert from "node:assert/strict";
import test from "node:test";
import { SyncOperationEnvelopeSchema, SyncDeliveryReceiptSchema } from "@musubi/types";
import type { GoogleRequestMetric } from "@musubi/provider-google";
import { ReferenceHoldError, type ReferenceClaim } from "./model.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";

const operationId = "reference:operation-one";
const calendarId = "calendar/a@b.test", eventId = "event/a?b#c";
const projection = { title: "New", description: null, location: "Room", start: "2026-10-13T08:00:00.000Z",
  end: "2026-10-13T09:00:00.000Z", isAllDay: false, recurrence: null };
const envelope = () => SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1",
  operation: { kind: "event", action: "update", version: 1 }, serializer: { id: "google-personal-event", version: 1 },
  commandId: "reference:command-one", operationId, hostObjectId: "reference:object-one",
  locator: { provider: "google", connectionId: "reference:connection-one", collectionId: calendarId, resourceId: eventId },
  sourceEpoch: { sourceId: "reference:binding-one", generation: 2 }, acceptedRevision: 2, privacyEpoch: "1",
  allowedSideEffects: ["provider-content-write"], admittedProjection: { data: { ...projection } },
  nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: { summary: "New" } } } });
const native = (summary = "Old", etag = '"baseline"') => ({ id: eventId, etag, status: "confirmed", summary,
  description: null, location: "Room", start: { dateTime: projection.start }, end: { dateTime: projection.end },
  organizer: { email: "owner@example.test", self: true } });
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers });
const calendar = () => response({ id: calendarId, accessRole: "owner" });
function fixture(responses: (Response | Error)[], recovery = false) {
  const admitted = envelope();
  const claim: ReferenceClaim = { operationId, attemptId: "attempt:one", payload: { operationEnvelope: admitted }, envelope: admitted,
    binding: { kind: "event", action: "update", operationId, commandId: admitted.commandId, hostObjectId: admitted.hostObjectId,
      provider: "google", connectionId: admitted.locator.connectionId, collectionId: calendarId, resourceId: eventId,
      acceptedRevision: 2, sourceEpoch: admitted.sourceEpoch, privacyEpoch: admitted.privacyEpoch },
    capture: { connectionGeneration: 1, sourceGeneration: 2, privacyGeneration: 1, acceptedRevision: 2 },
    locator: { connectionId: admitted.locator.connectionId, calendarId, eventId }, etag: '"baseline"', recovery,
    receipt: SyncDeliveryReceiptSchema.parse({ profile: "sync-profile-v1", operationId, attemptId: "attempt:one",
      local: { kind: "committed", hostObjectId: admitted.hostObjectId, revision: "2" },
      provider: { kind: recovery ? "uncertain" : "not-dispatched" }, remote: { kind: "unobserved" }, notification: { kind: "not-requested" } }) };
  const calls: { url: string; init: RequestInit }[] = [], metrics: GoogleRequestMetric[] = [];
  const evidence: Parameters<ReferenceRunnerStore["recordEvidence"]>[1][] = [];
  const finishes: { status: string; delay: unknown }[] = [], observations: unknown[] = [];
  let sessions = 0, claims = 0, marks = 0, monotonic = 0;
  const store: ReferenceRunnerStore = {
    async claim() { claims++; return claim; }, async renew() { return true; },
    async getSession() { sessions++; return { connectionId: admitted.locator.connectionId, connectionGeneration: "1",
      accessToken: "private-token-never-in-diagnostics", scope: "https://www.googleapis.com/auth/calendar.events", eventWriteAllowed: true }; },
    async markDispatch() { marks++; return true; },
    async recordEvidence(_claim, value) { evidence.push(value); return true; },
    async complete(_claim, value) { observations.push(value); return true; },
    async finish(_claim, status = "hold", delay) { finishes.push({ status, delay }); return true; },
  };
  const ports: ReferenceRunnerPorts = {
    http: { async fetch(url, init) {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected HTTP dispatch.");
      if (next instanceof Error) throw next;
      return next;
    } },
    clock: { nowEpochMs: () => Date.parse("2026-10-13T00:00:00Z"), nowMonotonicMs: () => monotonic += 5 },
    telemetry: { record(value) { metrics.push(value); } },
  };
  const run = () => deliverReferenceOperation(store, operationId, ports, { attemptId: claim.attemptId });
  return { claim, store, ports, calls, metrics, evidence, finishes, observations, run,
    counts: () => ({ sessions, claims, marks }) };
}

test("bounded reference UPDATE uses accepted body, strong If-Match and exact full readback", async () => {
  const f = fixture([calendar(), response(native()), response({ etag: '"written"' }), response(native("New", '"written"'))]);
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "PATCH", "GET"]);
  const patch = f.calls[2]!;
  assert.equal(patch.url, "https://www.googleapis.com/calendar/v3/calendars/calendar%2Fa%40b.test/events/event%2Fa%3Fb%23c");
  assert.equal(new Headers(patch.init.headers).get("if-match"), '"baseline"');
  assert.deepEqual(JSON.parse(patch.init.body as string), { summary: "New" });
  assert.deepEqual(f.evidence.map(value => [value.provider, value.remote]), [["accepted", "unobserved"], ["accepted", "confirmed"]]);
  assert.deepEqual(f.observations, [{ etag: '"written"', projection }]);
  assert.equal(f.counts().marks, 1); assert.equal(f.metrics.length, f.calls.length);
  assert.ok(f.metrics.every(value => Object.keys(value).sort().join(",") === "durationMs,family,method,provider,status"));
  assert.ok(!JSON.stringify(f.metrics).includes("private-token"));
});

test("unsupported, future, legacy, malformed and row-disagreeing payloads HOLD before credentials/network", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).schemaVersion = 2; },
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).serializer.version = 2; },
    f => { (f.claim.payload as Record<string, unknown>).operationEnvelope = null; },
    f => { (f.claim as any).payload = null; },
    f => { (f.claim as any).payload = "invalid-json-object"; },
    f => { delete (f.claim.payload as Record<string, unknown>).operationEnvelope; },
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).allowedSideEffects.push("provider-notification"); },
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).admittedProjection.data.recurrence = "RRULE:FREQ=DAILY"; },
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).admittedProjection.data.isAllDay = true; },
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).nativePlan.data.body.summary = "Poisoned"; },
    f => { ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).nativePlan.data.body.attendees = []; },
    f => { f.claim.binding.collectionId = "different-calendar" as any; },
  ];
  for (const change of changes) {
    const f = fixture([]); change(f);
    assert.equal((await f.run()).status, "hold");
    assert.deepEqual(f.counts(), { claims: 1, sessions: 0, marks: 0 });
    assert.equal(f.calls.length, 0); assert.equal(f.observations.length, 0);
  }
});

test("possible lost dispatch reads first and ACKs confirmed target without another PATCH", async () => {
  const f = fixture([response(native("New", '"observed"'))], true);
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]);
  assert.deepEqual(f.evidence.map(value => [value.provider, value.remote]), [["uncertain", "confirmed"]]);
  assert.equal(f.counts().marks, 0);
});

test("known HTTP acceptance survives recovery observation and keeps its original validator", async () => {
  const f = fixture([response(native("New", '"observed"'))], true);
  f.claim.receipt.provider = { kind: "accepted", validator: { kind: "etag", value: '"accepted-response"' } };
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.evidence[0], { provider: "accepted", validator: '"accepted-response"', remote: "confirmed", observationId: f.evidence[0]!.observationId });
});

test("unwritten unchanged accepted ETag permits a fresh preflight and one conditional attempt", async () => {
  const f = fixture([response(native()), calendar(), response(native()), response({ etag: '"written"' }), response(native("New", '"written"'))], true);
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "GET", "PATCH", "GET"]);
  assert.equal(new Headers(f.calls[3]!.init.headers).get("if-match"), f.claim.etag);
  assert.deepEqual(JSON.parse(f.calls[3]!.init.body as string), { summary: "New" });
});

test("changed recovery ETag with different content becomes conflict without a PATCH", async () => {
  const f = fixture([response(native("Other", '"changed"'))], true);
  const result = await f.run();
  assert.equal(result.status, "conflict"); assert.equal(result.code, "reference-recovery-validator-changed");
  assert.equal(f.calls.length, 1); assert.equal(f.counts().marks, 0); assert.equal(f.observations.length, 0);
});

test("lost PATCH reply can confirm content but cannot fabricate provider acceptance", async () => {
  const f = fixture([calendar(), response(native()), new Error("Lost PATCH response"), response(native("New", '"observed"'))]);
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "PATCH", "GET"]);
  assert.deepEqual(f.evidence.map(value => [value.provider, value.remote]), [["uncertain", "unobserved"], ["uncertain", "confirmed"]]);
});

test("failed observation after lost PATCH preserves uncertainty and Retry-After lower bound", async () => {
  const f = fixture([calendar(), response(native()), new Error("Lost PATCH response"), response({}, 429, { "retry-after": "120" })]);
  assert.equal((await f.run()).status, "hold");
  assert.equal(f.evidence.at(-1)!.provider, "uncertain");
  assert.deepEqual(f.finishes.at(-1)!.delay, { code: "provider-write-failed", retryAfterMs: 120_000 });
  assert.equal(f.observations.length, 0); assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 1);
});

test("missing, cancelled and malformed exact readback never ACK or create a deletion", async () => {
  for (const read of [response({}, 404), response({}, 410), response({ id: eventId, status: "cancelled" }),
    response({ ...native("New", '"written"'), start: {} }), response(native("New", "W/weak"))]) {
    const f = fixture([calendar(), response(native()), response({ etag: '"written"' }), read]);
    assert.notEqual((await f.run()).status, "acked");
    assert.equal(f.observations.length, 0);
    assert.equal(f.evidence.at(-1)!.provider, "accepted");
    assert.ok(f.calls.every(call => ["GET", "PATCH"].includes(call.init.method!)));
  }
});

test("a readback mismatch records conflict while preserving actual native acceptance", async () => {
  const f = fixture([calendar(), response(native()), response({ etag: '"written"' }), response(native("Other", '"changed"'))]);
  assert.equal((await f.run()).status, "conflict");
  assert.equal(f.evidence.at(-1)!.provider, "accepted"); assert.equal(f.evidence.at(-1)!.remote, "conflict");
  assert.equal(f.observations.length, 0);
});

test("412 is a rejected conditional attempt and never an unconditional retry", async () => {
  const f = fixture([calendar(), response(native()), response({}, 412)]);
  assert.equal((await f.run()).status, "conflict");
  assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 1);
  assert.equal(f.evidence.at(-1)!.provider, "rejected");
  assert.deepEqual(f.evidence.at(-1)!.error, { code: "conflict", retry: "never" });
  assert.equal(f.observations.length, 0);
});

test("authority loss before mutation prevents PATCH and after mutation refuses ACK", async () => {
  const before = fixture([calendar(), response(native())]);
  before.store.markDispatch = async () => { throw new ReferenceHoldError("authority-changed"); };
  assert.equal((await before.run()).code, "authority-changed");
  assert.equal(before.calls.filter(call => call.init.method === "PATCH").length, 0);
  const after = fixture([calendar(), response(native()), response({ etag: '"written"' }), response(native("New", '"written"'))]);
  after.store.complete = async () => false;
  assert.equal((await after.run()).code, "reference-ack-authority-changed");
  assert.equal(after.evidence.at(-1)!.provider, "accepted"); assert.equal(after.evidence.at(-1)!.remote, "confirmed");
});

test("expired credentials and mismatched connection incarnation stop before HTTP", async () => {
  const expired = fixture([]);
  expired.store.getSession = async () => { throw new ReferenceHoldError("credentials-expired"); };
  assert.equal((await expired.run()).code, "credentials-expired"); assert.equal(expired.calls.length, 0);
  const changed = fixture([]);
  const open = changed.store.getSession;
  changed.store.getSession = async (...args) => ({ ...await open(...args), connectionGeneration: "2" });
  assert.equal((await changed.run()).code, "account-session-changed"); assert.equal(changed.calls.length, 0);
});

test("accepted input remains immutable while host credential resolution is pending", async () => {
  const f = fixture([calendar(), response(native()), response({ etag: '"written"' }), response(native("New", '"written"'))]);
  const open = f.store.getSession;
  f.store.getSession = async (...args) => {
    ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).nativePlan.data.body.summary = "Changed asynchronously";
    ((f.claim.payload as Record<string, unknown>).operationEnvelope as any).admittedProjection.data.title = "Changed asynchronously";
    return open(...args);
  };
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(JSON.parse(f.calls[2]!.init.body as string), { summary: "New" });
  assert.deepEqual(f.observations, [{ etag: '"written"', projection }]);
});

test("lease loss aborts in-flight GET and records exactly one bounded network metric", async () => {
  const f = fixture([]);
  f.store.renew = async () => false;
  f.ports.http.fetch = async (url, init) => {
    f.calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const result = await deliverReferenceOperation(f.store, operationId, f.ports, { attemptId: "attempt:one", heartbeatMs: 5, deadlineMs: 100 });
  assert.equal(result.code, "reference-attempt-aborted"); assert.equal(f.calls.length, 1);
  assert.equal(f.metrics.length, 1); assert.equal(f.metrics[0]!.status, "aborted"); assert.equal(f.counts().marks, 0);
});

test("deadline aborts possible PATCH without losing native uncertainty", async () => {
  const f = fixture([calendar(), response(native())]);
  const fetch = f.ports.http.fetch;
  f.ports.http.fetch = async (url, init) => {
    if (init.method !== "PATCH") return fetch(url, init);
    f.calls.push({ url, init });
    return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  const result = await deliverReferenceOperation(f.store, operationId, f.ports, { attemptId: "attempt:one", deadlineMs: 20 });
  assert.equal(result.code, "reference-attempt-aborted");
  assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.counts().marks, 1);
  assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 1);
});

test("invalid runner bounds and pre-aborted requests do not acquire durable leases", async () => {
  const f = fixture([]);
  for (const options of [{ deadlineMs: 0 }, { heartbeatMs: 0 }, { deadlineMs: 45_001 }, { heartbeatMs: 20_001 }, { attemptId: "" }])
    await assert.rejects(deliverReferenceOperation(f.store, operationId, f.ports, options), TypeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(deliverReferenceOperation(f.store, operationId, f.ports, { signal: controller.signal }));
  assert.equal(f.counts().claims, 0);
});

test("telemetry and post-ACK observer failures cannot change completed delivery truth", async () => {
  const f = fixture([calendar(), response(native()), response({ etag: '"written"' }), response(native("New", '"written"'))]);
  f.ports.telemetry.record = () => { throw new Error("Diagnostic unavailable"); };
  const result = await deliverReferenceOperation(f.store, operationId, f.ports, { attemptId: "attempt:one",
    checkpoint(phase) { if (phase === "afterAck") throw new Error("Observer unavailable"); } });
  assert.equal(result.status, "acked"); assert.equal(f.observations.length, 1);
});


test("special event types, unknown native status and altered untouched fields prevent mutation", async () => {
  for (const changed of [{ ...native(), eventType: "focusTime" }, { ...native(), status: "future-status" },
    { ...native(), location: "Unadmitted location" }, { ...native(), start: { dateTime: "2026-10-13T07:00:00.000Z" } }]) {
    const f = fixture([calendar(), response(changed)]);
    assert.equal((await f.run()).status, "conflict");
    assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 0);
    assert.equal(f.counts().marks, 0);
  }
});

test("empty native plans and weak accepted baseline validators HOLD before credential access", async () => {
  const empty = fixture([]); ((empty.claim.payload as Record<string, unknown>).operationEnvelope as any).nativePlan.data.body = {};
  assert.equal((await empty.run()).status, "hold"); assert.equal(empty.counts().sessions, 0);
  const weak = fixture([]); (weak.claim as any).etag = "W/weak";
  assert.equal((await weak.run()).code, "reference-baseline-validator-unavailable"); assert.equal(weak.counts().sessions, 0);
});

test("crash checkpoints separate durable possible dispatch, uncertain reply and confirmed read", async () => {
  const f = fixture([calendar(), response(native()), new Error("Lost reply"), response(native("New", '\"observed\"'))]);
  const phases: string[] = [];
  const result = await deliverReferenceOperation(f.store, operationId, f.ports, { attemptId: "attempt:one", checkpoint(phase) {
    phases.push(phase);
    if (phase === "beforeDispatch") { assert.equal(f.counts().marks, 1); assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 0); }
    if (phase === "afterUncertain") { assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.calls.length, 3); }
    if (phase === "afterReadback") { assert.equal(f.evidence.at(-1)!.remote, "confirmed"); assert.equal(f.observations.length, 0); }
  } });
  assert.equal(result.status, "acked");
  assert.deepEqual(phases.filter(phase => phase !== "afterCredentials"), ["claim", "beforeDispatch", "afterUncertain", "afterReadback", "afterAck"]);
});

test("unrepresentable finite Retry-After uses an indefinite lower-bound HOLD", async () => {
  const f = fixture([response({}, 429, { "retry-after": "999999999999999999" })]);
  assert.equal((await f.run()).status, "hold");
  assert.deepEqual(f.finishes.at(-1)!.delay, { code: "provider-write-failed", retryAfterMs: Infinity });
});


test("PATCH rate limit records a delayed rejection with the exact rounded lower bound", async () => {
  const f = fixture([calendar(), response(native()), response({}, 429, { "retry-after": "120" })]);
  assert.equal((await f.run()).status, "hold");
  assert.deepEqual(f.evidence.at(-1)!.error, { code: "rate-limited", retry: "after-delay", retryAfterMs: 120_000 });
  assert.deepEqual(f.finishes.at(-1)!.delay, { code: "provider-write-failed", retryAfterMs: 120_000 });
  assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 1);
});

test("PATCH permission refusal requires reconnect and cannot automatically reclaim the old admission", async () => {
  for (const status of [401, 403]) {
    const f = fixture([calendar(), response(native()), response({}, status)]);
    assert.equal((await f.run()).status, "hold");
    assert.deepEqual(f.evidence.at(-1)!.error, { code: "permission-denied", retry: "after-reconnect" });
    assert.deepEqual(f.finishes.at(-1)!.delay, { code: "provider-write-failed", retryAfterMs: Infinity });
    assert.equal(f.calls.filter(call => call.init.method === "PATCH").length, 1);
    assert.equal(f.observations.length, 0);
  }
});

test("failed GET observation does not rewrite a previously known rejection into transport failure", async () => {
  const f = fixture([response({}, 429, { "retry-after": "30" })], true);
  f.claim.receipt.provider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 120_000 } };
  assert.equal((await f.run()).status, "hold");
  assert.deepEqual(f.evidence.at(-1)!.error, { code: "rate-limited", retry: "after-delay", retryAfterMs: 120_000 });
  assert.equal(f.calls.length, 1);
});

test("429 recovery can ACK an externally fulfilled target while preserving native rejection", async () => {
  const f = fixture([response(native("New", '"externally-fulfilled"'))], true);
  f.claim.receipt.provider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 120_000 } };
  assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]);
  assert.equal(f.counts().marks, 0);
  assert.deepEqual(f.evidence[0], { provider: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 120_000 },
    remote: "confirmed", observationId: f.evidence[0]!.observationId });
  assert.deepEqual(f.observations, [{ etag: '"externally-fulfilled"', projection }]);
});

test("noncooperative transport returns at the deadline and cannot dispatch or ACK after late resolution", async () => {
  const f = fixture([]);
  let release!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.ports.http.fetch = async (url, init) => {
    f.calls.push({ url, init }); started();
    // Deliberately ignore init.signal, as a faulty host transport can.
    return new Promise<Response>(resolve => { release = resolve; });
  };
  const pending = deliverReferenceOperation(f.store, operationId, f.ports,
    { attemptId: "attempt:one", deadlineMs: 20, heartbeatMs: 5 });
  await entered;
  assert.equal((await pending).code, "reference-attempt-aborted");
  assert.equal(f.finishes.length, 1);
  const evidenceCount = f.evidence.length;
  release(calendar());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 1, "Late calendar read cannot begin the next HTTP request");
  assert.equal(f.counts().marks, 0); assert.equal(f.observations.length, 0);
  assert.equal(f.finishes.length, 1); assert.equal(f.evidence.length, evidenceCount);
});

test("saved admission, native address and private authority capture remain stable across suspended credentials", async () => {
  const f = fixture([calendar(), response(native()), response({ etag: '"written"' }), response(native("New", '"written"'))]);
  const original = f.store.getSession;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  f.store.getSession = async (...args) => {
    if (first) { first = false; entered(); await paused; }
    assert.equal(args[0].capture.connectionGeneration, 1);
    assert.equal(args[0].locator.eventId, eventId);
    return original(...args);
  };
  const pending = f.run(); await started;
  (f.claim.payload as any).operationEnvelope.nativePlan.data.body.summary = "Caller B";
  (f.claim.payload as any).operationEnvelope.admittedProjection.data.title = "Caller B";
  (f.claim.binding as any).resourceId = "other-event";
  (f.claim.locator as any).eventId = "other-event";
  (f.claim.capture as any).connectionGeneration = 99;
  release();
  assert.equal((await pending).status, "acked");
  assert.deepEqual(JSON.parse(f.calls[2]!.init.body as string), { summary: "New" });
  assert.ok(f.calls.every(call => !call.url.includes("other-event")));
  assert.deepEqual(f.observations, [{ etag: '"written"', projection }]);
});
