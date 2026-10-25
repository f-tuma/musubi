import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptedTaskDeleteEnvelope, REFERENCE_TASK_DELETE_PROFILE } from "./task-delete-admission.js";
import { initialReceipt } from "./admission.js";
import { deliverReferenceTaskDelete, type ReferenceTaskDeleteRunnerStore } from "./task-delete-runner.js";
import { deliverReferenceTaskUpdate, type ReferenceTaskRunnerStore } from "./task-runner.js";
import { deliverReferenceOperation, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceTaskDeleteClaim } from "./task-delete-model.js";
function fixture() {
  const operationId = randomUUID(), input = { operationId, commandId: "delete-command", bindingId: "delete-binding", expectedRevision: 1 }, capture = { acceptedRevision: 2, canonicalGeneration: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1 };
  const envelope = acceptedTaskDeleteEnvelope(input, { name: "Task", notes: null, state: "doing", dueAt: null, importance: "high" }, { objectId: "task", connectionId: "connection", taskListId: "list", taskId: "native-task", capture });
  const claim: ReferenceTaskDeleteClaim = { operationId, attemptId: "attempt", endpointProfile: REFERENCE_TASK_DELETE_PROFILE, payload: { operationEnvelope: envelope }, binding: { kind: "task", action: "delete", operationId, commandId: input.commandId, hostObjectId: "task", provider: "google", connectionId: "connection", collectionId: "list", resourceId: "native-task", acceptedRevision: 2, sourceEpoch: { sourceId: input.bindingId, generation: 1 }, privacyEpoch: "1" }, capture,
    locator: { connectionId: "connection", taskListId: "list", taskId: "native-task" }, acceptedEtag: '"original"', acceptedBaseline: { title: "Task", notes: null, due: null, status: "needsAction" }, deleteResponse: { acceptedStatus: null, responseAbsenceStatus: null }, receipt: initialReceipt(envelope), recovery: false };
  let claims = 0, preparations = 0, credentials = 0, http = 0;
  const store: ReferenceTaskDeleteRunnerStore = { async claimDelete() { claims++; return claim; }, async prepareDelete() { preparations++; return { acceptedEtag: claim.acceptedEtag, baseline: claim.acceptedBaseline }; }, async renew() { return true; }, async getDeleteSession() { credentials++; throw new Error("Unexpected credential read"); }, async markDeleteDispatch() { throw new Error("Unexpected dispatch"); }, async recordDeleteEvidence() { return true; }, async completeDelete() { throw new Error("Unexpected ACK"); }, async finish() { return true; } };
  const ports = { http: { async fetch() { http++; throw new Error("Unexpected HTTP"); } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  return { claim, store, ports, counters: () => ({ claims, preparations, credentials, http }) };
}
test("DELETE runner bounds fail before acquiring a claim", async () => {
  const f = fixture(); await assert.rejects(deliverReferenceTaskDelete(f.store, f.claim.operationId, f.ports, { deadlineMs: 0 })); assert.deepEqual(f.counters(), { claims: 0, preparations: 0, credentials: 0, http: 0 });
});
test("wrong explicit DELETE profile HOLDs before authority/credentials/native ports", async () => {
  const f = fixture(); (f.claim as { endpointProfile: string }).endpointProfile = "google-task-update-v1";
  assert.equal((await deliverReferenceTaskDelete(f.store, f.claim.operationId, f.ports)).status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
test("a present DELETE envelope with UPDATE body never reaches prepare or a legacy fallback", async () => {
  const f = fixture(); (f.claim.payload as any).operationEnvelope.nativePlan.data.body = { title: "Not DELETE" };
  assert.equal((await deliverReferenceTaskDelete(f.store, f.claim.operationId, f.ports)).status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
for (const older of ["task-update", "event"] as const) test(`existing ${older} runner cannot reinterpret a DELETE task claim`, async () => {
  const f = fixture(), shim = { ...f.store, claim: f.store.claimDelete };
  const result = older === "event" ? await deliverReferenceOperation(shim as unknown as ReferenceRunnerStore, f.claim.operationId, f.ports) : await deliverReferenceTaskUpdate(shim as unknown as ReferenceTaskRunnerStore, f.claim.operationId, f.ports);
  assert.equal(result.status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
