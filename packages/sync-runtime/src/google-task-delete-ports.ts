import type { SyncOperationRowBinding } from "@musubi/types";
import type { GoogleTaskDelete, GoogleTaskDeleteProviderPorts, GoogleTaskDeleteAcceptedStatus, GoogleNativeTaskDeleteReadEvidence, GoogleNativeTaskDeleteEvidence, GoogleTaskTarget } from "@musubi/provider-google";
import type { RuntimeProviderFact, RuntimeErrorInfo, RuntimeAckResult, RuntimeCheckpoint, RuntimeTraceEntry, RuntimeAttemptOptions } from "./ports";
import type { GoogleTaskSavedProjection } from "./google-task-update-ports";

export interface GoogleTaskDeletePolicy {
  readonly completion: "provider-response" | "exact-absence";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly nativeProfile: "existing-google" | "strict-reference";
  readonly knownResponseRecovery: "conditional-retry" | "observe-only";
}
export type RuntimeTaskDeleteAbsenceSource = "initial-read" | "writer-read" | "readback";
export type RuntimeTaskDeleteRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "absent"; readonly source: RuntimeTaskDeleteAbsenceSource; readonly observationId: string; readonly read: Extract<GoogleNativeTaskDeleteReadEvidence, { kind: "absent" }> }
  | { readonly kind: "conflict"; readonly observationId: string; readonly read: Extract<GoogleNativeTaskDeleteReadEvidence, { kind: "present" }> };
/** `provider:accepted` means a successful DELETE response/fulfillment. Only
 * acceptedStatus attests actual 2xx; responseAbsenceStatus attests DELETE
 * 404/410. Neither claims a mutation was applied or a GET observed absence. */
export interface RuntimeTaskDeleteNativeFacts {
  readonly provider: RuntimeProviderFact;
  readonly acceptedStatus?: GoogleTaskDeleteAcceptedStatus;
  readonly responseAbsenceStatus?: 404 | 410;
  /** Current writer returned before the next cancellation guard. This receipt
   * does not invent dispatch, acceptance or an observation ID. */
  readonly writerResult?: GoogleNativeTaskDeleteEvidence;
  readonly remote: RuntimeTaskDeleteRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedGoogleTaskDelete {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: GoogleTaskTarget;
  readonly collectionIdentity: "native" | "musubi-google-task-list";
  readonly acceptedEtag: unknown;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: RuntimeProviderFact;
  readonly priorAcceptedStatus?: GoogleTaskDeleteAcceptedStatus | null;
  readonly priorResponseAbsenceStatus?: 404 | 410 | null;
}
export type RuntimeTaskDeleteCompletionEvidence =
  | { readonly kind: "provider-response"; readonly response: { readonly kind: "accepted"; readonly status: GoogleTaskDeleteAcceptedStatus } | { readonly kind: "absent"; readonly status: 404 | 410 }; readonly facts: RuntimeTaskDeleteNativeFacts }
  | { readonly kind: "exact-absence"; readonly source: RuntimeTaskDeleteAbsenceSource; readonly read: Extract<GoogleNativeTaskDeleteReadEvidence, { kind: "absent" }>; readonly facts: RuntimeTaskDeleteNativeFacts };
export interface RuntimeTaskDeleteFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: RuntimeTaskDeleteNativeFacts;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}
export interface GoogleTaskDeleteHostPorts {
  prepare(signal: AbortSignal): Promise<{ acceptedEtag: unknown; baseline: unknown; saved?: unknown; dispatchAllowed?: boolean }>;
  /** Optional existing Musubi write-once dispatch projection port. A DELETE
   * reference admission has its own original baseline, not a fake UPDATE mask. */
  prepareProjection?(input: { readonly observedProjection: Readonly<Record<string, unknown>>;
    readonly target: GoogleTaskSavedProjection["projection"]; readonly baseline: Readonly<Record<string, unknown>>;
    readonly saved?: GoogleTaskSavedProjection }, signal: AbortSignal): Promise<GoogleTaskSavedProjection>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: GoogleTaskDeleteProviderPorts["accountSession"];
  beforeMutation(request: GoogleTaskDelete, signal: AbortSignal): Promise<void>;
  recordEvidence(facts: RuntimeTaskDeleteNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: RuntimeTaskDeleteCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: RuntimeTaskDeleteFinishOutcome): Promise<void>;
  observationId(): string;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type GoogleTaskDeleteRuntimeProviderPorts = Pick<GoogleTaskDeleteProviderPorts, "http" | "clock" | "telemetry">;
export interface RuntimeTaskDeleteRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: RuntimeTaskDeleteNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export type { RuntimeAttemptOptions };
