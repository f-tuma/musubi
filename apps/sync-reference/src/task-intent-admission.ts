import { createHash } from "node:crypto";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { SyncOperationEnvelopeSchema, SyncJsonObjectSchema, type SyncOperationEnvelope } from "@musubi/types";
import { encodeReferenceTask, taskFields, taskIdentity, taskStrongEtag, validateTaskAdmissionIdentity, validateTaskBaseline, validateTaskPatch } from "./task-admission.js";
import { jsonEqual } from "./admission.js";
import type { ReferenceTaskContent } from "./task-model.js";
import type { ReferenceCapture } from "./model.js";
import type { ReferenceTaskCompletion, ReferenceTaskQueuedDelete, ReferenceTaskQueuedUpdate } from "./task-intent-model.js";

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
}
/** Semantic JSON, independent of PostgreSQL jsonb property order. No secrets. */
export function taskSemanticDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function queuedTaskFingerprint(action: "update" | "delete", supplied: ReferenceTaskQueuedUpdate | ReferenceTaskQueuedDelete): string {
  const input = taskFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId", "predecessorOperationId", ...(action === "update" ? ["patch"] : [])]);
  validateTaskAdmissionIdentity(input as unknown as ReferenceTaskQueuedDelete);
  if (!taskIdentity(input.predecessorOperationId) || input.predecessorOperationId === input.operationId) throw new Error("Invalid reference task predecessor");
  const patch = action === "update" ? validateTaskPatch(input.patch) : null;
  return taskSemanticDigest(["google-task-queued-" + action + "-v1", input.bindingId, input.expectedRevision, input.operationId, input.predecessorOperationId, patch]);
}
export function acceptedQueuedTaskEnvelope(action: "update" | "delete", input: ReferenceTaskQueuedUpdate | ReferenceTaskQueuedDelete, content: ReferenceTaskContent, host: {
  objectId: string; connectionId: string; taskListId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  queuedTaskFingerprint(action, input);
  if (![host.objectId, host.connectionId, host.taskListId].every(taskIdentity) || host.taskListId === "@default") throw new Error("Invalid queued task scope");
  encodeURIComponent(host.taskListId);
  const encoded = encodeReferenceTask(content, host.objectId, input.operationId, action), plan = parseNativeWritePlanV1(encoded.serializer, action, "task", encoded.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !jsonEqual(plan.body, action === "delete" ? null : encoded.admittedProjection.data) || !matchesPinnedProjectionV1(encoded.serializer, action, encoded.admittedProjection.data, plan)) throw new Error("Queued task codec disagreement");
  validateTaskBaseline(encoded.admittedProjection.data);
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action, version: 1 }, serializer: encoded.serializer,
    commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId, predecessorOperationId: input.predecessorOperationId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.taskListId, resourceId: null }, sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration },
    acceptedRevision: host.capture.acceptedRevision, privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
}
function completionFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const fields = taskFields(value, required, optional);
  if (Reflect.ownKeys(value as object).some(key => !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) throw new Error("Invalid reference task completion");
  return fields;
}
export function taskCompletion(value: unknown): ReferenceTaskCompletion {
  // Projection limits belong to the existing provider validator. Metadata is
  // bounded independently; adding this wrapper must not spend its text budget.
  const v = completionFields(value, ["version", "operationId", "attemptId", "observationId", "taskId", "sourceGeneration", "kind"], ["validator", "projectionBaseline", "adoption", "status"]), present = v.kind === "present";
  const fields = taskFields(v, ["version", "operationId", "attemptId", "observationId", "taskId", "sourceGeneration", "kind", ...(present ? ["validator", "projectionBaseline"] : ["status"])], present ? ["adoption"] : []);
  if (fields.version !== 1 || ![fields.operationId, fields.attemptId, fields.observationId, fields.taskId].every(taskIdentity) || !Number.isSafeInteger(fields.sourceGeneration) || (fields.sourceGeneration as number) < 1 ||
    !present && (fields.kind !== "absent" || fields.status !== 404 && fields.status !== 410)) throw new Error("Invalid reference task completion");
  if (present) {
    if (!taskStrongEtag(fields.validator)) throw new Error("Invalid reference task completion");
    const projection = SyncJsonObjectSchema.safeParse(fields.projectionBaseline);
    if (!projection.success) throw new Error("Invalid reference task completion");
    fields.projectionBaseline = validateTaskBaseline(projection.data);
    if (Object.hasOwn(fields, "adoption")) {
      const adoption = completionFields(fields.adoption, ["operationId", "from", "to"]);
      if (adoption.operationId !== fields.operationId || !Number.isSafeInteger(adoption.from) || (adoption.from as number) < 1 || adoption.to !== (adoption.from as number) + 1 || adoption.to !== fields.sourceGeneration) throw new Error("Invalid reference task adoption");
      fields.adoption = adoption;
    }
  }
  return JSON.parse(JSON.stringify(fields)) as ReferenceTaskCompletion;
}
