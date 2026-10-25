import assert from "node:assert/strict";
import test from "node:test";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  runClaimedCaldavPersonalCreate, supportsCaldavPersonalCreateEnvelope, caldavPersonalCreateIdentityV1,
  projectCaldavCreatedEvent, compareCaldavPersonalCreateShadow, type ClaimedCaldavPersonalCreate,
  type CaldavPersonalCreatePolicy, type CaldavPersonalCreateHostPorts, type CaldavCreateRuntimeProviderPorts,
  type CaldavRuntimeCreateCompletionEvidence, type CaldavRuntimeCreateNativeFacts, type CaldavRuntimeCreateFinishOutcome,
  type CaldavRuntimeCreateDecisionContext, type CaldavRuntimeCreateRecordedFrame,
} from "./index";

const operationId = "00000000-0000-4000-8000-000000000039", calendarUrl = "https://dav.example.test/calendar/";
const { resourceUrl, uid } = caldavPersonalCreateIdentityV1(calendarUrl, operationId)!;
const musubi: CaldavPersonalCreatePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-caldav", requireStrongReadback: false };
const reference: CaldavPersonalCreatePolicy = { completion: "exact-readback", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", requireStrongReadback: true };
const event = EventSchema.parse({ id: "canonical", creatorID: "owner", organizer: "", title: "Accepted A", color: "red", calendars: [], isCanceled: false,
  isAllDay: false, start: "2026-10-25T08:00:00.000Z", end: "2026-10-25T09:00:00.000Z", description: "Notes", location: "Room" });
const encoded = () => encodeEventV1("caldav", event, undefined, { action: "create", operationId, acceptedAt: "2026-10-25T07:00:00.000Z" });
const body = () => {
  const plan = encoded().nativePlan.data;
  if (plan.planKind !== "caldav-properties") throw new Error("Fixture must use the actual DAV codec plan");
  return plan.createResource;
};
const acl = (privilege = "bind") => new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${calendarUrl}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:${privilege}/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
const put = (etag?: string, status = 201) => new Response(null, { status, headers: etag === undefined ? {} : { etag } });
const read = (data = body(), etag?: string, status = 200) => new Response(status === 204 ? null : data, { status, headers: etag === undefined ? {} : { etag } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(replies: (Response | Error)[], policy: CaldavPersonalCreatePolicy = musubi, recovery = false) {
  const plan = encoded();
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    serializer: plan.serializer, commandId: "command", operationId, hostObjectId: event.id,
    locator: { provider: "caldav", connectionId: "logical:account", collectionId: calendarUrl, resourceId: resourceUrl },
    sourceEpoch: { sourceId: "source", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private", allowedSideEffects: ["provider-content-write"],
    admittedProjection: plan.admittedProjection, nativePlan: plan.nativePlan });
  const input: ClaimedCaldavPersonalCreate = { operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "create", operationId, commandId: envelope.commandId, hostObjectId: event.id, provider: "caldav",
      connectionId: envelope.locator.connectionId, collectionId: calendarUrl, resourceId: null, acceptedRevision: 2,
      sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:dav", connectionGeneration: "1720000000000", calendarUrl, resourceUrl, uid },
    recovery: { required: recovery, possibleDispatch: recovery }, priorProvider: recovery ? { kind: "uncertain" } : { kind: "not-dispatched" } };
  const calls: { url: string; init: RequestInit }[] = [], acks: CaldavRuntimeCreateCompletionEvidence[] = [], facts: CaldavRuntimeCreateNativeFacts[] = [],
    finishes: CaldavRuntimeCreateFinishOutcome[] = [], frames: CaldavRuntimeCreateRecordedFrame[] = [], contexts: CaldavRuntimeCreateDecisionContext[] = [];
  let credentials = 0, marks = 0, renewals = 0, observations = 0, normalizations = 0, dns = 0;
  const host: CaldavPersonalCreateHostPorts = {
    async renew() { renewals++; return true; },
    accountSession: { async open(connection) { credentials++; assert.equal(connection.connectionId, "physical:dav");
      return { ...connection, authorization: "Basic PRIVATE_CREDENTIAL" }; } },
    async beforeMutation() { marks++; }, normalizeObservation(native) { normalizations++; return projectCaldavCreatedEvent(native.resource); },
    async recordEvidence(value) { facts.push(value); }, async ack(value) { acks.push(value); return { kind: "acknowledged" }; },
    async finish(value) { finishes.push(value); }, observationId: () => `observation:${++observations}`,
    recordDecision(context, frame) { contexts.push(context); frames.push(frame); },
  };
  const ports: CaldavCreateRuntimeProviderPorts = {
    network: { allowPrivate: false, async lookupImpl() { dns++; return [{ address: "93.184.216.34", family: 4 }]; } },
    http: { async fetchPinned(url, init) { calls.push({ url: url.href, init }); const reply = replies.shift();
      if (!reply) throw new Error("Unplanned fixture request"); if (reply instanceof Error) throw reply; return reply; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  };
  return { input, envelope, host, ports, calls, acks, facts, finishes, frames, contexts,
    counts: () => ({ credentials, marks, renewals, observations, normalizations, dns }),
    run: (options = {}) => runClaimedCaldavPersonalCreate(input, host, ports, policy, options) };
}

test("DAV CREATE writes exact full admitted calendar with fixed URL/UID and host-specific completion", async () => {
  for (const policy of [musubi, reference]) {
    const f = fixture([acl(), put('"created"'), ...(policy === reference ? [read(body(), '"created"')] : [])], policy);
    const result = await f.run(); assert.equal(result.status, "acked");
    assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), policy === reference ? ["PROPFIND", "PUT", "GET"] : ["PROPFIND", "PUT"]);
    assert.equal(f.calls[1]!.url, resourceUrl); assert.equal(f.calls[1]!.init.body, f.envelope.nativePlan.data.createResource);
    assert.notEqual(f.calls[1]!.init.body, f.envelope.nativePlan.data.replacementComponent);
    assert.equal(new Headers(f.calls[1]!.init.headers).get("if-none-match"), "*"); assert.equal(new Headers(f.calls[1]!.init.headers).has("if-match"), false);
    assert.equal(f.acks[0]!.resourceUrl, resourceUrl); assert.equal(f.acks[0]!.uid, uid); assert.equal(f.counts().marks, 1);
    assert.equal(f.counts().normalizations, policy === reference ? 1 : 0); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE_CREDENTIAL"));
  }
});

test("fresh response filters strong-or-null versions and never repairs them by reading", async () => {
  for (const tag of [undefined, "", "invalid", 'W/"weak"', '""', '"strong"']) {
    const f = fixture([acl(), put(tag)]); f.host.normalizeObservation = () => { throw new Error("Fresh response must not normalize"); };
    assert.equal((await f.run()).status, "acked"); assert.equal(f.acks[0]!.validator, tag?.startsWith('"') ? tag : null); assert.equal(f.calls.length, 2);
  }
  const strict = fixture([acl(), put(), read(body())], reference); const result = await strict.run();
  assert.equal(result.status, "conflict"); assert.equal(result.facts.provider.kind, "accepted"); assert.equal(strict.acks.length, 0);
});

test("exact recovery404 retries only original identity/body after fresh bind evidence", async () => {
  for (const prior of ["uncertain", "accepted"] as const) {
    const f = fixture([read("", undefined, 404), acl(), put('"new"')], musubi, true);
    if (prior === "accepted") (f.input as any).priorProvider = { kind: "accepted", validator: '"old"', status: 201 };
    const result = await f.run(); assert.equal(result.status, "acked");
    assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), ["GET", "PROPFIND", "PUT"]);
    assert.equal(f.calls[2]!.url, resourceUrl); assert.equal(f.calls[2]!.init.body, body());
    assert.equal(new Headers(f.calls[2]!.init.headers).get("if-none-match"), "*"); assert.equal(result.facts.possibleDispatch, true);
  }
});

