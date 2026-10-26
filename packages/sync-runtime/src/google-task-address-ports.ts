import type { GoogleTaskTarget } from "@musubi/provider-google";

/** The original admitted locator is still null for a causal successor. */
export type GoogleTaskClaimTarget = Omit<GoogleTaskTarget, "taskId"> & { readonly taskId: string | null };
interface GoogleTaskPredecessorWitness {
  readonly operationId: string;
  readonly attemptId: string;
  readonly predecessorOperationId: string;
  readonly evidenceOperationId: string;
  /** Opaque comparison token, not authority on its own. The trusted host walks
   * the complete scoped history and compares it again before mutation and ACK.
   * Its persisted basis excludes the current attempt/lease and credentials. */
  readonly witness: string;
}
export interface GoogleTaskPredecessorAddress extends GoogleTaskPredecessorWitness {
  readonly kind: "predecessor-task-reference";
  readonly taskId: string;
  readonly validator: string | null;
  readonly projectionBaseline: Readonly<Record<string, unknown>> | null;
}
/** Existing-host compatibility: a complete no-write CREATE history establishes
 * no destination. This is neither a native GET absence nor provider acceptance. */
export interface GoogleTaskPredecessorNoTask extends GoogleTaskPredecessorWitness {
  readonly kind: "predecessor-no-task";
}
export type GoogleTaskPredecessorResolution = GoogleTaskPredecessorAddress | GoogleTaskPredecessorNoTask;
export interface GoogleTaskPreparation {
  readonly acceptedEtag: unknown;
  readonly baseline: unknown;
  readonly saved?: unknown;
  readonly dispatchAllowed?: boolean;
  readonly predecessorAddress?: GoogleTaskPredecessorResolution;
}
