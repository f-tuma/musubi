import type { GoogleTaskProjection } from "@musubi/provider-google";
import type { ReferenceCapture, ReferenceStatus } from "./model.js";
import type { SyncDeliveryReceipt, SyncOperationRowBinding } from "@musubi/types";
import type { ReferenceTaskAdmission, ReferenceTaskContent, ReferenceTaskSeed } from "./task-model.js";
import type { ReferenceTaskCompletion } from "./task-intent-model.js";

/** A new destination reservation has neither a provider ID nor native version. */
export interface ReferenceTaskCreateSeed extends Omit<ReferenceTaskSeed, "endpointProfile" | "taskId" | "etag" | "baseline"> {
  endpointProfile: "google-task-create-v1";
  operationId: string;
}
export type ReferenceTaskCreateAdmission = Omit<ReferenceTaskAdmission, "patch">;
export interface ReferenceTaskCreateResponse {
  acceptedStatus: 200 | 201 | 204 | null;
  responseAddress: { taskId: string; validator: string | null } | null;
}
export interface ReferenceTaskCreateClaim {
  readonly operationId: string; readonly attemptId: string; readonly endpointProfile: string;
  readonly payload: unknown; readonly binding: SyncOperationRowBinding; readonly capture: ReferenceCapture;
  readonly locator: { connectionId: string; taskListId: string; taskId: null };
  readonly receipt: SyncDeliveryReceipt; readonly recovery: boolean;
  readonly createResponse: ReferenceTaskCreateResponse;
}
export interface ReferenceTaskCreateOperation {
  operationId: string; commandId: string; bindingId: string; objectId: string;
  provider: "google"; endpointProfile: "google-task-create-v1"; action: "create";
  status: ReferenceStatus; payload: unknown; capture: ReferenceCapture; dispatchPossible: boolean;
  createResponse: ReferenceTaskCreateResponse; receipt: SyncDeliveryReceipt;
  completion?: ReferenceTaskCompletion;
  canonical: { content: ReferenceTaskContent; lifecycle: "active" | "tombstoned"; revision: number; generation: number };
  binding: { taskListId: string; taskId: string | null; active: boolean; sourceGeneration: number;
    etag: string | null; baseline: GoogleTaskProjection | null; destinationLifecycle: "reserved" | "present" | "absent";
    createOperationId: string; createProfile: "google-task-create-v1" };
  leaseAttemptId: string | null; leaseUntil: string | null;
}
export interface ReferenceTaskCreateObservation {
  kind: "exact-readback"; taskId: string; validator: string; projection: Readonly<Record<string, unknown>>;
  read: Extract<import("@musubi/provider-google").GoogleNativeTaskReadEvidence, { kind: "present" }>;
}