test("present recovery uses actual normalization and nullable API version without another PUT", async () => {
  for (const tag of [undefined, 'W/"weak"', '"strong"']) {
    const f = fixture([read(body(), tag)], musubi, true); assert.equal((await f.run()).status, "acked");
    assert.equal(f.counts().normalizations, 1); assert.equal(f.counts().marks, 0); assert.equal(f.calls.length, 1);
    assert.equal(f.acks[0]!.facts.provider.kind, "uncertain");
  }
});

test("410, wrongUID, malformedUTF8 and partial reads cannot authorize conditional retry", async () => {
  const partial = read(body(), '"v"'); partial.headers.set("content-range", "bytes 0-10/1000");
  for (const reply of [read("", undefined, 410), read(body().replace(uid, "foreign"), '"v"'),
    new Response(new Uint8Array([0xc3, 0x28])), partial, read(body(), '"v"', 206)]) {
    const f = fixture([reply], musubi, true); assert.notEqual((await f.run()).status, "acked");
    assert.equal(f.counts().marks, 0); assert.equal(f.calls.length, 1); assert.equal(f.acks.length, 0);
  }
});

test("known412 conflicts without same-attempt GET or fabricated absence/acceptance", async () => {
  for (const recovery of [false, true]) {
    const f = fixture([...(recovery ? [read("", undefined, 404)] : []), acl(), put(undefined, 412)], musubi, recovery);
    const result = await f.run(); assert.equal(result.status, "conflict"); assert.equal(result.error!.outcome, "not-written");
    assert.equal(result.facts.provider.kind, recovery ? "uncertain" : "rejected"); assert.equal(f.acks.length, 0);
    assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), recovery ? ["GET", "PROPFIND", "PUT"] : ["PROPFIND", "PUT"]);
  }
});

