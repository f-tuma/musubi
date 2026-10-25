import { createHash } from "node:crypto";
import { isGoogleTaskDeleteAcceptedStatus } from "@musubi/provider-google";
import { SyncOperationEnvelopeSchema, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { encodeReferenceTask, taskIdentity, validateTaskAdmissionIdentity, validateTaskBaseline } from "./task-admission.js";
import type { ReferenceCapture } from "./model.js";
import type { ReferenceTaskContent } from "./task-model.js";
import type { ReferenceTaskDeleteAdmission } from "./task-delete-model.js";
export const REFERENCE_TASK_DELETE_PROFILE = "google-task-delete-v1";
export function taskDeleteAdmissionFingerprint(input: ReferenceTaskDeleteAdmission): string {
  validateTaskAdmissionIdentity(input);
  return createHash("sha256").update(JSON.stringify([REFERENCE_TASK_DELETE_PROFILE, input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedTaskDeleteEnvelope(input: ReferenceTaskDeleteAdmission, content: ReferenceTaskContent, host: {
  objectId: string; connectionId: string; taskListId: string; taskId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  taskDeleteAdmissionFingerprint(input);
  if (![host.objectId, host.connectionId, host.taskListId, host.taskId].every(taskIdentity) || host.taskListId === "@default") throw new Error("Invalid reference task DELETE target");
  const encoded = encodeReferenceTask(content, host.objectId, input.operationId, "delete");
  const plan = parseNativeWritePlanV1(encoded.serializer, "delete", "task", encoded.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || plan.body !== null || !matchesPinnedProjectionV1(encoded.serializer, "delete", encoded.admittedProjection.data, plan)) throw new Error("Reference task DELETE codec disagreement");
  validateTaskBaseline(encoded.admittedProjection.data);
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "delete", version: 1 },
    serializer: encoded.serializer, commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.taskListId, resourceId: host.taskId },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
}
export const taskDeleteAcceptedStatus = isGoogleTaskDeleteAcceptedStatus;
export const taskDeleteResponseAbsenceStatus = (value: unknown): value is 404 | 410 => value === 404 || value === 410;
