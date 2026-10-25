import type { GoogleTaskProjection } from "@musubi/provider-google";
import type { GoogleTaskSavedProjection, RuntimeTaskAcceptedStatus } from "@musubi/sync-runtime";
import type { SyncDeliveryReceipt, SyncOperationRowBinding } from "@musubi/types";
import type { ReferenceCapture, ReferenceStatus } from "./model.js";

/** Independent richer task truth. Google does not carry doing/time/importance. */
export interface ReferenceTaskContent {
  name: string; notes: string | null; state: "todo" | "doing" | "done";
  dueAt: string | null; importance: "low" | "normal" | "high";
}
export type ReferenceTaskPatch = Partial<ReferenceTaskContent>;
export interface ReferenceTaskSeed {
  provider: "google"; endpointProfile: "google-task-update-v1";
  connectionId: string; objectId: string; bindingId: string; taskListId: string; taskId: string;
  accessToken: string; expiresAt: string; scope: string; content: ReferenceTaskContent;
  etag: string; baseline: GoogleTaskProjection; privacyLabel?: string;
}
export interface ReferenceTaskAdmission {
  bindingId: string; expectedRevision: number; commandId: string; operationId: string; patch: ReferenceTaskPatch;
}
export interface ReferenceTaskClaim {
  readonly operationId: string; readonly attemptId: string; readonly endpointProfile: string;
  readonly payload: unknown; readonly binding: SyncOperationRowBinding; readonly capture: ReferenceCapture;
  readonly locator: { connectionId: string; taskListId: string; taskId: string };
  readonly acceptedEtag: string; readonly saved: GoogleTaskSavedProjection;
  readonly receipt: SyncDeliveryReceipt; readonly recovery: boolean; readonly acceptedStatus: RuntimeTaskAcceptedStatus | null;
}
export interface ReferenceTaskOperation {
  operationId: string; commandId: string; bindingId: string; objectId: string;
  provider: "google"; endpointProfile: "google-task-update-v1"; action: "update";
  status: ReferenceStatus; payload: unknown; capture: ReferenceCapture; saved: GoogleTaskSavedProjection;
  dispatchPossible: boolean; acceptedStatus: RuntimeTaskAcceptedStatus | null; receipt: SyncDeliveryReceipt;
  canonical: { content: ReferenceTaskContent; lifecycle: "active" | "tombstoned"; revision: number; generation: number };
  binding: { taskListId: string; taskId: string; active: boolean; sourceGeneration: number; etag: string; baseline: GoogleTaskProjection };
  leaseAttemptId: string | null; leaseUntil: string | null;
}
