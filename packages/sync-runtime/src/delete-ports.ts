import type {
  GoogleDeleteProviderPorts, GoogleEventTarget, GoogleNativeDeleteAbsence, GoogleNativeDeleteEvidence,
  GoogleNativeDeleteReadEvidence, GoogleNativeEvent, GooglePersonalDelete,
} from "@musubi/provider-google";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";
import type { RuntimeAckResult, RuntimeCheckpoint, RuntimeErrorInfo, RuntimeTraceEntry } from "./ports";

export type RuntimeDeleteProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly status: GoogleNativeDeleteEvidence["status"] }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export type RuntimeDeleteRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "absent"; readonly observationId: string; readonly read: GoogleNativeDeleteAbsence }
  | { readonly kind: "conflict"; readonly observationId: string; readonly read: Extract<GoogleNativeDeleteReadEvidence, { kind: "present" }> };
/** Native deletion facts never claim a global canonical deletion, host settlement, or invented ETag. */
export interface RuntimeDeleteNativeFacts {
  readonly provider: RuntimeDeleteProviderFact;
  readonly remote: RuntimeDeleteRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedGooglePersonalDelete {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: GoogleEventTarget;
  readonly acceptedEtag: unknown;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: RuntimeDeleteProviderFact;
}
export interface GooglePersonalDeletePolicy {
  readonly completion: "provider-response" | "exact-absence";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly nativeProfile: "strict-reference" | "existing-google";
  readonly observeConflict: boolean;
}
export type RuntimeDeleteCompletionEvidence =
  | { readonly kind: "provider-response"; readonly status: GoogleNativeDeleteEvidence["status"]; readonly facts: RuntimeDeleteNativeFacts }
  | { readonly kind: "exact-absence"; readonly read: GoogleNativeDeleteAbsence; readonly facts: RuntimeDeleteNativeFacts };
export interface RuntimeDeleteFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: RuntimeDeleteNativeFacts;
  readonly retryAfterMs?: number;
  /** Opaque local error for the host only; never serialize it into receipts, traces, or logs. */
  readonly cause?: unknown;
}
export interface GooglePersonalDeleteHostPorts {
  prepare?(signal: AbortSignal): Promise<{ acceptedEtag: unknown }>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: GoogleDeleteProviderPorts["accountSession"];
  beforeMutation(request: GooglePersonalDelete, signal: AbortSignal): Promise<void>;
  recordEvidence(facts: RuntimeDeleteNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: RuntimeDeleteCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: RuntimeDeleteFinishOutcome): Promise<void>;
  observationId(): string;
  recordDecision?(context: RuntimeDeleteDecisionContext, frame: RuntimeDeleteRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type GoogleDeleteRuntimeProviderPorts = Pick<GoogleDeleteProviderPorts, "http" | "clock" | "telemetry">;
export interface RuntimeDeleteRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: RuntimeDeleteNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export interface RuntimeDeleteDecisionContext {
  readonly acceptedEtag: string;
  readonly policy: GooglePersonalDeletePolicy;
}
export type RuntimeDeleteDecisionFact =
  | { readonly kind: "delete-read" | "readback"; readonly read: GoogleNativeDeleteReadEvidence }
  | { readonly kind: "preflight"; readonly event: GoogleNativeEvent; readonly etag: string }
  | { readonly kind: "delete"; readonly deletion: GoogleNativeDeleteEvidence }
  | { readonly kind: "failure"; readonly error: RuntimeErrorInfo };
export type RuntimeDeleteDecisionReason = "profile-unavailable" | "remote-validator-unavailable" | "recovery-validator-changed" | "resource-present" | "native-rejection";
export interface RuntimeDeleteEvaluatedDecision {
  readonly decision: RuntimeTraceEntry["decision"];
  readonly reason?: RuntimeDeleteDecisionReason;
}
export interface RuntimeDeleteRecordedFrame {
  readonly fact: RuntimeDeleteDecisionFact;
  readonly authoritative: RuntimeDeleteEvaluatedDecision;
}
