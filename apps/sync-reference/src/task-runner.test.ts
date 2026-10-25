import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptedTaskEnvelope, REFERENCE_TASK_UPDATE_PROFILE, taskSavedProjection } from "./task-admission.js";
import { initialReceipt } from "./admission.js";
import { deliverReferenceTaskUpdate, type ReferenceTaskRunnerStore } from "./task-runner.js";
import { deliverReferenceOperation, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceTaskClaim } from "./task-model.js";
function fixture() {
  const operationId = randomUUID(), input = { operationId, commandId: "task-command", bindingId: "task-binding", expectedRevision: 1, patch: { name: "New title" } };
  const capture = { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 1 };
  const content = { name: "New title", notes: null, state: "doing" as const, dueAt: null, importance: "high" as const };
  const envelope = acceptedTaskEnvelope(input, content, { objectId: "task-object", connectionId: "task-connection", taskListId: "task-list", taskId: "native-task", capture });
  const claim: ReferenceTaskClaim = { operationId, attemptId: "task-attempt", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, payload: { operationEnvelope: envelope },
    binding: { kind: "task", action: "update", operationId, commandId: input.commandId, hostObjectId: "task-object", provider: "google", connectionId: "task-connection", collectionId: "task-list", resourceId: "native-task", acceptedRevision: 2, sourceEpoch: { sourceId: input.bindingId, generation: 1 }, privacyEpoch: "1" },
    capture, locator: { connectionId: "task-connection", taskListId: "task-list", taskId: "native-task" }, acceptedEtag: '"before"', saved: taskSavedProjection(envelope.admittedProjection.data, { title: "Before", notes: null, due: null, status: "needsAction" }), receipt: initialReceipt(envelope), recovery: false, acceptedStatus: null };
  let claims = 0, preparations = 0, credentials = 0, http = 0, finished: unknown;
  const store: ReferenceTaskRunnerStore = {
    async claim() { claims++; return claim; }, async prepare() { preparations++; return { acceptedEtag: claim.acceptedEtag, baseline: claim.saved.baseline, saved: claim.saved }; },
    async renew() { return true; }, async getSession() { credentials++; throw new Error("Unexpected credential access"); }, async markDispatch() { throw new Error("Unexpected dispatch"); },
    async recordEvidence() { return true; }, async completeUpdate() { throw new Error("Unexpected ACK"); }, async finish(_claim, status, details) { finished = { status, ...details }; return true; },
  };
  const ports = { http: { async fetch() { http++; throw new Error("Unexpected HTTP"); } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  return { claim, store, ports, counters: () => ({ claims, preparations, credentials, http }), finish: () => finished };
}
test("new task runner validates bounds before it can claim or inspect credentials", async () => {
  const f = fixture(); await assert.rejects(deliverReferenceTaskUpdate(f.store, f.claim.operationId, f.ports, { deadlineMs: 0 })); assert.deepEqual(f.counters(), { claims: 0, preparations: 0, credentials: 0, http: 0 });
});
test("explicit malformed task profile HOLDs before prepare/credentials/HTTP", async () => {
  const f = fixture(); (f.claim as { endpointProfile: string }).endpointProfile = "google-personal-event-update-v1";
  assert.equal((await deliverReferenceTaskUpdate(f.store, f.claim.operationId, f.ports)).status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
test("present malformed task native plan never falls back or reaches host preparation", async () => {
  const f = fixture(); (f.claim.payload as any).operationEnvelope.nativePlan.data.body = { title: "Replaced after admission" };
  assert.equal((await deliverReferenceTaskUpdate(f.store, f.claim.operationId, f.ports)).status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 }); assert(f.finish());
});
test("existing event runner refuses explicit task family before credentials or HTTP", async () => {
  const f = fixture(); const result = await deliverReferenceOperation(f.store as unknown as ReferenceRunnerStore, f.claim.operationId, f.ports);
  assert.equal(result.status, "hold"); assert.equal(result.code, "reference-provider-profile-unavailable"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
