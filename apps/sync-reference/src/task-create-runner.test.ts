import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptedTaskCreateEnvelope, REFERENCE_TASK_CREATE_PROFILE } from "./task-create-admission.js";
import { initialReceipt } from "./admission.js";
import { deliverReferenceTaskCreate, type ReferenceTaskCreateRunnerStore } from "./task-create-runner.js";
import { deliverReferenceTaskUpdate, type ReferenceTaskRunnerStore } from "./task-runner.js";
import { deliverReferenceTaskDelete, type ReferenceTaskDeleteRunnerStore } from "./task-delete-runner.js";
import { deliverReferenceOperation, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceTaskCreateClaim } from "./task-create-model.js";
function fixture() {
  const operationId = randomUUID(), input = { operationId, commandId: "create-command", bindingId: "create-binding", expectedRevision: 1 }, capture = { acceptedRevision: 2, canonicalGeneration: 1, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1 };
  const envelope = acceptedTaskCreateEnvelope(input, { name: "Task", notes: null, state: "doing", dueAt: null, importance: "high" }, { objectId: "task", connectionId: "connection", taskListId: "list", capture });
  const claim: ReferenceTaskCreateClaim = { operationId, attemptId: "attempt", endpointProfile: REFERENCE_TASK_CREATE_PROFILE, payload: { operationEnvelope: envelope }, binding: { kind: "task", action: "create", operationId, commandId: input.commandId, hostObjectId: "task", provider: "google", connectionId: "connection", collectionId: "list", resourceId: null, acceptedRevision: 2, sourceEpoch: { sourceId: input.bindingId, generation: 1 }, privacyEpoch: "1" }, capture,
    locator: { connectionId: "connection", taskListId: "list", taskId: null }, createResponse: { acceptedStatus: null, responseAddress: null }, receipt: initialReceipt(envelope), recovery: false };
  let claims = 0, preparations = 0, credentials = 0, http = 0;
  const store: ReferenceTaskCreateRunnerStore = { async claimCreate() { claims++; return claim; }, async prepareCreate() { preparations++; return { dispatchAllowed: true }; }, async renew() { return true; }, async getCreateSession() { credentials++; throw new Error("Unexpected credential read"); }, async markCreateDispatch() { throw new Error("Unexpected dispatch"); }, async recordCreateEvidence() { return true; }, async completeCreate() { throw new Error("Unexpected ACK"); }, async finish() { return true; } };
  const ports = { http: { async fetch() { http++; throw new Error("Unexpected HTTP"); } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
  return { claim, store, ports, counters: () => ({ claims, preparations, credentials, http }) };
}
test("CREATE runner bounds fail before acquiring a claim", async () => {
  const f = fixture(); await assert.rejects(deliverReferenceTaskCreate(f.store, f.claim.operationId, f.ports, { deadlineMs: 0 })); assert.deepEqual(f.counters(), { claims: 0, preparations: 0, credentials: 0, http: 0 });
});
test("wrong explicit CREATE profile HOLDs before authority/credentials/native ports", async () => {
  const f = fixture(); (f.claim as { endpointProfile: string }).endpointProfile = "google-task-update-v1";
  assert.equal((await deliverReferenceTaskCreate(f.store, f.claim.operationId, f.ports)).status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
test("a CREATE envelope with forged native ID cannot reach prepare or legacy fallback", async () => {
  const f = fixture(); (f.claim.payload as any).operationEnvelope.locator.resourceId = "forged-native";
  assert.equal((await deliverReferenceTaskCreate(f.store, f.claim.operationId, f.ports)).status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
for (const older of ["task-update", "task-delete", "event"] as const) test(`existing ${older} runner cannot reinterpret a CREATE task claim`, async () => {
  const f = fixture(), shim = { ...f.store, claim: f.store.claimCreate, claimDelete: f.store.claimCreate };
  const result = older === "event" ? await deliverReferenceOperation(shim as unknown as ReferenceRunnerStore, f.claim.operationId, f.ports) : older === "task-delete" ? await deliverReferenceTaskDelete(shim as unknown as ReferenceTaskDeleteRunnerStore, f.claim.operationId, f.ports) : await deliverReferenceTaskUpdate(shim as unknown as ReferenceTaskRunnerStore, f.claim.operationId, f.ports);
  assert.equal(result.status, "hold"); assert.deepEqual(f.counters(), { claims: 1, preparations: 0, credentials: 0, http: 0 });
});