test("lost PUT reply observes at most once and never performs a second write in the attempt", async () => {
  const ordinary = fixture([acl(), new Error("PRIVATE lost reply")]); const initial = await ordinary.run();
  assert.equal(initial.status, "hold"); assert.equal(initial.facts.provider.kind, "uncertain");
  const strict = fixture([acl(), new Error("lost"), read(body(), '"v"')], reference);
  assert.equal((await strict.run()).status, "acked"); assert.equal(strict.acks[0]!.facts.provider.kind, "uncertain");
  const absent = fixture([acl(), new Error("lost"), read("", undefined, 404)], reference);
  assert.equal((await absent.run()).status, "conflict"); assert.equal(absent.calls.filter(call => call.init.method === "PUT").length, 1);
});

test("prior known acceptance survives a failed later conditional retry", async () => {
  const f = fixture([read("", undefined, 404), acl(), put(undefined, 412)], reference, true);
  (f.input as any).priorProvider = { kind: "accepted", validator: '"accepted"', status: 201 };
  const result = await f.run(); assert.equal(result.status, "conflict");
  assert.deepEqual(result.facts.provider, { kind: "accepted", validator: '"accepted"', status: 201 }); assert.equal(f.acks.length, 0);
});

test("a known conditional retry refusal cannot erase older unresolved acceptance", async () => {
  for (const status of [408, 429, 412]) {
    const f = fixture([read("", undefined, 404), acl(), put(undefined, status)], musubi, true);
    const result = await f.run(); assert.equal(result.facts.provider.kind, "uncertain"); assert.equal(result.facts.possibleDispatch, true);
    assert.equal(result.error!.providerStatus, status); assert.equal(result.error!.outcome, "not-written");
    assert.equal(f.calls.filter(call => call.init.method === "PUT").length, 1); assert.equal(f.acks.length, 0);
  }
});

test("full body, physical UID, resource URL and original UUID are bound before every capability", async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { (f.input as any).operationId = "opaque"; }, f => { (f.envelope as any).operationId = "opaque"; },
    f => { f.envelope.locator.resourceId = "https://dav.example.test/other.ics"; }, f => { (f.input.nativeTarget as any).resourceUrl += "x"; },
    f => { (f.input.nativeTarget as any).uid = "other"; }, f => { f.envelope.nativePlan.data.uid = "other"; },
    f => { f.envelope.nativePlan.data.createResource = f.envelope.nativePlan.data.replacementComponent; },
    f => { f.envelope.admittedProjection.data.title = "Changed"; }, f => { f.envelope.admittedProjection.data.isAllDay = true; },
    f => { f.envelope.admittedProjection.data.recurrence = "FREQ=DAILY"; }, f => { (f.input as any).recovery = { required: false, possibleDispatch: true }; },
    f => { (f.input as any).priorProvider = { kind: "accepted", validator: 'W/"weak"', status: 201 }; },
  ];
  for (const mutate of mutations) {
    const f = fixture([]); let prepared = 0; f.host.prepare = async () => { prepared++; }; mutate(f);
    assert.equal((await f.run()).status, "hold"); assert.equal(prepared, 0); assert.equal(f.finishes.length, 1);
    assert.deepEqual(f.counts(), { credentials: 0, marks: 0, renewals: 0, observations: 0, normalizations: 0, dns: 0 }); assert.equal(f.calls.length, 0);
  }
});

test("all admitted data and policy are owned before preparation yields", async () => {
  const policy = { ...musubi }, f = fixture([acl(), put('"v"')], policy), entered = deferred<void>(), release = deferred<void>();
  f.host.prepare = async () => { entered.resolve(); await release.promise; };
  const saved = body(), running = f.run(); await entered.promise;
  f.envelope.nativePlan.data.createResource = saved.replace("Accepted A", "Late B"); (f.input.nativeTarget as any).resourceUrl = "https://foreign.invalid/x";
  policy.completion = "exact-readback"; release.resolve(); assert.equal((await running).status, "acked");
  assert.equal(f.calls[1]!.url, resourceUrl); assert.equal(f.calls[1]!.init.body, saved); assert.equal(f.calls.length, 2);
});

