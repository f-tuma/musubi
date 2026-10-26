import type { SyncOperationRowBinding } from "@musubi/types";
import type { GoogleTaskCreate, GoogleTaskCreateTarget, GoogleTaskCreateProviderPorts, GoogleTaskProjection,
  GoogleNativeTaskReadEvidence, GoogleNativeTaskResponseAddress } from "@musubi/provider-google";
import type { RuntimeProviderFact, RuntimeErrorInfo, RuntimeAckResult, RuntimeCheckpoint, RuntimeTraceEntry, RuntimeAttemptOptions } from "./ports";

export interface GoogleTaskCreatePolicy {
  readonly nativeProfile: "existing-google" | "strict-reference";
  readonly readback: "saved-patch" | "full-target";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
}
export interface GoogleTaskCreateSavedProjection {
  readonly projection: GoogleTaskProjection;
  readonly baseline: Readonly<Record<string, unknown>> | null;
  readonly patch: Readonly<Partial<GoogleTaskProjection>>;
}
/** The native CREATE locator remains null. Generated addresses are evidence,
 * never a rewrite of the immutable admitted identity. */
export interface ClaimedGoogleTaskCreate {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: GoogleTaskCreateTarget;
  readonly collectionIdentity: "native" | "musubi-google-task-list";
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: RuntimeProviderFact;
  readonly priorAcceptedStatus?: 200 | 201 | 204 | null;
  readonly priorResponseAddress?: GoogleNativeTaskResponseAddress | null;
}
export type RuntimeTaskCreateRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "confirmed" | "conflict"; readonly observationId: string;
      readonly read: GoogleNativeTaskReadEvidence; readonly projection: Readonly<Record<string, unknown>> | null };
export interface RuntimeTaskCreateNativeFacts {
  readonly provider: RuntimeProviderFact;
  readonly acceptedStatus?: 200 | 201 | 204;
  readonly responseAddress?: GoogleNativeTaskResponseAddress;
  /** Complete awaited provider writer result, captured before the caller guard.
   * Parsed response fields alone do not cross this API persistence boundary. */
  readonly writerResult?: { readonly taskId: string; readonly etag: string };
  readonly remote: RuntimeTaskCreateRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface RuntimeTaskCreateCompletionEvidence {
  readonly kind: "exact-readback";
  readonly taskId: string;
  readonly validator: string;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly read: Extract<GoogleNativeTaskReadEvidence, { kind: "present" }>;
  readonly saved: GoogleTaskCreateSavedProjection;
  readonly facts: RuntimeTaskCreateNativeFacts;
}
export interface RuntimeTaskCreateFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: RuntimeTaskCreateNativeFacts;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}
export interface GoogleTaskCreateHostPorts {
  prepare(signal: AbortSignal): Promise<{ readonly dispatchAllowed?: boolean; readonly saved?: GoogleTaskCreateSavedProjection }>;
  prepareProjection?(input: { readonly target: GoogleTaskProjection; readonly saved?: GoogleTaskCreateSavedProjection }, signal: AbortSignal): Promise<GoogleTaskCreateSavedProjection>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: GoogleTaskCreateProviderPorts["accountSession"];
  beforeMutation(request: GoogleTaskCreate, signal: AbortSignal): Promise<void>;
  recordEvidence(facts: RuntimeTaskCreateNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: RuntimeTaskCreateCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: RuntimeTaskCreateFinishOutcome): Promise<void>;
  observationId(): string;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type GoogleTaskCreateRuntimeProviderPorts = Pick<GoogleTaskCreateProviderPorts, "http" | "clock" | "telemetry">;
export interface RuntimeTaskCreateRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: RuntimeTaskCreateNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export type { RuntimeAttemptOptions };
