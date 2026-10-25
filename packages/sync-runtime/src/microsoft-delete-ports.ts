import type {
  MicrosoftDeleteProviderPorts, MicrosoftEventTarget, MicrosoftNativeDeleteAbsence,
  MicrosoftNativeDeleteEvidence, MicrosoftNativeDeleteReadEvidence, MicrosoftNativeEvent, MicrosoftPersonalDelete,
} from "@musubi/provider-microsoft";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";
import type { RuntimeAckResult, RuntimeCheckpoint, RuntimeErrorInfo, RuntimeTraceEntry } from "./ports";

export type MicrosoftRuntimeDeleteProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly status: MicrosoftNativeDeleteEvidence["status"] }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export type MicrosoftRuntimeDeleteRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "absent"; readonly observationId: string; readonly read: MicrosoftNativeDeleteAbsence }
  | { readonly kind: "present"; readonly observationId: string;
      readonly read: Extract<MicrosoftNativeDeleteReadEvidence, { kind: "present" }> };
/** Acceptance, scoped absence and host settlement are independent facts. */
export interface MicrosoftRuntimeDeleteNativeFacts {
  readonly provider: MicrosoftRuntimeDeleteProviderFact;
  readonly remote: MicrosoftRuntimeDeleteRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedMicrosoftPersonalDelete {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: MicrosoftEventTarget;
  readonly acceptedEtag: unknown;
  readonly attemptNumber: number;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: MicrosoftRuntimeDeleteProviderFact;
  /** An already-admitted, distinct host resolution intent. The host owns its
   * comparison/CAS proof; only attempt one at its captured version may send. */
  readonly resolution?: { readonly expectedRemoteExists: true; readonly expectedRemoteEtag: string };
}
export interface MicrosoftPersonalDeletePolicy {
  /** Preserve Musubi's two native guard passes; reference uses one. */
  readonly preflightPasses: 1 | 2;
  readonly ambiguousRecovery: "deferred" | "within-attempt";
}
export interface MicrosoftRuntimeDeleteCompletionEvidence {
  readonly kind: "exact-absence";
  readonly read: MicrosoftNativeDeleteAbsence;
  readonly facts: MicrosoftRuntimeDeleteNativeFacts;
}
export interface MicrosoftRuntimeDeleteFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: MicrosoftRuntimeDeleteNativeFacts;
  readonly retryAfterMs?: number;
  /** Host-local only; never serialize this value into traces or receipts. */
  readonly cause?: unknown;
}
export interface MicrosoftPersonalDeleteHostPorts {
  prepare?(signal: AbortSignal): Promise<{ acceptedEtag: unknown }>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: MicrosoftDeleteProviderPorts["accountSession"];
  beforeMutation(request: MicrosoftPersonalDelete, signal: AbortSignal): Promise<void>;
  /** Preserve a host's existing normalization floor before a delivery read can
   * authorize preflight. This is not a substitute for native write guards. */
  validateObservation?(read: MicrosoftNativeDeleteReadEvidence, signal: AbortSignal): void | Promise<void>;
  recordEvidence(facts: MicrosoftRuntimeDeleteNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: MicrosoftRuntimeDeleteCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: MicrosoftRuntimeDeleteFinishOutcome): Promise<void>;
  observationId(): string;
  recordDecision?(context: MicrosoftRuntimeDeleteDecisionContext, frame: MicrosoftRuntimeDeleteRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type MicrosoftDeleteRuntimeProviderPorts = Pick<MicrosoftDeleteProviderPorts, "http" | "clock" | "telemetry">;
export interface MicrosoftRuntimeDeleteRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: MicrosoftRuntimeDeleteNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export interface MicrosoftRuntimeDeleteDecisionContext {
  readonly acceptedEtag: string;
  readonly observeOnly: boolean;
  readonly policy: MicrosoftPersonalDeletePolicy;
}
export type MicrosoftRuntimeDeleteDecisionFact =
  | { readonly kind: "delete-read" | "readback"; readonly read: MicrosoftNativeDeleteReadEvidence }
  | { readonly kind: "preflight"; readonly event: MicrosoftNativeEvent; readonly etag: string }
  | { readonly kind: "delete"; readonly deletion: MicrosoftNativeDeleteEvidence }
  | { readonly kind: "failure"; readonly error: RuntimeErrorInfo };
export type MicrosoftRuntimeDeleteDecisionReason = "remote-validator-unavailable" | "recovery-validator-changed" |
  "possible-dispatch-present" | "resource-present" | "native-rejection";
export interface MicrosoftRuntimeDeleteEvaluatedDecision {
  readonly decision: RuntimeTraceEntry["decision"];
  readonly reason?: MicrosoftRuntimeDeleteDecisionReason;
}
export interface MicrosoftRuntimeDeleteRecordedFrame {
  readonly fact: MicrosoftRuntimeDeleteDecisionFact;
  readonly authoritative: MicrosoftRuntimeDeleteEvaluatedDecision;
}
