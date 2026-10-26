import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { TaskSchema, SyncOperationEnvelopeSchema, type SyncOperationRowBinding } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { diffGoogleTaskProjection } from "@musubi/provider-google";
import { runClaimedGoogleTaskUpdate, supportsGoogleTaskUpdateEnvelope } from "./google-task-update";
import { runClaimedGoogleTaskDelete, supportsGoogleTaskDeleteEnvelope } from "./google-task-delete";
import { SyncRuntimeHostError } from "./ports";
import type { GoogleTaskPredecessorAddress, GoogleTaskPreparation } from "./google-task-address-ports";
import type { GoogleTaskUpdateHostPorts, RuntimeTaskCompletionEvidence } from "./google-task-update-ports";
import type { GoogleTaskDeleteHostPorts, RuntimeTaskDeleteCompletionEvidence, RuntimeAttemptOptions } from "./google-task-delete-ports";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(action: "update" | "delete", strict = false, taskId = "native/task") {
  const canonical = TaskSchema.parse({ id: "independent-task", creatorID: "owner", calendarID: "home", revision: 3, title: "After",
    description: "Notes", status: "in-process", due: "2026-10-26T14:45:00.123Z", start: "2026-10-25T10:11:12.456Z", priority: 2, percentComplete: 37 });
  const encoded = encodeTaskV1("google", canonical, undefined, { action, operationId, acceptedAt: "2026-10-26T12:00:00.000Z" });
  const projection = encoded.admittedProjection.data as { title: string; notes: string; status: "needsAction"; due: string };
  const baseline: Record<string, unknown> = { ...projection, title: "Before" };
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action, version: 1 },
    commandId: "new-command", operationId, hostObjectId: canonical.id, locator: { provider: "google", connectionId: "logical", collectionId: "list/?#", resourceId: null },
    predecessorOperationId: "prior-create", sourceEpoch: { sourceId: "reserved-source", generation: 1 }, privacyEpoch: "private:0", acceptedRevision: 3,
    allowedSideEffects: ["provider-content-write"], ...encoded });
  const binding: SyncOperationRowBinding = { kind: "task", action, operationId, commandId: "new-command", hostObjectId: canonical.id,
    provider: "google", connectionId: "logical", collectionId: "list/?#", resourceId: null, acceptedRevision: 3, predecessorOperationId: "prior-create",
    sourceEpoch: { sourceId: "reserved-source", generation: 1 }, privacyEpoch: "private:0" };
  const proof: GoogleTaskPredecessorAddress = { kind: "predecessor-task-reference", operationId, attemptId: "attempt", predecessorOperationId: "prior-create",
    evidenceOperationId: "prior-create", taskId, validator: '"v1"', projectionBaseline: baseline, witness: "host-complete-scoped-history" };
  const input = { operationId, attemptId: "attempt", binding, payload: { operationEnvelope: envelope },
    nativeTarget: { connectionId: "physical", connectionGeneration: "7", taskListId: "list/?#", taskId: null }, collectionIdentity: "native" as const,
    acceptedEtag: null, recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" as const } };
  const calls: { method: string; url: string; etag: string | null; body: unknown }[] = [];
  const counts = { prepare: 0, sessions: 0, marks: 0, finishes: 0, acks: 0 }, completions: (RuntimeTaskCompletionEvidence | RuntimeTaskDeleteCompletionEvidence)[] = [];
  let written = false, deleted = false;
  const host: GoogleTaskUpdateHostPorts & GoogleTaskDeleteHostPorts = {
    async prepare() { counts.prepare++; return { acceptedEtag: proof.validator, baseline, predecessorAddress: proof }; },
    async prepareProjection(value) { return value.saved ?? { projection: value.target, baseline: value.baseline, patch: diffGoogleTaskProjection(value.baseline, value.target) }; },
    renew: async () => true, accountSession: { async open(connection) { counts.sessions++; return { ...connection, accessToken: "fixture-token", taskWriteAllowed: true }; } },
    async beforeMutation() { counts.marks++; }, async recordEvidence() {},
    async ack(evidence) { counts.acks++; completions.push(evidence); return { kind: "acknowledged" }; },
    async finish() { counts.finishes++; }, observationId: () => "actual-native-observation",
  };
  const transport = { http: { async fetch(url: string, init: RequestInit) {
    const method = init.method ?? "GET"; calls.push({ method, url, etag: new Headers(init.headers).get("If-Match"), body: init.body ? JSON.parse(String(init.body)) : null });
    if (method === "PATCH") { written = true; return Response.json({ etag: '"v2"' }); }
    if (method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (deleted) return new Response(null, { status: 404 });
    return Response.json({ id: taskId, etag: written ? '"v2"' : '"v1"', ...(written ? projection : baseline) });
  } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  const nativeProfile = strict ? "strict-reference" as const : "existing-google" as const;
  const run = (options: RuntimeAttemptOptions = {}) => action === "update" ? runClaimedGoogleTaskUpdate(input, host, transport,
    { nativeProfile, readback: strict ? "full-target" : "saved-patch", ambiguousRecovery: "deferred" }, options) :
    runClaimedGoogleTaskDelete(input, host, transport, { nativeProfile, completion: strict ? "exact-absence" : "provider-response", ambiguousRecovery: "deferred", knownResponseRecovery: strict ? "observe-only" : "conditional-retry" }, options);
  return { input, envelope, binding, canonical, projection, baseline, proof, host, transport, calls, counts, completions, run };
}

for (const action of ["update", "delete"] as const) {
  for (const strict of [false, true]) test(`causal ${action} ${strict ? "strict" : "existing"} keeps null admission and rich canonical data`, async () => {
    const f = fixture(action, strict), original = structuredClone({ envelope: f.envelope, binding: f.binding, canonical: f.canonical });
    assert.equal(action === "update" ? supportsGoogleTaskUpdateEnvelope(f.envelope) : supportsGoogleTaskDeleteEnvelope(f.envelope), true);
    const result = await f.run(); assert.equal(result.status, "acked");
    assert.deepEqual({ envelope: f.envelope, binding: f.binding, canonical: f.canonical }, original);
    assert.deepEqual(f.calls.map(c => c.method), action === "update" ? ["GET", "GET", "GET", "PATCH", "GET"] : strict ? ["GET", "GET", "GET", "DELETE", "GET"] : ["GET", "GET", "GET", "DELETE"]);
    assert(f.calls.every(c => c.url === "https://tasks.googleapis.com/tasks/v1/lists/list%2F%3F%23/tasks/native%2Ftask"));
    assert.equal(f.calls[3]!.etag, '"v1"'); if (action === "update") assert.deepEqual(f.calls[3]!.body, { title: "After" });
  });

  const invalidProofs: [string, (prepared: GoogleTaskPreparation) => GoogleTaskPreparation][] = [
    ["missing", p => ({ ...p, predecessorAddress: undefined })],
    ["operation", p => ({ ...p, predecessorAddress: { ...p.predecessorAddress!, operationId: "other" } })],
    ["attempt", p => ({ ...p, predecessorAddress: { ...p.predecessorAddress!, attemptId: "other" } })],
    ["edge", p => ({ ...p, predecessorAddress: { ...p.predecessorAddress!, predecessorOperationId: "other" } })],
    ["self", p => ({ ...p, predecessorAddress: { ...p.predecessorAddress!, evidenceOperationId: operationId } })],
    ["validator", p => ({ ...p, acceptedEtag: '"newer"' })],
    ["baseline", p => ({ ...p, baseline: { title: "Other", notes: "Notes", due: null, status: "needsAction" } })],
    ["coherent saved mask", p => { const baseline = { title: "After", notes: "Notes", due: "2026-10-26T00:00:00.000Z", status: "needsAction" };
      return { ...p, saved: { projection: baseline, baseline, patch: {} } }; }],
  ];
  for (const [label, change] of invalidProofs) test(`causal ${action} refuses ${label} proof before sessions or native effects`, async () => {
    const f = fixture(action), prepare = f.host.prepare; f.host.prepare = async signal => change(await prepare(signal));
    assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.sessions, 0); assert.equal(f.calls.length, 0); assert.equal(f.counts.finishes, 1);
  });

  test(`causal ${action} proof accessors are never evaluated`, async () => {
    const f = fixture(action); let getters = 0;
    Object.defineProperty(f.proof, "witness", { enumerable: true, get() { getters++; throw new Error("private"); } });
    assert.equal((await f.run()).status, "hold"); assert.equal(getters, 0); assert.equal(f.counts.sessions, 0); assert.equal(f.calls.length, 0);
  });
  test(`causal ${action} snapshots the native pair before credentials`, async () => {
    const f = fixture(action), open = f.host.accountSession.open;
    f.host.accountSession.open = async (connection, signal) => {
      (f.proof as { taskId: string; validator: string }).taskId = "changed-later";
      (f.proof as { validator: string }).validator = '"newer"';
      return open(connection, signal);
    };
    assert.equal((await f.run()).status, "acked");
    assert(f.calls.every(c => c.url.endsWith("/tasks/native%2Ftask"))); assert.equal(f.calls[3]!.etag, '"v1"');
  });
  for (const strict of [false, true]) test(`causal ${action} ${strict ? "strict" : "legacy-compatible"} null baseline is explicit`, async () => {
    const f = fixture(action, strict);
    f.host.prepare = async () => ({ acceptedEtag: '"v1"', baseline: null, predecessorAddress: { ...f.proof, projectionBaseline: null } });
    assert.equal((await f.run()).status, strict ? "hold" : "acked"); if (strict) assert.equal(f.counts.sessions, 0);
  });
  test(`causal ${action} malformed selected plan holds before preparation`, async () => {
    const f = fixture(action); (f.envelope.nativePlan.data as Record<string, unknown>).body = { title: "Forged" };
    assert.equal((await f.run()).status, "hold"); assert.equal(f.counts.prepare, 0); assert.equal(f.counts.sessions, 0);
  });
  test(`causal ${action} late resolution cannot restart a timed-out attempt`, async () => {
    const f = fixture(action), entered = deferred<void>(), release = deferred<void>(), prepare = f.host.prepare;
    f.host.prepare = async signal => { entered.resolve(); await release.promise; return prepare(signal); };
    const pending = f.run({ timeoutMs: 10, heartbeatMs: 2 }); await entered.promise;
    assert.equal((await pending).status, "hold"); assert.equal(f.counts.finishes, 1); assert.equal(f.counts.sessions, 0);
    release.resolve(); await pause(15); assert.equal(f.calls.length, 0); assert.equal(f.counts.acks, 0); assert.equal(f.counts.finishes, 1);
  });
  test(`causal ${action} host dispatch witness rejection keeps native facts truthful`, async () => {
    const f = fixture(action); f.host.beforeMutation = async () => { throw new SyncRuntimeHostError({ code: "task-source-changed", outcome: "not-written" }); };
    const result = await f.run(); assert.equal(result.status, "hold"); assert.equal(result.facts.possibleDispatch, false);
    assert.equal(result.facts.provider.kind, "not-dispatched"); assert.deepEqual(f.calls.map(c => c.method), ["GET", "GET", "GET"]);
  });
  for (const length of [2049, 2_000_001]) for (const strict of [false, true]) test(`causal ${action} ${length}-unit native ID has the explicit ${strict ? "strict" : "existing"} floor`, async () => {
    const taskId = "x".repeat(length), f = fixture(action, strict, taskId), result = await f.run();
    assert.equal(result.status, strict ? "hold" : "acked");
    if (strict) { assert.equal(f.counts.sessions, 0); assert.equal(f.calls.length, 0); }
    else assert(f.calls.every(c => c.url.endsWith(`/tasks/${taskId}`)));
  });
  test(`causal ${action} native metadata has no admission depth, field or array limits`, async () => {
    const f = fixture(action), fetch = f.transport.http.fetch;
    f.transport.http.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (init.method !== "GET" || response.status !== 200) return response;
      const task = await response.json(), metadata: Record<string, unknown> = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key${i}`, i]));
      metadata.array = Array.from({ length: 257 }, (_, i) => i); let nested: Record<string, unknown> = metadata;
      for (let i = 0; i < 20; i++) nested = { nested };
      return new Response(JSON.stringify({ ...task, ignored: nested }).replace(/}$/, ',"overflowingExponent":1e400}'), { status: 200 });
    };
    assert.equal((await f.run()).status, "acked");
  });
}

for (const action of ["update", "delete"] as const) for (const strict of [false, true]) test(`no-task predecessor ${action} ${strict ? "strict" : "existing"} never invents native absence`, async () => {
  const f = fixture(action, strict);
  f.host.prepare = async () => ({ acceptedEtag: null, baseline: null, predecessorAddress: { kind: "predecessor-no-task", operationId, attemptId: "attempt",
    predecessorOperationId: "prior-create", evidenceOperationId: "prior-create", witness: "complete-no-write-create-history" } });
  const result = await f.run(), allowed = action === "delete" && !strict;
  assert.equal(result.status, allowed ? "acked" : "hold"); assert.equal(f.calls.length, 0); assert.equal(f.counts.sessions, 0);
  assert.equal(result.facts.provider.kind, "not-dispatched"); assert.equal(result.facts.remote.kind, "unobserved"); assert.equal(result.facts.possibleDispatch, false);
  if (allowed) assert.equal(f.completions[0]!.kind, "predecessor-no-resource");
});
