import type { SyncOperationEnvelope } from "@musubi/types";
import type { GoogleTaskProjection } from "@musubi/provider-google";
import type { ReferenceCapture, ReferenceStatus } from "./model.js";
import type { ReferenceTaskAdmission, ReferenceTaskContent, ReferenceTaskOperation } from "./task-model.js";
import type { ReferenceTaskDeleteOperation } from "./task-delete-model.js";

export interface ReferenceTaskQueuedUpdate extends ReferenceTaskAdmission { predecessorOperationId: string }
export type ReferenceTaskQueuedDelete = Omit<ReferenceTaskQueuedUpdate, "patch">;
/** Requested future truth is separate from the materialized canonical row. */
export interface ReferenceTaskIntent {
  operationId: string; commandId: string; bindingId: string; objectId: string;
  action: "update" | "delete"; predecessorOperationId: string; rootCreateOperationId: string;
  expectedRevision: number; acceptedRevision: number; capturedObjectRevision: number;
  content: ReferenceTaskContent; lifecycle: "active" | "tombstoned"; canonicalGeneration: number;
  reservationCapture: ReferenceCapture; payload: { operationEnvelope: SyncOperationEnvelope };
  status: "waiting" | ReferenceStatus;
  execution?: ReferenceTaskOperation | ReferenceTaskDeleteOperation;
  materialized: { content: ReferenceTaskContent; revision: number; lifecycle: "active" | "tombstoned"; generation: number };
}
export type ReferenceTaskCompletion = {
  version: 1; operationId: string; attemptId: string; observationId: string; taskId: string; sourceGeneration: number;
} & ({ kind: "present"; validator: string; projectionBaseline: GoogleTaskProjection;
  adoption?: { operationId: string; from: number; to: number } } |
  { kind: "absent"; status: 404 | 410 });
export interface ReferenceTaskResolutionBasis {
  version: 1; rootCreateOperationId: string; predecessorOperationId: string; evidenceOperationId: string;
  originalSourceGeneration: number; effectiveSourceGeneration: number;
  taskId: string; validator: string; projectionBaseline: GoogleTaskProjection;
  lineage: readonly { operationId: string; digest: string }[]; intentDigest: string; witness: string;
}
