import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { diffGoogleTaskProjection } from "@musubi/provider-google";
import { runClaimedGoogleTaskUpdate, supportsGoogleTaskUpdateEnvelope } from "./google-task-update";
import type { ClaimedGoogleTaskUpdate, GoogleTaskUpdateHostPorts, GoogleTaskUpdatePolicy, GoogleTaskRuntimeProviderPorts, RuntimeTaskFinishOutcome } from "./google-task-update-ports";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(collection = "list", mode: ClaimedGoogleTaskUpdate["collectionIdentity"] = "native") {
  const task = TaskSchema.parse({ id: "independent-task", creatorID: "owner", calendarID: "home", title: "After", description: "Keep", status: "in-process", due: "2026-10-26T14:45:00Z", priority: 2 });
  const encoded = encodeTaskV1("google", task, undefined, { action: "update", operationId, acceptedAt: "2026-10-25T12:00:00.000Z" });
  const target = structuredClone(encoded.admittedProjection.data) as { title: string; notes: string; status: "needsAction"; due: string };
  const baseline = { ...target, title: "Before" }, patch = { title: "After" };
  const logicalCollection = mode === "native" ? collection : `musubi-google-task-list:${collection}`;
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "update", version: 1 },
    operationId, commandId: "command", hostObjectId: task.id, locator: { provider: "google", connectionId: "logical", collectionId: logicalCollection, resourceId: "task" },
    sourceEpoch: { sourceId: "source", generation: 1 }, privacyEpoch: "private", acceptedRevision: 2, allowedSideEffects: ["provider-content-write"], ...encoded });
  const input: ClaimedGoogleTaskUpdate = { operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "task", action: "update", operationId, commandId: "command", hostObjectId: task.id, provider: "google", connectionId: "logical", collectionId: logicalCollection, resourceId: "task", acceptedRevision: 2, predecessorOperationId: null },
    nativeTarget: { connectionId: "physical", connectionGeneration: "1", taskListId: collection, taskId: "task" }, collectionIdentity: mode,
    acceptedEtag: '"v1"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
  const counts = { prepare: 0, sessions: 0, marks: 0, acks: 0, finishes: 0 }, calls: { url: string; method: string; body: unknown; etag: string | null }[] = [];
  const finishes: RuntimeTaskFinishOutcome[] = [];
  const host: GoogleTaskUpdateHostPorts = {
    async prepare() { counts.prepare++; return { acceptedEtag: '"v1"', baseline, saved: { projection: target, baseline, patch } }; },
    async prepareProjection(item) { return item.saved ?? { projection: item.target, baseline: item.baseline, patch: diffGoogleTaskProjection(item.baseline, item.target) }; },
    renew: async () => true,
    accountSession: { async open(connection) { counts.sessions++; return { ...connection, accessToken: "fixture", taskWriteAllowed: true }; } },
    async beforeMutation() { counts.marks++; }, async recordEvidence() {},
    async ack() { counts.acks++; return { kind: "acknowledged" }; }, async finish(outcome) { counts.finishes++; finishes.push(outcome); }, observationId: () => "observation",
  };
  const transport: GoogleTaskRuntimeProviderPorts = {
    http: { async fetch(url, init) {
      const method = init.method ?? "GET";
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null, etag: new Headers(init.headers).get("If-Match") });
      if (method === "PATCH") return Response.json({ etag: '"v2"' });
      return Response.json({ id: "task", etag: calls.some(call => call.method === "PATCH") ? '"v2"' : '"v1"', ...(calls.some(call => call.method === "PATCH") ? target : baseline) });
    } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} },
  };
  const policy: GoogleTaskUpdatePolicy = { nativeProfile: "existing-google", readback: "saved-patch", ambiguousRecovery: "deferred" };
  return { input, envelope, host, transport, policy, counts, calls, finishes, target, baseline, patch,
    run: (options = {}) => runClaimedGoogleTaskUpdate(input, host, transport, policy, options) };
}

test("task runtime snapshots admitted inputs and policy before asynchronous prepare", async () => {
  const f = fixture(), started = deferred<void>(), resume = deferred<void>(), originalPrepare = f.host.prepare;
  f.host.prepare = async signal => { started.resolve(); await resume.promise; return originalPrepare(signal); };
  const pending = f.run(); await started.promise;
  (f.envelope.nativePlan.data as any).body.title = "Changed later";
  (f.envelope.admittedProjection.data as any).title = "Changed later";
  (f.input.nativeTarget as any).taskId = "Other";
  (f.policy as any).readback = "full-target";
  resume.resolve();
  assert.equal((await pending).status, "acked");
  assert.deepEqual(f.calls.map(call => call.method), ["GET", "GET", "GET", "PATCH", "GET"]);
  assert.deepEqual(f.calls[3]!.body, { title: "After" }); assert.equal(f.calls[3]!.etag, '"v1"');
  assert(f.calls.every(call => call.url.endsWith("/tasks/task")));
});

