import type {
  GoogleCreateProviderPorts, GoogleEventTarget, GoogleNativeCreateReadEvidence, GooglePersonalCreate,
} from "@musubi/provider-google";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";
import type { GoogleTimedProjection, RuntimeAckResult, RuntimeCheckpoint, RuntimeErrorInfo, RuntimeTraceEntry } from "./ports";

export type RuntimeCreateProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly validator: string | null }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export type RuntimeCreatePresentRead = Extract<GoogleNativeCreateReadEvidence, { kind: "present" }>;
export type RuntimeCreateRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "confirmed"; readonly observationId: string; readonly read: RuntimeCreatePresentRead; readonly projection: GoogleTimedProjection }
  | { readonly kind: "conflict"; readonly observationId: string; readonly read: RuntimeCreatePresentRead; readonly projection: GoogleTimedProjection | null };
export interface RuntimeCreateNativeFacts {
  readonly provider: RuntimeCreateProviderFact;
  readonly remote: RuntimeCreateRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedGooglePersonalCreate {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: GoogleEventTarget;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: RuntimeCreateProviderFact;
}
export interface GooglePersonalCreatePolicy {
  readonly completion: "provider-response" | "exact-readback";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly compareContent: "literal" | "nullable-empty";
  readonly nativeProfile: "strict-reference" | "existing-google";
  readonly requireStrongReadback: boolean;
}
export type RuntimeCreateCompletionEvidence =
  | { readonly kind: "provider-response"; readonly eventId: string; readonly validator: string | null; readonly facts: RuntimeCreateNativeFacts }
  | { readonly kind: "exact-readback"; readonly eventId: string; readonly validator: string | null; readonly projection: GoogleTimedProjection;
      readonly read: RuntimeCreatePresentRead; readonly facts: RuntimeCreateNativeFacts };
export interface RuntimeCreateFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: RuntimeCreateNativeFacts;
  readonly retryAfterMs?: number;
  /** Host-local only; must not enter receipts, traces or serialized results. */
  readonly cause?: unknown;
}
export interface GooglePersonalCreateHostPorts {
  /** Prove current authority/tombstone/coverage before any credentials or HTTP. */
  prepare?(signal: AbortSignal): Promise<void>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: GoogleCreateProviderPorts["accountSession"];
  beforeMutation(request: GooglePersonalCreate, signal: AbortSignal): Promise<void>;
  recordEvidence(facts: RuntimeCreateNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: RuntimeCreateCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: RuntimeCreateFinishOutcome): Promise<void>;
  observationId(): string;
  recordDecision?(context: RuntimeCreateDecisionContext, frame: RuntimeCreateRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type GoogleCreateRuntimeProviderPorts = Pick<GoogleCreateProviderPorts, "http" | "clock" | "telemetry">;
export interface RuntimeCreateRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: RuntimeCreateNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export interface RuntimeCreateDecisionContext {
  readonly operationId: string;
  readonly eventId: string;
  readonly projection: GoogleTimedProjection;
  readonly policy: GooglePersonalCreatePolicy;
}
export type RuntimeCreateDecisionFact =
  | { readonly kind: "recovery-read" | "readback"; readonly read: GoogleNativeCreateReadEvidence }
  | { readonly kind: "create" }
  | { readonly kind: "failure"; readonly error: RuntimeErrorInfo };
export type RuntimeCreateDecisionReason = "profile-unavailable" | "resource-absent" | "creation-identity-changed" | "readback-differs" | "remote-validator-unavailable" | "native-rejection";
export interface RuntimeCreateEvaluatedDecision {
  readonly decision: RuntimeTraceEntry["decision"];
  readonly reason?: RuntimeCreateDecisionReason;
}
export interface RuntimeCreateRecordedFrame {
  readonly fact: RuntimeCreateDecisionFact;
  readonly authoritative: RuntimeCreateEvaluatedDecision;
}
