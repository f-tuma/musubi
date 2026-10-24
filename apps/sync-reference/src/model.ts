import type { SyncDeliveryReceipt, SyncOperationEnvelope, SyncOperationRowBinding, SyncError } from "@musubi/types";

/** Independent host content, deliberately not Musubi Event/Task. */
export interface ReferenceContent { name: string; notes: string | null; place: string | null; beginsAt: string; endsAt: string }
export type ReferenceContentPatch = Partial<Pick<ReferenceContent, "name" | "notes" | "place">>;
export interface ReferenceCapture { connectionGeneration: number; sourceGeneration: number; privacyGeneration: number; acceptedRevision: number; canonicalGeneration?: number }
export interface ReferenceClaim {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly envelope?: SyncOperationEnvelope;
  readonly binding: SyncOperationRowBinding;
  readonly capture: ReferenceCapture;
  readonly locator: { connectionId: string; calendarId: string; eventId: string };
  readonly etag: string | null;
  readonly receipt: SyncDeliveryReceipt;
  readonly recovery: boolean;
  readonly deleteAcceptanceStatus?: ReferenceDeleteAcceptanceStatus | null;
}
export type ReferenceStatus = "pending" | "running" | "hold" | "conflict" | "acked";
export interface ReferenceOperation {
  operationId: string; commandId: string; bindingId: string; objectId: string;
  action: "create" | "update" | "delete"; payload: unknown; capture: ReferenceCapture; status: ReferenceStatus;
  canonical: { lifecycle: "active" | "tombstoned"; generation: number; revision: number };
  deleteAcceptanceStatus: ReferenceDeleteAcceptanceStatus | null;
  dispatchPossible: boolean; receipt: SyncDeliveryReceipt;
  leaseAttemptId: string | null; leaseUntil: string | null;
  binding: { etag: string | null; baseline: Record<string, unknown> | null; active: boolean; sourceGeneration: number; destinationLifecycle: "reserved" | "present" | "absent" };
}
export interface ReferenceSeed {
  connectionId: string; objectId: string; bindingId: string; calendarId: string; eventId: string;
  accessToken: string; expiresAt: string; scope: string; content: ReferenceContent; etag: string;
  privacyLabel?: string;
}
export interface ReferenceAdmission {
  bindingId: string; expectedRevision: number; commandId: string; operationId: string; patch: ReferenceContentPatch;
}
export interface ReferenceDeleteAdmission {
  bindingId: string; expectedRevision: number; commandId: string; operationId: string;
}
export type ReferenceCreateAdmission = ReferenceDeleteAdmission;
/** Bootstrap a new destination reservation; never pretend it has a native validator. */
export interface ReferenceCreateSeed extends Omit<ReferenceSeed, "eventId" | "etag"> { operationId: string }
export interface ReferenceCreateObservation { eventId: string; etag: string; projection: Record<string, unknown> }
export type ReferenceDeleteAcceptanceStatus = 200 | 201 | 204 | 404 | 410;
export type ReferenceAbsence = { kind: "absent"; status: 404 | 410 } | { kind: "cancelled" };
export interface ReferenceDeleteObservation { kind: "exact-absence"; read: ReferenceAbsence }
export interface ReferenceEvidence {
  provider: "accepted" | "uncertain" | "rejected" | "not-dispatched";
  validator?: string;
  acceptanceStatus?: ReferenceDeleteAcceptanceStatus;
  remote: "confirmed" | "conflict" | "unobserved";
  observationId?: string;
  code?: string;
  /** Validated protocol metadata, never raw provider messages or response bodies. */
  error?: SyncError;
}
export class ReferenceHoldError extends Error {
  constructor(readonly code: string) { super(`Reference host HOLD: ${code}`); this.name = "ReferenceHoldError"; }
}