test("normalizer errors remain private and a signal-ignoring normalizer cannot ACK late", async () => {
  const f = fixture([read(body(), '"v"')], musubi, true), error = new TypeError("PRIVATE malformed native text");
  f.host.normalizeObservation = () => { throw error; };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(f.finishes[0]!.cause, error);
  assert.ok(!JSON.stringify(result).includes("PRIVATE malformed native text"));
  const late = fixture([read(body(), '"v"')], musubi, true), gate = deferred<any>(); late.host.normalizeObservation = async () => gate.promise;
  assert.equal((await late.run({ timeoutMs: 20, heartbeatMs: 5 })).error!.interruption, "timeout");
  gate.resolve(projectCaldavCreatedEvent({ resourceUrl, uid, data: body() })); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(late.acks.length, 0); assert.equal(late.facts.length, 0); assert.equal(late.counts().marks, 0);
});

test("known refusal hints and ambiguous status do not erase dispatch uncertainty", async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 410, 429]) {
    const rejection = put(undefined, status); rejection.headers.set("retry-after", "9");
    const f = fixture([acl(), rejection]); const result = await f.run(); assert.equal(result.status, "hold");
    assert.equal(result.error!.outcome, "not-written"); assert.equal(result.facts.provider.kind, "rejected");
    if (status === 429) assert.equal(f.finishes[0]!.retryAfterMs, 9000);
  }
  for (const status of [202, 206, 500]) {
    const f = fixture([acl(), put(undefined, status)]); const result = await f.run(); assert.equal(result.facts.provider.kind, "uncertain"); assert.equal(f.acks.length, 0);
  }
});

test("preparation, Basic credentials and ignored HTTP cannot continue after attempt timeout", async () => {
  for (const blocked of ["prepare", "credentials", "read", "put"] as const) {
    const f = fixture(blocked === "put" ? [acl()] : [], musubi, blocked === "read"), gate = deferred<any>(), original = f.ports.http.fetchPinned;
    if (blocked === "prepare") f.host.prepare = async () => gate.promise;
    else if (blocked === "credentials") f.host.accountSession.open = async () => gate.promise;
    else f.ports.http.fetchPinned = async (url, init, address) => {
      if (blocked === "put" && init.method !== "PUT") return original(url, init, address);
      f.calls.push({ url: url.href, init }); return gate.promise;
    };
    const result = await f.run({ timeoutMs: 20, heartbeatMs: 5 }); assert.equal(result.error!.interruption, "timeout");
    const before = f.calls.length; gate.resolve(blocked === "credentials" ? { connectionId: "physical:dav", connectionGeneration: "1720000000000", authorization: "Basic late" } : put('"late"'));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, before); assert.equal(f.acks.length, 0); assert.equal(f.finishes.length, 1);
  }
});

test("ignored DNS and durable dispatch waits never reach the pinned HTTP leaf late", async () => {
  for (const dispatch of [false, true]) {
    const f = fixture(dispatch ? [acl()] : []), gate = deferred<any>();
    if (dispatch) f.host.beforeMutation = async () => gate.promise;
    else Object.assign(f.ports.network, { lookupImpl: async () => gate.promise });
    const result = await f.run({ timeoutMs: 20, heartbeatMs: 5 }); assert.equal(result.error!.interruption, "timeout");
    gate.resolve(dispatch ? undefined : [{ address: "93.184.216.34", family: 4 }]); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.length, dispatch ? 1 : 0); assert.equal(f.acks.length, 0);
  }
});

test("known committed ACK wins a later timeout without another host finish", async () => {
  const f = fixture([acl(), put('"v"')]), entered = deferred<void>(), release = deferred<void>();
  f.host.checkpoint = async phase => { if (phase === "afterAck") { entered.resolve(); await release.promise; } };
  const running = f.run({ timeoutMs: 30, heartbeatMs: 5 }); await entered.promise;
  assert.equal((await running).status, "acked"); assert.equal(f.acks.length, 1); assert.equal(f.finishes.length, 0); release.resolve();
});

test("pure private replay has no native capabilities or credential material", async () => {
  const f = fixture([read(body(), '"v"')], reference, true); assert.equal((await f.run()).status, "acked");
  assert.equal(supportsCaldavPersonalCreateEnvelope(f.envelope), true); const before = f.calls.length;
  for (let index = 0; index < 100; index++) assert.equal(compareCaldavPersonalCreateShadow(f.contexts[0]!, f.frames).matches, true);
  assert.equal(f.calls.length, before); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE_CREDENTIAL"));
  assert.equal(compareCaldavPersonalCreateShadow(f.contexts[0]!, [{ ...f.frames[0]!, authoritative: { decision: "dispatch" } }]).matches, false);
});
