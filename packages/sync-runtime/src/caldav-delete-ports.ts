import type {
  CaldavDeleteProviderPorts, CaldavEventTarget, CaldavNativeDeleteAbsence, CaldavNativeDeleteEvidence,
  CaldavNativeDeleteReadEvidence, CaldavNativeResource, CaldavPersonalDelete,
} from "@musubi/provider-caldav";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";
import type { RuntimeAckResult, RuntimeCheckpoint, RuntimeErrorInfo, RuntimeTraceEntry } from "./ports";

export type CaldavRuntimeErrorInfo = Omit<RuntimeErrorInfo, "capability"> & {
  readonly capability?: "event-write" | "organizer" | "recurrence";
};

export type CaldavRuntimeDeleteProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly status: CaldavNativeDeleteEvidence["status"] }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export type CaldavRuntimeDeleteRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "absent"; readonly observationId: string; readonly read: CaldavNativeDeleteAbsence }
  | { readonly kind: "present"; readonly observationId: string; readonly read: Extract<CaldavNativeDeleteReadEvidence, { kind: "present" }> };
/** Native deletion facts never claim a global canonical deletion, host settlement, or invented ETag. */
export interface CaldavRuntimeDeleteNativeFacts {
  readonly provider: CaldavRuntimeDeleteProviderFact;
  readonly remote: CaldavRuntimeDeleteRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedCaldavPersonalDelete {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: CaldavEventTarget;
  readonly acceptedEtag: unknown;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: CaldavRuntimeDeleteProviderFact;
}
export interface CaldavPersonalDeletePolicy {
  readonly completion: "provider-response" | "exact-absence";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly nativeProfile: "strict-reference" | "existing-caldav";
  readonly observeConflict: boolean;
}
export type CaldavRuntimeDeleteCompletionEvidence =
  | { readonly kind: "provider-response"; readonly status: CaldavNativeDeleteEvidence["status"]; readonly facts: CaldavRuntimeDeleteNativeFacts }
  | { readonly kind: "exact-absence"; readonly read: CaldavNativeDeleteAbsence; readonly facts: CaldavRuntimeDeleteNativeFacts };
export interface CaldavRuntimeDeleteFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: CaldavRuntimeErrorInfo;
  readonly facts: CaldavRuntimeDeleteNativeFacts;
  readonly retryAfterMs?: number;
  /** Opaque local error for the host only; never serialize it into receipts, traces, or logs. */
  readonly cause?: unknown;
}
export interface CaldavPersonalDeleteHostPorts {
  prepare?(signal: AbortSignal): Promise<{ acceptedEtag: unknown; acceptedUid: unknown }>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: CaldavDeleteProviderPorts["accountSession"];
  beforeMutation(request: CaldavPersonalDelete, signal: AbortSignal): Promise<void>;
  validateObservation?(read: CaldavNativeDeleteReadEvidence, signal: AbortSignal): void | Promise<void>;
  recordEvidence(facts: CaldavRuntimeDeleteNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: CaldavRuntimeDeleteCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: CaldavRuntimeDeleteFinishOutcome): Promise<void>;
  observationId(): string;
  recordDecision?(context: CaldavRuntimeDeleteDecisionContext, frame: CaldavRuntimeDeleteRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type CaldavDeleteRuntimeProviderPorts = Pick<CaldavDeleteProviderPorts, "network" | "http" | "clock" | "telemetry">;
export interface CaldavRuntimeDeleteRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: CaldavRuntimeDeleteNativeFacts;
  readonly error?: CaldavRuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export interface CaldavRuntimeDeleteDecisionContext {
  readonly acceptedEtag: string;
  readonly resourceUrl: string;
  readonly uid: string;
  readonly policy: CaldavPersonalDeletePolicy;
}
export type CaldavRuntimeDeleteDecisionFact =
  | { readonly kind: "delete-read" | "readback"; readonly read: CaldavNativeDeleteReadEvidence }
  | { readonly kind: "preflight"; readonly resource: CaldavNativeResource; readonly etag: string }
  | { readonly kind: "delete"; readonly deletion: CaldavNativeDeleteEvidence }
  | { readonly kind: "failure"; readonly error: CaldavRuntimeErrorInfo };
export type CaldavRuntimeDeleteDecisionReason = "resource-identity-changed" | "remote-validator-unavailable" | "recovery-validator-changed" | "resource-present" | "native-rejection";
export interface CaldavRuntimeDeleteEvaluatedDecision {
  readonly decision: RuntimeTraceEntry["decision"];
  readonly reason?: CaldavRuntimeDeleteDecisionReason;
}
export interface CaldavRuntimeDeleteRecordedFrame {
  readonly fact: CaldavRuntimeDeleteDecisionFact;
  readonly authoritative: CaldavRuntimeDeleteEvaluatedDecision;
}
