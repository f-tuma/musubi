import { createHash } from "node:crypto";
import { SyncOperationEnvelopeSchema, type SyncOperationEnvelope } from "@musubi/types";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import { encodeReferenceTask, taskIdentity, validateTaskAdmissionIdentity, validateTaskBaseline } from "./task-admission.js";
import { jsonEqual } from "./admission.js";
import type { ReferenceCapture } from "./model.js";
import type { ReferenceTaskContent } from "./task-model.js";
import type { ReferenceTaskCreateAdmission } from "./task-create-model.js";

export const REFERENCE_TASK_CREATE_PROFILE = "google-task-create-v1";
export const taskCreateAcceptedStatus = (value: unknown): value is 200 | 201 | 204 => value === 200 || value === 201 || value === 204;
export function taskCreateAdmissionFingerprint(input: ReferenceTaskCreateAdmission): string {
  validateTaskAdmissionIdentity(input);
  return createHash("sha256").update(JSON.stringify([REFERENCE_TASK_CREATE_PROFILE, input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedTaskCreateEnvelope(input: ReferenceTaskCreateAdmission, content: ReferenceTaskContent, host: {
  objectId: string; connectionId: string; taskListId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  taskCreateAdmissionFingerprint(input);
  if (![host.objectId, host.connectionId, host.taskListId].every(taskIdentity) || host.taskListId === "@default") throw new Error("Invalid reference task CREATE target");
  encodeURIComponent(host.taskListId);
  const encoded = encodeReferenceTask(content, host.objectId, input.operationId, "create");
  const plan = parseNativeWritePlanV1(encoded.serializer, "create", "task", encoded.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !plan.body || !jsonEqual(plan.body, encoded.admittedProjection.data) ||
    !matchesPinnedProjectionV1(encoded.serializer, "create", encoded.admittedProjection.data, plan)) throw new Error("Reference task CREATE codec disagreement");
  validateTaskBaseline(encoded.admittedProjection.data);
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "create", version: 1 },
    serializer: encoded.serializer, commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.taskListId, resourceId: null },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
}
