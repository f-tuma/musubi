import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { isStrictGoogleNativeTask } from "@musubi/provider-google";
import { acceptedTaskCreateEnvelope } from "./task-create-admission.js";
import { acceptedQueuedTaskEnvelope, queuedTaskFingerprint, taskCompletion, taskSemanticDigest } from "./task-intent-admission.js";
const input = { bindingId: "binding", expectedRevision: 2, commandId: "queued-command", operationId: randomUUID(), predecessorOperationId: randomUUID(), patch: { name: "Queued title" } };
const content = { name: "Queued title", notes: null, state: "doing" as const, dueAt: "2026-10-26T14:45:30.123Z", importance: "high" as const };
const host = { objectId: "object", connectionId: "connection", taskListId: "native/list", capture: { acceptedRevision: 3, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 1 } };
test("queued UPDATE uses the actual full Task codec with immutable null address and original predecessor epoch", () => {
  const envelope = acceptedQueuedTaskEnvelope("update", input, content, host);
  assert.equal(envelope.locator.resourceId, null); assert.equal(envelope.predecessorOperationId, input.predecessorOperationId); assert.equal(envelope.sourceEpoch.generation, 1); assert.equal(envelope.acceptedRevision, 3);
  assert.deepEqual(envelope.nativePlan.data, { planKind: "json-body", body: { title: content.name, notes: null, due: "2026-10-26T00:00:00.000Z", status: "needsAction" } });
  assert.equal(content.state, "doing"); assert.equal(content.importance, "high");
});
test("queued DELETE has a real null-body plan and semantic identity cannot alias UPDATE", () => {
  const { patch: _, ...deletion } = input, envelope = acceptedQueuedTaskEnvelope("delete", deletion, content, { ...host, capture: { ...host.capture, acceptedRevision: 4, canonicalGeneration: 2 } });
  assert.deepEqual(envelope.nativePlan.data, { planKind: "json-body", body: null }); assert.notEqual(queuedTaskFingerprint("delete", deletion), queuedTaskFingerprint("update", input));
  assert.equal(taskSemanticDigest({ b: 1, a: { y: 2, x: 3 } }), taskSemanticDigest({ a: { x: 3, y: 2 }, b: 1 }));
});
test("completion validates a real pair and exactly one owned adoption step", () => {
  const completed = { version: 1, kind: "present", operationId: input.predecessorOperationId, attemptId: "attempt", observationId: "observation", taskId: "actual/task", sourceGeneration: 2, validator: '"readback"', projectionBaseline: { title: "Native", notes: null, status: "needsAction", due: null }, adoption: { operationId: input.predecessorOperationId, from: 1, to: 2 } };
  assert.deepEqual(taskCompletion(completed), completed); assert.throws(() => taskCompletion({ ...completed, adoption: { ...completed.adoption, to: 3 } })); assert.throws(() => taskCompletion({ ...completed, validator: null }));
});

test("completion keeps admitted projection limits separate from bounded metadata and refuses non-data wrappers", () => {
  const largeContent = { ...content, name: "t".repeat(1_999_850) }, create = acceptedTaskCreateEnvelope(input, largeContent, host), projection = create.admittedProjection.data;
  const completed = { version: 1, kind: "present", operationId: input.operationId, attemptId: "actual-attempt", observationId: "actual-observation", taskId: "actual/task", sourceGeneration: 2, validator: '\"actual-readback\"', projectionBaseline: projection, adoption: { operationId: input.operationId, from: 1, to: 2 } };
  assert.equal(isStrictGoogleNativeTask({ ...projection, id: completed.taskId, etag: completed.validator }, completed.taskId, completed.validator), true);
  assert.deepEqual(taskCompletion(completed), completed);
  assert.throws(() => taskCompletion({ ...completed, operationId: "i".repeat(2049) }));
  assert.throws(() => taskCompletion({ ...completed, projectionBaseline: { ...projection, title: "t".repeat(2_000_001) } }));
  assert.throws(() => taskCompletion({ ...completed, projectionBaseline: { ...projection, title: "t".repeat(1_100_000), notes: "n".repeat(1_100_000) } }));
  assert.throws(() => taskCompletion({ ...completed, extra: true }));
  assert.throws(() => taskCompletion({ ...completed, adoption: undefined }));
  assert.throws(() => taskCompletion(Object.defineProperty({ ...completed }, "taskId", { value: completed.taskId, enumerable: false })));
  assert.throws(() => taskCompletion({ ...completed, adoption: Object.defineProperties({}, { operationId: { value: completed.operationId }, from: { value: 1 }, to: { value: 2 } }) }));
  assert.throws(() => taskCompletion(Object.assign(Object.create({ inherited: true }), completed)));
  let getters = 0; const accessor = () => { getters++; return "present"; };
  assert.throws(() => taskCompletion(Object.defineProperty({ ...completed }, "kind", { get: accessor, enumerable: true })));
  assert.throws(() => taskCompletion({ ...completed, projectionBaseline: Object.defineProperty({ ...projection }, "title", { get: accessor, enumerable: true }) }));
  assert.throws(() => taskCompletion({ ...completed, adoption: Object.defineProperty({ ...completed.adoption }, "from", { get: accessor, enumerable: true }) }));
  assert.equal(getters, 0);
});
