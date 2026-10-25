import type {
  GoogleTaskTarget, GoogleTaskProjection, GoogleTaskUpdateBody, GoogleTaskUpdate,
  GoogleNativeTaskReadEvidence, GoogleTaskProviderPorts,
} from "@musubi/provider-google";
import type { SyncOperationRowBinding } from "@musubi/types";
import type {
  RuntimeProviderFact, RuntimeAttemptOptions, RuntimeErrorInfo, RuntimeAckResult,
  RuntimeCheckpoint, RuntimeTraceEntry,
} from "./ports";

export interface GoogleTaskSavedProjection {
  readonly projection: GoogleTaskProjection;
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly patch: GoogleTaskUpdateBody;
}
export interface GoogleTaskUpdatePolicy {
  readonly nativeProfile: "existing-google" | "strict-reference";
  readonly readback: "saved-patch" | "full-target";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
}
export type RuntimeTaskAcceptedStatus = 200 | 201 | 204;
export type RuntimeTaskRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "confirmed" | "conflict"; readonly observationId: string;
      readonly read: GoogleNativeTaskReadEvidence; readonly projection: Readonly<Record<string, unknown>> | null };
/** Accepted HTTP status is independent of a usable response validator. Hosts
 * claiming restart durability must persist this status explicitly. */
export interface RuntimeTaskNativeFacts {
  readonly provider: RuntimeProviderFact;
  readonly acceptedStatus?: RuntimeTaskAcceptedStatus;
  readonly remote: RuntimeTaskRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedGoogleTaskUpdate {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: GoogleTaskTarget;
  readonly collectionIdentity: "native" | "musubi-google-task-list";
  readonly acceptedEtag: unknown;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: RuntimeProviderFact;
  readonly priorAcceptedStatus?: RuntimeTaskAcceptedStatus | null;
}
export interface RuntimeTaskCompletionEvidence {
  readonly kind: "exact-readback";
  readonly validator: string;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly read: Extract<GoogleNativeTaskReadEvidence, { kind: "present" }>;
  readonly saved: GoogleTaskSavedProjection;
  readonly facts: RuntimeTaskNativeFacts;
}
export interface RuntimeTaskFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: RuntimeTaskNativeFacts;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}
export interface GoogleTaskUpdateHostPorts {
  prepare(signal: AbortSignal): Promise<{ acceptedEtag: unknown; baseline: unknown; saved?: unknown; dispatchAllowed?: boolean }>;
  /** Persist once at the existing host preparation boundary. Returned mask and
   * baseline are validated against the immutable admitted target by the kernel. */
  prepareProjection(input: {
    readonly observedProjection: Readonly<Record<string, unknown>>;
    readonly target: GoogleTaskProjection;
    readonly baseline: Readonly<Record<string, unknown>>;
    readonly saved?: GoogleTaskSavedProjection;
  }, signal: AbortSignal): Promise<GoogleTaskSavedProjection>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: GoogleTaskProviderPorts["accountSession"];
  beforeMutation(request: GoogleTaskUpdate, signal: AbortSignal): Promise<void>;
  recordEvidence(facts: RuntimeTaskNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: RuntimeTaskCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: RuntimeTaskFinishOutcome): Promise<void>;
  observationId(): string;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type GoogleTaskRuntimeProviderPorts = Pick<GoogleTaskProviderPorts, "http" | "clock" | "telemetry">;
export interface RuntimeTaskRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: RuntimeTaskNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export type { RuntimeAttemptOptions };
