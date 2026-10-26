import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptedTaskCreateEnvelope, taskCreateAdmissionFingerprint, taskCreateAcceptedStatus } from "./task-create-admission.js";
import { taskDeleteAdmissionFingerprint } from "./task-delete-admission.js";
import { taskAdmissionFingerprint } from "./task-admission.js";

const content = { name: "Independent task", notes: null, state: "doing" as const, dueAt: "2026-10-26T14:45:30.123Z", importance: "high" as const };
const input = { bindingId: "owned-task-binding", expectedRevision: 1, commandId: "task-create-command", operationId: randomUUID() };
const host = { objectId: "own-task", connectionId: "own-connection", taskListId: "native-list/?:", capture: { acceptedRevision: 2, canonicalGeneration: 1, connectionGeneration: 1, privacyGeneration: 1, sourceGeneration: 1 } };
test("actual Task CREATE codec freezes full original body with null native address and no invented baseline", () => {
  const envelope = acceptedTaskCreateEnvelope(input, content, host);
  assert.deepEqual(envelope.operation, { kind: "task", action: "create", version: 1 }); assert.equal(envelope.serializer.id, "google-task");
  assert.deepEqual(envelope.nativePlan.data, { planKind: "json-body", body: envelope.admittedProjection.data }); assert.equal(envelope.locator.resourceId, null); assert.equal(envelope.locator.collectionId, host.taskListId);
  assert.deepEqual(envelope.admittedProjection.data, { title: content.name, notes: null, status: "needsAction", due: "2026-10-26T00:00:00.000Z" });
  assert.equal(Object.hasOwn(envelope.nativePlan.data, "baseline"), false); assert.equal(JSON.stringify(envelope).includes("beginsAt"), false); assert.equal(content.state, "doing"); assert.equal(content.importance, "high");
});
test("CREATE fingerprint distinguishes all task actions and original reservation/revision/operation", () => {
  assert.notEqual(taskCreateAdmissionFingerprint(input), taskDeleteAdmissionFingerprint(input));
  assert.notEqual(taskCreateAdmissionFingerprint(input), taskAdmissionFingerprint({ ...input, patch: { name: "A" } }));
  for (const change of [{ bindingId: "other" }, { expectedRevision: 2 }, { operationId: randomUUID() }]) assert.notEqual(taskCreateAdmissionFingerprint(input), taskCreateAdmissionFingerprint({ ...input, ...change }));
});
test("CREATE helper requires original UUID and physical task-list address", () => {
  for (const operationId of ["opaque-new-helper", input.operationId.toUpperCase(), ""]) assert.throws(() => taskCreateAdmissionFingerprint({ ...input, operationId }));
  for (const target of [{ taskListId: "" }, { taskListId: "@default" }, { taskListId: "\ud800" }, { connectionId: "" }]) assert.throws(() => acceptedTaskCreateEnvelope(input, content, { ...host, ...target }));
});
test("CREATE preserves the existing Google accepted-status contract independently of assigned identity", () => {
  for (const value of [200, 201, 204]) assert(taskCreateAcceptedStatus(value));
  for (const value of [199, 202, 206, 226, 299, 300, 404, 410, 429, 500, null, "204", NaN]) assert.equal(taskCreateAcceptedStatus(value), false);
});
