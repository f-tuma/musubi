import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { runClaimedGoogleTaskCreate, supportsGoogleTaskCreateEnvelope } from "./google-task-create";
import { copyNativeTaskEvidence } from "./task-native-data";
import type { ClaimedGoogleTaskCreate, GoogleTaskCreateHostPorts, GoogleTaskCreateRuntimeProviderPorts, GoogleTaskCreatePolicy,
  RuntimeTaskCreateCompletionEvidence, RuntimeTaskCreateFinishOutcome, RuntimeAttemptOptions, RuntimeTaskCreateNativeFacts } from "./google-task-create-ports";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture(collection = "list", collectionIdentity: ClaimedGoogleTaskCreate["collectionIdentity"] = "native") {
  const task = TaskSchema.parse({ id: "rich-task", creatorID: "owner", calendarID: "home", title: "Target", description: "Keep notes", status: "in-process", due: "2026-10-26T14:45:00Z", priority: 2 });
  const encoded = encodeTaskV1("google", task, undefined, { action: "create", operationId, acceptedAt: "2026-10-26T09:00:00Z" });
  const target = encoded.admittedProjection.data as { title: string; notes: string | null; status: "needsAction"; due: string };
  const logical = collectionIdentity === "native" ? collection : `musubi-google-task-list:${collection}`;
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "create", version: 1 },
    operationId, commandId: "command", hostObjectId: task.id, locator: { provider: "google", connectionId: "logical", collectionId: logical, resourceId: null },
    sourceEpoch: { sourceId: "source", generation: 1 }, privacyEpoch: "private", acceptedRevision: 2, allowedSideEffects: ["provider-content-write"], ...encoded });
  const input: ClaimedGoogleTaskCreate = { operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "task", action: "create", operationId, commandId: "command", hostObjectId: task.id, provider: "google", connectionId: "logical", collectionId: logical, resourceId: null, acceptedRevision: 2, predecessorOperationId: null },
    nativeTarget: { connectionId: "physical", connectionGeneration: "1", taskListId: collection }, collectionIdentity,
    recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
  const counts = { prepare: 0, sessions: 0, marks: 0, acks: 0, finishes: 0, projection: 0 }, acks: RuntimeTaskCreateCompletionEvidence[] = [], finishes: RuntimeTaskCreateFinishOutcome[] = [], evidence: RuntimeTaskCreateNativeFacts[] = [];
  const host: GoogleTaskCreateHostPorts = { async prepare() { counts.prepare++; return {}; }, renew: async () => true,
    accountSession: { async open(connection) { counts.sessions++; return { ...connection, accessToken: "fixture", taskWriteAllowed: true }; } },
    async beforeMutation() { counts.marks++; }, async recordEvidence(facts) { evidence.push(facts); },
    async ack(value) { counts.acks++; acks.push(value); return { kind: "acknowledged" }; }, async finish(value) { counts.finishes++; finishes.push(value); }, observationId: () => "observation" };
  const calls: { method: string; url: string; body: unknown }[] = [];
  const transport: GoogleTaskCreateRuntimeProviderPorts = { http: { async fetch(url, init) {
    calls.push({ method: init.method ?? "GET", url, body: init.body ?? null });
    if (init.method === "POST") return Response.json({ id: "created", etag: '"response"' }, { status: 201 });
    return Response.json(url.includes("/users/@me/") ? { id: collection } : { id: "created", etag: '"observed"', ...target });
  } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  const policy: GoogleTaskCreatePolicy = { nativeProfile: "existing-google", readback: "saved-patch", ambiguousRecovery: "deferred" };
  const recover = (candidate: string | null = "created") => { (input as any).recovery = { required: true, possibleDispatch: true }; (input as any).priorProvider = { kind: "uncertain" };
    if (candidate !== null) (input as any).priorResponseAddress = { taskId: candidate, validator: null }; };
  return { task, target, input, envelope, host, transport, policy, calls, counts, acks, finishes, evidence, recover,
    run: (options: RuntimeAttemptOptions = {}) => runClaimedGoogleTaskCreate(input, host, transport, policy, options) };
}
test("CREATE sends exact admitted four fields then scoped GET and ACK without rewriting canonical or null locator", async () => {
  const f = fixture(), before = structuredClone(f.task), result = await f.run();
  assert.equal(result.status, "acked"); assert.deepEqual(f.calls.map(c => c.method), ["GET", "POST", "GET"]); assert.equal(f.counts.sessions, 3);
  assert.deepEqual(JSON.parse(f.calls[1]!.body as string), f.target); assert.deepEqual(f.task, before); assert.equal(f.envelope.locator.resourceId, null);
  assert.equal(f.acks[0]?.taskId, "created"); assert.equal(f.acks[0]?.validator, '"observed"'); assert.equal(result.facts.acceptedStatus, 201);
});
test("CREATE snapshots target/body/policy before prepare awaits", async () => {
  const f = fixture(), reached = deferred<void>(), resume = deferred<void>(); f.host.prepare = async () => { reached.resolve(); await resume.promise; return {}; };
  const pending = f.run(); await reached.promise; (f.input.nativeTarget as any).taskListId = "other"; (f.envelope.nativePlan.data as any).body.title = "Injected"; (f.policy as any).readback = "full-target";
  resume.resolve(); assert.equal((await pending).status, "acked"); assert.equal(JSON.parse(f.calls[1]!.body as string).title, "Target"); assert(f.calls.every(c => !c.url.includes("other")));
});
test("malformed selected CREATE plan refuses prepare and every native capability", async () => {
  const f = fixture(); (f.envelope.nativePlan.data as any).body = null; assert.equal(supportsGoogleTaskCreateEnvelope(f.envelope), true);
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.prepare, 0); assert.equal(f.calls.length, 0);
});
test("predecessor CREATE lineage remains outside nominal shared selection", () => {
  const f = fixture(); (f.envelope as any).predecessorOperationId = "earlier"; assert.equal(supportsGoogleTaskCreateEnvelope(f.envelope), false);
});
test("CREATE input getters never execute", async () => {
  const f = fixture(); let reads = 0; Object.defineProperty(f.input.nativeTarget, "taskListId", { enumerable: true, get() { reads++; throw new Error("private"); } });
  assert.equal((await f.run()).status, "hold"); assert.equal(reads, 0); assert.equal(f.counts.prepare, 0);
});
for (const mode of ["native", "musubi-google-task-list"] as const) test(`CREATE ${mode} identity unwraps prefix-looking physical list exactly once`, async () => {
  const f = fixture("musubi-google-task-list:opaque", mode); assert.equal((await f.run()).status, "acked"); assert(f.calls.every(c => c.url.includes("musubi-google-task-list%3Aopaque")));
});
for (const prior of ["uncertain", "accepted", "rejected", "not-dispatched"] as const) test(`CREATE no-address ${prior} marker cannot POST or search`, async () => {
  const f = fixture(); f.recover(null); (f.input as any).priorProvider = prior === "accepted" ? { kind: prior, validator: null } : prior === "rejected" ? { kind: prior, error: { code: "rate-limited", retry: "after-delay" } } : { kind: prior };
  f.host.prepareProjection = async () => { f.counts.projection++; throw new Error("No recovery preparation"); };
  const r = await f.run(); assert.equal(r.status, "hold"); assert.equal(r.error?.code, "task-create-unconfirmed"); assert.equal(f.calls.length, 0); assert.equal(f.counts.projection, 0); assert.equal(f.counts.marks, 0);
});
test("CREATE captured address recovers through one exact GET without needing an invented accepted status", async () => {
  const f = fixture(); f.recover(); assert.equal((await f.run()).status, "acked"); assert.deepEqual(f.calls.map(c => c.method), ["GET"]); assert.equal(f.counts.marks, 0); assert.equal(f.evidence[0]?.acceptedStatus, undefined);
});
test("partial legacy CREATE baseline permits ordinary saved patch, recovery still requires full admitted target", async () => {
  for (const recovering of [false, true]) {
    const f = fixture(); if (recovering) f.recover(); f.host.prepare = async () => ({ saved: { projection: f.target, baseline: { title: "Before", notes: f.target.notes, due: f.target.due, status: f.target.status }, patch: { title: f.target.title } } });
    const fetch = f.transport.http.fetch; f.transport.http.fetch = async (url, init) => url.endsWith("/tasks/created") ? Response.json({ id: "created", etag: '"v2"', ...f.target, notes: "Other" }) : fetch(url, init);
    const r = await f.run(); assert.equal(r.status, recovering ? "hold" : "acked"); assert.equal(f.calls.filter(c => c.method === "POST").length, recovering ? 0 : 1);
  }
});
test("API malformed accepted tag retains raw candidate but not complete writer result or another GET", async () => {
  const f = fixture(), fetch = f.transport.http.fetch; f.transport.http.fetch = (url, init) => init.method === "POST" ? Promise.resolve(Response.json({ id: "created", etag: 'W/"bad"' }, { status: 201 })) : fetch(url, init);
  const r = await f.run(); assert.equal(r.status, "hold"); assert.equal(r.facts.acceptedStatus, 201); assert.deepEqual(r.facts.responseAddress, { taskId: "created", validator: null }); assert.equal(r.facts.writerResult, undefined); assert.equal(f.counts.sessions, 2);
});
test("reference exact GET can confirm captured candidate with unusable response tag", async () => {
  const f = fixture(), fetch = f.transport.http.fetch; Object.assign(f.policy, { nativeProfile: "strict-reference", ambiguousRecovery: "within-attempt", readback: "full-target" });
  f.transport.http.fetch = (url, init) => init.method === "POST" ? Promise.resolve(Response.json({ id: "created", etag: null }, { status: 200 })) : fetch(url, init);
  const r = await f.run(); assert.equal(r.status, "acked"); assert.equal(r.facts.acceptedStatus, 200); assert.equal(r.facts.writerResult, undefined); assert.equal(f.counts.sessions, 3); assert(f.evidence.some(e => e.acceptedStatus === 200 && e.responseAddress === undefined));
});
test("bodyless204 preserves acceptance without candidate and cannot retry POST", async () => {
  const f = fixture(), fetch = f.transport.http.fetch; f.transport.http.fetch = (url, init) => init.method === "POST" ? Promise.resolve(new Response(null, { status: 204 })) : fetch(url, init);
  const r = await f.run(); assert.equal(r.status, "hold"); assert.equal(r.facts.acceptedStatus, 204); assert.equal(r.facts.responseAddress, undefined); assert.equal(f.counts.marks, 1);
});
test("unsupported202 is unknown rather than fabricated native acceptance", async () => {
  const f = fixture(), fetch = f.transport.http.fetch; f.transport.http.fetch = (url, init) => init.method === "POST" ? Promise.resolve(Response.json({ id: "not-a-proof" }, { status: 202 })) : fetch(url, init);
  const r = await f.run(); assert.equal(r.status, "hold"); assert.equal(r.facts.provider.kind, "uncertain"); assert.equal(r.facts.acceptedStatus, undefined); assert.equal(r.facts.responseAddress, undefined);
});
for (const status of [404, 410]) test(`candidate recovery${status} is unresolved, never a new POST`, async () => {
  const f = fixture(); f.recover(); f.transport.http.fetch = async () => new Response(null, { status }); const r = await f.run(); assert.equal(r.status, "hold"); assert.equal(f.counts.sessions, 1); assert.equal(f.counts.marks, 0);
});
test("API JSON-time cancellation cannot fabricate an awaited writer return", async () => {
  const f = fixture(), controller = new AbortController(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => { if (init.method !== "POST") return fetch(url, init);
    const response = Response.json({ id: "created", etag: '"v1"' }, { status: 201 }), json = response.json.bind(response);
    response.json = async () => { const body = await json(); controller.abort(); return body; }; return response; };
  const r = await f.run({ signal: controller.signal }); assert.equal(r.status, "hold"); assert.equal(r.facts.writerResult, undefined); assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1);
});
test("API readback-time cancellation retains the complete awaited writer result", async () => {
  const f = fixture(), controller = new AbortController(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => { if (url.endsWith("/tasks/created")) controller.abort(); return fetch(url, init); };
  const r = await f.run({ signal: controller.signal }); assert.equal(r.status, "hold"); assert.deepEqual(r.facts.writerResult, { taskId: "created", etag: '"response"' }); assert.equal(f.counts.acks, 0);
});
test("timeout races a signal-ignoring POST and no late host capability runs", async () => {
  const f = fixture(), response = deferred<Response>(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = (url, init) => init.method === "POST" ? response.promise : fetch(url, init);
  const r = await f.run({ timeoutMs: 15, heartbeatMs: 100 }); assert.equal(r.status, "hold"); const effects = structuredClone(f.counts), records = f.evidence.length;
  response.resolve(Response.json({ id: "late", etag: '"late"' }, { status: 201 })); await pause(20); assert.deepEqual(f.counts, effects); assert.equal(f.evidence.length, records);
});
test("a committed ACK wins cancellation without a second finish", async () => {
  const f = fixture(), controller = new AbortController(); f.host.ack = async () => { f.counts.acks++; controller.abort(); return { kind: "acknowledged" }; };
  assert.equal((await f.run({ signal: controller.signal })).status, "acked"); assert.equal(f.counts.acks, 1); assert.equal(f.counts.finishes, 0);
});
for (const profile of ["existing-google", "strict-reference"] as const) test(`CREATE ${profile} evidence preserves valid ignored metadata outside admission bounds`, async () => {
  const f = fixture(), fetch = f.transport.http.fetch;
  Object.assign(f.policy, { nativeProfile: profile });
  let nested: unknown = "leaf"; for (let i = 0; i < 20; i++) nested = { child: nested };
  const metadata = { array: Array.from({ length: 257 }, (_, i) => i), fields: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`field${i}`, i])), nested };
  f.transport.http.fetch = async (url, init) => url.endsWith("/tasks/created") ? Response.json({ id: "created", etag: '"v2"', ...f.target, ignoredMetadata: metadata }) : fetch(url, init);
  const r = await f.run(); assert.equal(r.status, "acked"); assert.equal(f.acks[0]?.read.task.ignoredMetadata !== undefined, true);
  assert.deepEqual(f.acks[0]?.read.task.ignoredMetadata, metadata);
});
test("native evidence snapshot freezes shared JSON but never evaluates getters or accepts cycles", () => {
  const shared = { value: 1 }, source = { first: shared, second: shared }, result = copyNativeTaskEvidence(source);
  assert.equal(result.first, result.second); assert(Object.isFrozen(result.first)); source.first.value = 2; assert.equal(result.first.value, 1);
  let reads = 0; const getter = Object.defineProperty({}, "private", { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => copyNativeTaskEvidence(getter)); assert.equal(reads, 0);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; assert.throws(() => copyNativeTaskEvidence(cycle));
});
test("existing CREATE response identity does not inherit an admission-plan string limit", async () => {
  const f = fixture(), taskId = "x".repeat(2_000_001), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => init.method === "POST" ? Response.json({ id: taskId, etag: '"response"' }, { status: 201 }) :
    url.includes("/users/@me/") ? fetch(url, init) : Response.json({ id: taskId, etag: '"read"', ...f.target });
  const r = await f.run(); assert.equal(r.status, "acked"); assert.equal(r.facts.writerResult?.taskId.length, taskId.length);
});
for (const profile of ["existing-google", "strict-reference"] as const) test(`CREATE ${profile} retains its native parser floor for overflowing JSON exponent metadata`, async () => {
  const f = fixture(), fetch = f.transport.http.fetch; Object.assign(f.policy, { nativeProfile: profile });
  f.transport.http.fetch = async (url, init) => url.endsWith("/tasks/created") ? new Response(
    `${JSON.stringify({ id: "created", etag: '"v2"', ...f.target }).slice(0, -1)},"ignoredNumericMetadata":1e400}`,
    { status: 200, headers: { "content-type": "application/json" } }) : fetch(url, init);
  assert.equal((await f.run()).status, profile === "existing-google" ? "acked" : "hold");
});
