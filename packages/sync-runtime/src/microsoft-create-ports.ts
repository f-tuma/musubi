import type {
  MicrosoftCreateProviderPorts, MicrosoftCreateTarget, MicrosoftNativeCreateEvidence,
  MicrosoftNativeCreateReadEvidence, MicrosoftPersonalCreate,
} from "@musubi/provider-microsoft";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";
import type { RuntimeAckResult, RuntimeCheckpoint, RuntimeErrorInfo, RuntimeTraceEntry } from "./ports";

/** The provider assigns the ID. It is a native fact, never an admitted locator rewrite. */
export type MicrosoftRuntimeCreateProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly eventId: string; readonly validator: string | null;
      readonly status: MicrosoftNativeCreateEvidence["status"] }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export interface MicrosoftTimedProjection {
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly start: string;
  readonly end: string;
  readonly isAllDay: false;
  readonly recurrence: null;
}
export type MicrosoftRuntimeCreatePresentRead = Extract<MicrosoftNativeCreateReadEvidence, { kind: "present" }>;
export type MicrosoftRuntimeCreateRemoteFact =
  | { readonly kind: "unobserved" }
  /** A complete listing with no marker is not resource absence or replay authority. */
  | { readonly kind: "missing"; readonly observationId: string }
  | { readonly kind: "confirmed" | "conflict"; readonly observationId: string;
      readonly read: MicrosoftRuntimeCreatePresentRead; readonly projection: MicrosoftTimedProjection | null };
export interface MicrosoftRuntimeCreateNativeFacts {
  readonly provider: MicrosoftRuntimeCreateProviderFact;
  readonly remote: MicrosoftRuntimeCreateRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedMicrosoftPersonalCreate {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: MicrosoftCreateTarget;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: MicrosoftRuntimeCreateProviderFact;
  /** Durable identity learned from an earlier response or confirmed correlation.
   * This does not claim that a provider acceptance response was received. */
  readonly priorCandidateEventId?: string | null;
}
export interface MicrosoftPersonalCreatePolicy {
  readonly completion: "provider-response" | "correlated-readback";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly nativeProfile: "existing-microsoft" | "strict-reference";
}
export type MicrosoftRuntimeCreateCompletionEvidence =
  | { readonly kind: "provider-response"; readonly eventId: string; readonly validator: string | null;
      readonly facts: MicrosoftRuntimeCreateNativeFacts }
  | { readonly kind: "correlated-readback"; readonly eventId: string; readonly validator: string | null;
      readonly projection: MicrosoftTimedProjection; readonly read: MicrosoftRuntimeCreatePresentRead;
      readonly facts: MicrosoftRuntimeCreateNativeFacts };
export interface MicrosoftRuntimeCreateFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: MicrosoftRuntimeCreateNativeFacts;
  readonly retryAfterMs?: number;
  /** Host-local only; never serialize into receipts, traces or diagnostics. */
  readonly cause?: unknown;
}
export interface MicrosoftPersonalCreateHostPorts {
  prepare?(signal: AbortSignal): Promise<void>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: MicrosoftCreateProviderPorts["accountSession"];
  beforeMutation(request: MicrosoftPersonalCreate, signal: AbortSignal): Promise<void>;
  /** Execute the actual host normalizer before comparison; fresh ID-only responses skip this port. */
  normalizeObservation(read: MicrosoftRuntimeCreatePresentRead, signal: AbortSignal):
    MicrosoftTimedProjection | null | Promise<MicrosoftTimedProjection | null>;
  recordEvidence(facts: MicrosoftRuntimeCreateNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: MicrosoftRuntimeCreateCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: MicrosoftRuntimeCreateFinishOutcome): Promise<void>;
  observationId(): string;
  recordDecision?(context: MicrosoftRuntimeCreateDecisionContext, frame: MicrosoftRuntimeCreateRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type MicrosoftCreateRuntimeProviderPorts = Pick<MicrosoftCreateProviderPorts, "http" | "clock" | "telemetry">;
export interface MicrosoftRuntimeCreateRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: MicrosoftRuntimeCreateNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export interface MicrosoftRuntimeCreateDecisionContext {
  readonly operationId: string;
  readonly candidateEventId: string | null;
  readonly projection: MicrosoftTimedProjection;
  readonly policy: MicrosoftPersonalCreatePolicy;
}
export type MicrosoftRuntimeCreateDecisionFact =
  | { readonly kind: "recovery-read" | "readback"; readonly read: MicrosoftNativeCreateReadEvidence;
      readonly projection: MicrosoftTimedProjection | null }
  | { readonly kind: "create" }
  | { readonly kind: "failure"; readonly error: RuntimeErrorInfo };
export type MicrosoftRuntimeCreateDecisionReason = "profile-unavailable" | "create-outcome-unknown" |
  "creation-identity-changed" | "readback-differs" | "remote-validator-unavailable" | "native-rejection";
export interface MicrosoftRuntimeCreateEvaluatedDecision {
  readonly decision: RuntimeTraceEntry["decision"];
  readonly reason?: MicrosoftRuntimeCreateDecisionReason;
}
export interface MicrosoftRuntimeCreateRecordedFrame {
  readonly fact: MicrosoftRuntimeCreateDecisionFact;
  readonly authoritative: MicrosoftRuntimeCreateEvaluatedDecision;
}
