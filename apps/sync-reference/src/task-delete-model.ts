import type { GoogleTaskProjection, GoogleTaskDeleteAcceptedStatus } from "@musubi/provider-google";
import type { ReferenceTaskAdmission, ReferenceTaskClaim, ReferenceTaskOperation } from "./task-model.js";
/** Two native facts: a 2xx response and an absence-only DELETE404/410 response.
 * Neither GET absence nor an unknown response manufactures either fact. */
export interface ReferenceTaskDeleteResponseFacts {
  acceptedStatus: GoogleTaskDeleteAcceptedStatus | null;
  responseAbsenceStatus: 404 | 410 | null;
}
export type ReferenceTaskDeleteAdmission = Omit<ReferenceTaskAdmission, "patch">;
export interface ReferenceTaskDeleteClaim extends Omit<ReferenceTaskClaim, "saved" | "acceptedStatus"> {
  readonly acceptedBaseline: GoogleTaskProjection;
  readonly deleteResponse: ReferenceTaskDeleteResponseFacts;
}
export interface ReferenceTaskDeleteOperation extends Omit<ReferenceTaskOperation, "endpointProfile" | "action" | "saved" | "acceptedStatus" | "binding"> {
  endpointProfile: "google-task-delete-v1"; action: "delete";
  acceptedBaseline: GoogleTaskProjection; deleteResponse: ReferenceTaskDeleteResponseFacts;
  binding: ReferenceTaskOperation["binding"] & { destinationLifecycle: "present" | "absent" };
}
export interface ReferenceTaskDeleteObservation {
  kind: "exact-absence";
  source: "initial-read" | "writer-read" | "readback";
  read: { kind: "absent"; status: 404 | 410 };
}
