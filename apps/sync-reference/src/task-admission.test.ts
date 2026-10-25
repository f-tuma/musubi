import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptedTaskEnvelope, encodeReferenceTask, taskAdmissionFingerprint, taskFields, taskSavedProjection, taskWriteAllowed, validateTaskContent, validateTaskPatch, validateTaskBaseline } from "./task-admission.js";
import type { ReferenceTaskContent, ReferenceTaskAdmission } from "./task-model.js";

const content: ReferenceTaskContent = { name: "Independent task", notes: "Exact notes", state: "doing", dueAt: "2026-10-26T14:45:30.123Z", importance: "high" };
const input: ReferenceTaskAdmission = { bindingId: "task-binding:opaque", commandId: "command:opaque", operationId: randomUUID(), expectedRevision: 1, patch: { name: "New title" } };
const host = { objectId: "task:opaque", connectionId: "connection:opaque", taskListId: "list/?:", taskId: "task/?:", capture: { acceptedRevision: 2, sourceGeneration: 4, connectionGeneration: 8, privacyGeneration: 6, canonicalGeneration: 1 } };
const baseline = { title: content.name, notes: content.notes, status: "needsAction" as const, due: "2026-10-26T00:00:00.000Z" };

test("actual Task codec produces four fields while independent rich truth stays intact", () => {
  const before = structuredClone(content), encoded = encodeReferenceTask(content, host.objectId, input.operationId);
  assert.equal(encoded.serializer.id, "google-task"); assert.deepEqual(encoded.admittedProjection.data, baseline);
  assert.deepEqual(encoded.nativePlan.data, { planKind: "json-body", body: baseline }); assert.deepEqual(content, before);
});
test("admission is Task/update with exact opaque native list/task identity, no fake event times", () => {
  const envelope = acceptedTaskEnvelope(input, { ...content, name: "New title" }, host);
  assert.deepEqual(envelope.operation, { kind: "task", action: "update", version: 1 }); assert.deepEqual(envelope.locator, { provider: "google", connectionId: host.connectionId, collectionId: host.taskListId, resourceId: host.taskId });
  assert.deepEqual(envelope.admittedProjection.data, { ...baseline, title: "New title" });
  assert.equal(JSON.stringify(envelope).includes("beginsAt"), false); assert.equal(envelope.acceptedRevision, 2); assert.equal(envelope.sourceEpoch.generation, 4); assert.equal(envelope.privacyEpoch, "6");
});
test("saved original baseline selects only changed fields using actual shared diff", () => {
  const target = { ...baseline, title: "New title" }, saved = taskSavedProjection(target, baseline);
  assert.deepEqual(saved, { projection: target, baseline, patch: { title: "New title" } });
  assert.deepEqual(Object.keys(taskSavedProjection({ ...target, notes: null, due: null, status: "completed" }, baseline).patch), ["due", "notes", "status", "title"]);
});
test("lossy unchanged Google fields and rich-only canonical changes produce an empty native mask", () => {
  for (const patch of [{ importance: "low" as const }, { dueAt: "2026-10-26T22:59:59.999Z" }, { state: "todo" as const }]) {
    const target = encodeReferenceTask({ ...content, ...patch }, host.objectId, input.operationId).admittedProjection.data;
    assert.deepEqual(taskSavedProjection(target, baseline).patch, {});
  }
});
test("null/empty notes and due clear values survive the actual serializer", () => {
  for (const notes of [null, ""]) {
    const encoded = encodeReferenceTask({ ...content, notes, dueAt: null, state: "done" }, host.objectId, input.operationId);
    assert.deepEqual(encoded.admittedProjection.data, { title: content.name, notes, due: null, status: "completed" });
  }
});
test("task idempotency is field-order independent but family/revision/binding/input specific", () => {
  const value = { ...input, patch: { name: "New title", notes: null } };
  assert.equal(taskAdmissionFingerprint(value), taskAdmissionFingerprint({ ...value, patch: { notes: null, name: "New title" } }));
  assert.notEqual(taskAdmissionFingerprint(value), taskAdmissionFingerprint({ ...value, expectedRevision: 2 }));
  assert.notEqual(taskAdmissionFingerprint(value), taskAdmissionFingerprint({ ...value, bindingId: "other" }));
  assert.notEqual(taskAdmissionFingerprint(value), taskAdmissionFingerprint({ ...value, patch: { name: "Different" } }));
});
test("new reference helper requires real codec UUID; portable runtime identity is not changed", () => {
  for (const operationId of ["opaque:update", input.operationId.toUpperCase(), "00000000-0000-0000-0000-00000000000g"])
    assert.throws(() => taskAdmissionFingerprint({ ...input, operationId }), /UUID/);
});
test("Calendar or readonly Tasks grant never authorizes Task writes", () => {
  for (const scope of ["", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/tasks.readonly", "xhttps://www.googleapis.com/auth/tasks", "https://www.googleapis.com/auth/tasks.extra"])
    assert.equal(taskWriteAllowed(scope), false);
  assert.equal(taskWriteAllowed("https://www.googleapis.com/auth/calendar.events\nhttps://www.googleapis.com/auth/tasks"), true);
});
test("baseline must be exactly all four strict native fields", () => {
  for (const value of [{ title: "A" }, { ...baseline, status: "doing" }, { ...baseline, notes: 1 }, { ...baseline, due: content.dueAt }, { ...baseline, extra: true }])
    assert.throws(() => validateTaskBaseline(value));
});
test("new task content never accepts event or arbitrary transport fields", () => {
  for (const value of [{ ...content, beginsAt: content.dueAt }, { ...content, state: "cancelled" }, { ...content, dueAt: "2026-10-26T14:45:30Z" }, { ...content, notes: undefined }, { ...content, importance: 1 }])
    assert.throws(() => validateTaskContent(value));
  for (const value of [{}, { name: undefined }, { recurrence: "FREQ=DAILY" }, { taskId: "different" }, { headers: {} }]) assert.throws(() => validateTaskPatch(value));
});
test("getters, inherited data and symbol properties are refused without evaluation", () => {
  let touched = false; const value = Object.defineProperty({}, "name", { enumerable: true, get() { touched = true; return "secret"; } });
  assert.throws(() => validateTaskPatch(value)); assert.equal(touched, false);
  assert.throws(() => validateTaskContent({ ...content, [Symbol("secret")]: true }));
  assert.throws(() => taskFields(Object.create({ name: "inherited" }), ["name"]));
});
test("strict physical target cannot silently adopt default-list alias or a missing native address", () => {
  for (const change of [{ taskId: "" }, { taskListId: "@default" }, { connectionId: "" }]) assert.throws(() => acceptedTaskEnvelope(input, content, { ...host, ...change }));
});
