import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { runClaimedGoogleTaskDelete, supportsGoogleTaskDeleteEnvelope } from "./google-task-delete";
import type { ClaimedGoogleTaskDelete, GoogleTaskDeleteHostPorts, GoogleTaskDeleteRuntimeProviderPorts, GoogleTaskDeletePolicy,
  RuntimeTaskDeleteCompletionEvidence, RuntimeTaskDeleteFinishOutcome, RuntimeAttemptOptions } from "./google-task-delete-ports";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(collection = "list", mode: ClaimedGoogleTaskDelete["collectionIdentity"] = "native") {
  const task = TaskSchema.parse({ id: "independent-task", creatorID: "owner", calendarID: "home", title: "Canonical title", description: "Keep", status: "in-process", due: "2026-10-26T14:45:00Z", priority: 2 });
  const encoded = encodeTaskV1("google", task, undefined, { action: "delete", operationId, acceptedAt: "2026-10-25T12:00:00.000Z" });
  const baseline = { ...structuredClone(encoded.admittedProjection.data), title: "Before" };
  const logicalCollection = mode === "native" ? collection : `musubi-google-task-list:${collection}`;
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "delete", version: 1 },
    operationId, commandId: "command", hostObjectId: task.id, locator: { provider: "google", connectionId: "logical", collectionId: logicalCollection, resourceId: "task" },
    sourceEpoch: { sourceId: "source", generation: 1 }, privacyEpoch: "private", acceptedRevision: 2, allowedSideEffects: ["provider-content-write"], ...encoded });
  const input: ClaimedGoogleTaskDelete = { operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "task", action: "delete", operationId, commandId: "command", hostObjectId: task.id, provider: "google", connectionId: "logical", collectionId: logicalCollection, resourceId: "task", acceptedRevision: 2, predecessorOperationId: null },
    nativeTarget: { connectionId: "physical", connectionGeneration: "1", taskListId: collection, taskId: "task" }, collectionIdentity: mode,
    acceptedEtag: '"v1"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
  const counts = { prepare: 0, sessions: 0, marks: 0, acks: 0, finishes: 0 }, acks: RuntimeTaskDeleteCompletionEvidence[] = [], finishes: RuntimeTaskDeleteFinishOutcome[] = [];
  const host: GoogleTaskDeleteHostPorts = {
    async prepare() { counts.prepare++; return { acceptedEtag: input.acceptedEtag, baseline }; }, renew: async () => true,
    accountSession: { async open(connection) { counts.sessions++; return { ...connection, accessToken: "fixture", taskWriteAllowed: true }; } },
    async beforeMutation() { counts.marks++; }, async recordEvidence() {},
    async ack(evidence) { counts.acks++; acks.push(evidence); return { kind: "acknowledged" }; },
    async finish(outcome) { counts.finishes++; finishes.push(outcome); }, observationId: () => "observation",
  };
  const calls: { method: string; url: string; body: unknown; etag: string | null }[] = [];
  const transport: GoogleTaskDeleteRuntimeProviderPorts = { http: { async fetch(url, init) {
    const method = init.method ?? "GET"; calls.push({ method, url, body: init.body ?? null, etag: new Headers(init.headers).get("If-Match") });
    return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "task", etag: '"v1"', ...baseline });
  } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  const policy: GoogleTaskDeletePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-google", knownResponseRecovery: "conditional-retry" };
  return { input, envelope, baseline, host, transport, policy, counts, calls, acks, finishes,
    run: (options: RuntimeAttemptOptions = {}) => runClaimedGoogleTaskDelete(input, host, transport, policy, options) };
}
test("DELETE snapshots admitted identity, null plan and completion policy before asynchronous prepare", async () => {
  const f = fixture(), reached = deferred<void>(), resume = deferred<void>(), prepare = f.host.prepare;
  f.host.prepare = async signal => { reached.resolve(); await resume.promise; return prepare(signal); };
  const pending = f.run(); await reached.promise;
  (f.input.nativeTarget as any).taskId = "Other"; (f.envelope.nativePlan.data as any).body = { title: "Injected" }; (f.policy as any).completion = "exact-absence";
  resume.resolve(); const result = await pending; assert.equal(result.status, "acked");
  assert.deepEqual(f.calls.map(x => x.method), ["GET", "GET", "GET", "DELETE"]); assert(f.calls.every(x => x.url.endsWith("/tasks/task")));
  assert.equal(f.calls[3]!.etag, '"v1"'); assert.equal(f.calls[3]!.body, null); assert.equal(result.facts.remote.kind, "unobserved");
});
test("present malformed DELETE stays nominally selected and refuses all preparation/HTTP", async () => {
  const f = fixture(); (f.envelope.nativePlan.data as any).body = {};
  assert.equal(supportsGoogleTaskDeleteEnvelope(f.envelope), true); assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.prepare, 0); assert.equal(f.calls.length, 0);
});
test("DELETE input accessors never run", async () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.input.nativeTarget, "taskId", { enumerable: true, get() { calls++; throw new Error("private"); } });
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(calls, 0); assert.equal(f.counts.prepare, 0); assert.equal(f.counts.sessions, 0);
});
for (const mode of ["native", "musubi-google-task-list"] as const) test(`DELETE ${mode} mapping preserves a prefix-looking physical ID`, async () => {
  const f = fixture("musubi-google-task-list:physical", mode); assert.equal((await f.run()).status, "acked");
  assert(f.calls.every(x => x.url.includes("/lists/musubi-google-task-list%3Aphysical/")));
});
test("DELETE mismatched collection mode has zero preparation/credentials/HTTP", async () => {
  const f = fixture(); (f.input as any).collectionIdentity = "musubi-google-task-list";
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.prepare, 0); assert.equal(f.calls.length, 0);
});
test("initial absence ACKs without original validator, dispatch or response acceptance", async () => {
  const f = fixture(); (f.input as any).acceptedEtag = null;
  f.transport.http.fetch = async () => new Response(null, { status: 410 });
  const result = await f.run(); assert.equal(result.status, "acked"); assert.deepEqual(result.facts.provider, { kind: "not-dispatched" });
  assert.equal(result.facts.possibleDispatch, false); assert.equal(result.facts.acceptedStatus, undefined); assert.equal(result.facts.responseAbsenceStatus, undefined);
  assert.equal(f.acks[0]?.kind, "exact-absence"); if (f.acks[0]?.kind === "exact-absence") assert.equal(f.acks[0].source, "initial-read");
});
test("writer-final absence remains no-dispatch but retains the exact writer return", async () => {
  const f = fixture(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => f.calls.length === 2 ? new Response(null, { status: 404 }) : fetch(url, init);
  const result = await f.run(); assert.equal(result.status, "acked"); assert.equal(f.counts.sessions, 3); assert.equal(f.counts.marks, 0);
  assert.deepEqual(result.facts.writerResult, { kind: "absent", status: 404, source: "writer-read" }); assert.equal(result.facts.possibleDispatch, false);
  assert.equal(result.facts.remote.kind, "absent"); assert.equal(result.facts.provider.kind, "not-dispatched");
});
test("a raw DELETE404 receipt does not fabricate a subsequent GET absence", async () => {
  const f = fixture(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => init.method === "DELETE" ? new Response(null, { status: 404 }) : fetch(url, init);
  const result = await f.run(); assert.equal(result.status, "acked"); assert.equal(result.facts.provider.kind, "accepted"); assert.equal(result.facts.acceptedStatus, undefined);
  assert.equal(result.facts.responseAbsenceStatus, 404); assert.equal(result.facts.remote.kind, "unobserved"); assert.equal(result.facts.possibleDispatch, true);
});
for (const sidecar of ["priorAcceptedStatus", "priorResponseAbsenceStatus"] as const) test(`known ${sidecar} reference recovery observes only when resource is present`, async () => {
  const f = fixture(); (f.input as any).recovery = { required: true, possibleDispatch: true }; (f.input as any).priorProvider = { kind: "accepted", validator: null };
  (f.input as any)[sidecar] = sidecar === "priorAcceptedStatus" ? 202 : 410; (f.policy as any).knownResponseRecovery = "observe-only";
  const result = await f.run(); assert.equal(result.status, "hold"); assert.deepEqual(f.calls.map(x => x.method), ["GET"]); assert.equal(f.counts.marks, 0); assert.equal(result.facts.provider.kind, "accepted");
});
test("prior 2xx acceptance and DELETE absence sidecars both survive a current429", async () => {
  const f = fixture(); (f.input as any).recovery = { required: true, possibleDispatch: true }; (f.input as any).priorProvider = { kind: "accepted", validator: null };
  (f.input as any).priorAcceptedStatus = 202; (f.input as any).priorResponseAbsenceStatus = 410;
  const fetch = f.transport.http.fetch; f.transport.http.fetch = async (url, init) => init.method === "DELETE" ? new Response(null, { status: 429, headers: { "retry-after": "90" } }) : fetch(url, init);
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.error?.outcome, "not-written"); assert.equal(result.error?.retryAfterMs, 90_000);
  assert.equal(result.facts.acceptedStatus, 202); assert.equal(result.facts.responseAbsenceStatus, 410); assert.equal(result.facts.provider.kind, "accepted");
});
test("new unknown DELETE supersedes an older rejection under deferred policy", async () => {
  const f = fixture(); (f.input as any).recovery = { required: true, possibleDispatch: true }; (f.input as any).priorProvider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 90_000 } };
  const fetch = f.transport.http.fetch; f.transport.http.fetch = async (url, init) => { if (init.method === "DELETE") throw new TypeError("lost"); return fetch(url, init); };
  const result = await f.run(); assert.equal(result.error?.outcome, "unconfirmed"); assert.deepEqual(result.facts.provider, { kind: "uncertain" }); assert.equal(result.facts.possibleDispatch, true);
});
test("accepted DELETE response remains factual when its evidence persistence fails", async () => {
  const f = fixture(); f.host.recordEvidence = async facts => { if (facts.acceptedStatus) throw new Error("private failure"); };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.facts.acceptedStatus, 204); assert.equal(result.facts.provider.kind, "accepted");
  assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1); assert(!JSON.stringify(result).includes("private failure"));
});
test("late signal-ignoring writer-final GET cannot call DELETE, ACK or settle twice", async () => {
  const f = fixture(), reached = deferred<void>(), resume = deferred<void>(), controller = new AbortController(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => { if (f.calls.length === 2) { reached.resolve(); await resume.promise; return new Response(null, { status: 404 }); } return fetch(url, init); };
  const pending = f.run({ signal: controller.signal }); await reached.promise; controller.abort(); const result = await pending;
  assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "not-dispatched"); assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1);
  resume.resolve(); await pause(10); assert.equal(f.counts.marks, 0); assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1);
});
test("committed DELETE ACK wins an abort racing its return", async () => {
  const f = fixture(), controller = new AbortController(); f.host.ack = async () => { controller.abort(); return { kind: "acknowledged" }; };
  assert.equal((await f.run({ signal: controller.signal })).status, "acked"); assert.equal(f.counts.finishes, 0);
});
test("false ACK after writer absence retains no-dispatch facts and caller-return proof", async () => {
  const f = fixture(), fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => f.calls.length === 2 ? new Response(null, { status: 404 }) : fetch(url, init);
  f.host.ack = async () => ({ kind: "mapping-conflict" }); const result = await f.run();
  assert.equal(result.status, "hold"); assert.equal(result.error?.code, "runtime-ack-authority-changed"); assert.equal(result.facts.possibleDispatch, false);
  assert.equal(result.facts.provider.kind, "not-dispatched"); assert.equal(result.facts.writerResult?.kind, "absent"); assert.equal(f.counts.finishes, 1);
});
