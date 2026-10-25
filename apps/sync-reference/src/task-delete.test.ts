import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptedTaskDeleteEnvelope, taskDeleteAdmissionFingerprint, taskDeleteAcceptedStatus, taskDeleteResponseAbsenceStatus } from "./task-delete-admission.js";
import { taskAdmissionFingerprint } from "./task-admission.js";
const content = { name: "Independent task", notes: null, state: "doing" as const, dueAt: "2026-10-26T14:45:30.123Z", importance: "high" as const };
const input = { bindingId: "owned-task-binding", expectedRevision: 1, commandId: "task-delete-command", operationId: randomUUID() };
const host = { objectId: "own-task", connectionId: "own-connection", taskListId: "native-list/?:", taskId: "native-task/?:", capture: { acceptedRevision: 2, canonicalGeneration: 2, connectionGeneration: 1, privacyGeneration: 1, sourceGeneration: 1 } };
test("actual Task DELETE codec captures immutable addressed identity with null body and no fake UPDATE mask", () => {
  const envelope = acceptedTaskDeleteEnvelope(input, content, host);
  assert.deepEqual(envelope.operation, { kind: "task", action: "delete", version: 1 }); assert.equal(envelope.serializer.id, "google-task");
  assert.deepEqual(envelope.nativePlan.data, { planKind: "json-body", body: null }); assert.equal(envelope.locator.resourceId, host.taskId); assert.equal(envelope.locator.collectionId, host.taskListId);
  assert.deepEqual(envelope.admittedProjection.data, { title: content.name, notes: null, status: "needsAction", due: "2026-10-26T00:00:00.000Z" }); assert.equal(JSON.stringify(envelope).includes("beginsAt"), false);
});
test("DELETE fingerprint cannot alias UPDATE and includes original binding/revision/operation", () => {
  assert.notEqual(taskDeleteAdmissionFingerprint(input), taskAdmissionFingerprint({ ...input, patch: { name: "A" } }));
  for (const change of [{ bindingId: "other" }, { expectedRevision: 2 }, { operationId: randomUUID() }]) assert.notEqual(taskDeleteAdmissionFingerprint(input), taskDeleteAdmissionFingerprint({ ...input, ...change }));
});
test("reference codec helper UUID restriction does not fabricate or derive a provider ID", () => {
  for (const operationId of ["opaque-new-helper", input.operationId.toUpperCase(), ""]) assert.throws(() => taskDeleteAdmissionFingerprint({ ...input, operationId }));
  for (const target of [{ taskId: "" }, { taskListId: "@default" }, { connectionId: "" }]) assert.throws(() => acceptedTaskDeleteEnvelope(input, content, { ...host, ...target }));
});
test("raw any-2xx HTTP acceptance and absence-only DELETE404/410 are disjoint facts", () => {
  for (const value of [200, 201, 202, 204, 206, 226, 299]) { assert(taskDeleteAcceptedStatus(value)); assert.equal(taskDeleteResponseAbsenceStatus(value), false); }
  for (const value of [404, 410]) { assert.equal(taskDeleteAcceptedStatus(value), false); assert(taskDeleteResponseAbsenceStatus(value)); }
  for (const value of [199, 300, 403, 429, 500, null, "204", NaN]) { assert.equal(taskDeleteAcceptedStatus(value), false); assert.equal(taskDeleteResponseAbsenceStatus(value), false); }
});