test("task runtime does not evaluate admitted accessors", async () => {
  const f = fixture(); let getters = 0;
  Object.defineProperty(f.envelope.nativePlan.data, "body", { enumerable: true, get() { getters++; throw new Error("private"); } });
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(getters, 0);
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.sessions, 0); assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(result).includes("private"));
});

test("nominally selected task plan cannot fall back when projection and native body disagree", async () => {
  const f = fixture(); (f.envelope.nativePlan.data as any).body.title = "Different";
  assert.equal(supportsGoogleTaskUpdateEnvelope(f.envelope), true);
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.prepare, 0); assert.equal(f.calls.length, 0);
});

test("forged saved patch is refused before credentials or native HTTP", async () => {
  const f = fixture(); f.host.prepare = async () => ({ acceptedEtag: '"v1"', baseline: f.baseline,
    saved: { projection: f.target, baseline: f.baseline, patch: { title: "Forged" } } });
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.sessions, 0); assert.equal(f.calls.length, 0);
});

test("host late preparation cannot substitute values or rebase a saved mask", async () => {
  const f = fixture(); f.host.prepareProjection = async () => ({ projection: f.target, baseline: f.baseline, patch: { notes: "Keep" } });
  assert.equal((await f.run()).status, "hold"); assert.equal(f.calls.length, 1); assert.equal(f.counts.marks, 0); assert.equal(f.counts.acks, 0);
});

for (const mode of ["native", "musubi-google-task-list"] as const) test(`explicit ${mode} collection mapping preserves prefix-looking physical IDs`, async () => {
  const f = fixture("musubi-google-task-list:physical", mode);
  assert.equal((await f.run()).status, "acked");
  assert(f.calls.every(call => call.url.includes("/lists/musubi-google-task-list%3Aphysical/tasks/task")));
});

test("collection mode and physical address mismatch refuses all host/native effects", async () => {
  const f = fixture(); (f.input as any).collectionIdentity = "musubi-google-task-list";
  assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.prepare, 0); assert.equal(f.counts.sessions, 0); assert.equal(f.calls.length, 0);
});

test("accepted response survives failure to persist its pre-parse evidence", async () => {
  const f = fixture(); f.host.recordEvidence = async facts => { if (facts.acceptedStatus) throw new Error("private storage failure"); };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "accepted");
  assert.equal(result.facts.acceptedStatus, 200); assert.equal(result.facts.possibleDispatch, true);
  assert.deepEqual(result.facts.provider, { kind: "accepted", validator: null });
  assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1); assert.equal(f.calls.length, 4);
  assert(!JSON.stringify(result).includes("private storage failure"));
});

test("late signal-ignoring readback cannot ACK or settle twice", async () => {
  const f = fixture(), reached = deferred<void>(), release = deferred<void>(), controller = new AbortController();
  const fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => {
    if (f.calls.some(call => call.method === "PATCH")) { reached.resolve(); await release.promise; }
    return fetch(url, init);
  };
  const pending = f.run({ signal: controller.signal }); await reached.promise; controller.abort();
  const result = await pending; assert.equal(result.status, "hold"); assert.equal(result.facts.provider.kind, "accepted");
  assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1);
  release.resolve(); await pause(10); assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1);
});

test("acknowledged atomic host result wins a racing abort", async () => {
  const f = fixture(), controller = new AbortController();
  f.host.ack = async (_evidence, signal) => { assert.equal(signal.aborted, false); controller.abort(); return { kind: "acknowledged" }; };
  assert.equal((await f.run({ signal: controller.signal })).status, "acked"); assert.equal(f.counts.finishes, 0);
});

test("false ACK retains exact observed ref and projection in terminal native facts", async () => {
  const f = fixture(); f.host.ack = async evidence => { assert.equal(evidence.validator, '"v2"'); return { kind: "mapping-conflict" }; };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.error?.code, "runtime-ack-authority-changed");
  assert.equal(result.facts.remote.kind, "confirmed");
  assert.deepEqual(result.facts.remote.projection, f.target); assert.equal(result.facts.remote.read.kind, "present");
  assert.equal(f.counts.finishes, 1);
});

test("a new unknown dispatch supersedes prior rejection even under deferred recovery policy", async () => {
  const f = fixture();
  (f.input as any).recovery = { required: true, possibleDispatch: true };
  (f.input as any).priorProvider = { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 90_000 } };
  const fetch = f.transport.http.fetch;
  f.transport.http.fetch = async (url, init) => { const response = await fetch(url, init); if (init.method === "PATCH") throw new TypeError("lost reply"); return response; };
  const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.error?.outcome, "unconfirmed");
  assert.deepEqual(result.facts.provider, { kind: "uncertain" }); assert.equal(result.facts.possibleDispatch, true);
  assert.equal(result.facts.acceptedStatus, undefined); assert.equal(f.counts.acks, 0); assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
});
