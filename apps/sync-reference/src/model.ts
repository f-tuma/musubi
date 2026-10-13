import type { SyncDeliveryReceipt, SyncOperationEnvelope, SyncOperationRowBinding, SyncError } from "@musubi/types";

/** Independent host content, deliberately not Musubi Event/Task. */
export interface ReferenceContent { name: string; notes: string | null; place: string | null; beginsAt: string; endsAt: string }
export type ReferenceContentPatch = Partial<Pick<ReferenceContent, "name" | "notes" | "place">>;
export interface ReferenceCapture { connectionGeneration: number; sourceGeneration: number; privacyGeneration: number; acceptedRevision: number }
export interface ReferenceClaim {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly envelope?: SyncOperationEnvelope;
  readonly binding: SyncOperationRowBinding;
  readonly capture: ReferenceCapture;
  readonly locator: { connectionId: string; calendarId: string; eventId: string };
  readonly etag: string;
  readonly receipt: SyncDeliveryReceipt;
  readonly recovery: boolean;
}
export type ReferenceStatus = "pending" | "running" | "hold" | "conflict" | "acked";
export interface ReferenceOperation {
  operationId: string; commandId: string; bindingId: string; objectId: string;
  payload: unknown; capture: ReferenceCapture; status: ReferenceStatus;
  dispatchPossible: boolean; receipt: SyncDeliveryReceipt;
  leaseAttemptId: string | null; leaseUntil: string | null;
  binding: { etag: string; baseline: Record<string, unknown>; active: boolean; sourceGeneration: number };
}
export interface ReferenceSeed {
  connectionId: string; objectId: string; bindingId: string; calendarId: string; eventId: string;
  accessToken: string; expiresAt: string; scope: string; content: ReferenceContent; etag: string;
  privacyLabel?: string;
}
export interface ReferenceAdmission {
  bindingId: string; expectedRevision: number; commandId: string; operationId: string; patch: ReferenceContentPatch;
}
export interface ReferenceEvidence {
  provider: "accepted" | "uncertain" | "rejected" | "not-dispatched";
  validator?: string;
  remote: "confirmed" | "conflict" | "unobserved";
  observationId?: string;
  code?: string;
  /** Validated protocol metadata, never raw provider messages or response bodies. */
  error?: SyncError;
}
export class ReferenceHoldError extends Error {
  constructor(readonly code: string) { super(`Reference host HOLD: ${code}`); this.name = "ReferenceHoldError"; }
}
