import type {
  CaldavCreateProviderPorts, CaldavEventTarget, CaldavNativeCreateEvidence, CaldavNativeCreateReadEvidence, CaldavPersonalCreate,
} from "@musubi/provider-caldav";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";
import type { RuntimeAckResult, RuntimeCheckpoint, RuntimeTraceEntry } from "./ports";
import type { CaldavRuntimeErrorInfo } from "./caldav-delete-ports";

export type CaldavRuntimeCreateProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly validator: string | null; readonly status: CaldavNativeCreateEvidence["status"] }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export interface CaldavTimedProjection {
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly start: string;
  readonly end: string;
  readonly isAllDay: false;
  readonly recurrence: null;
}
export type CaldavRuntimeCreatePresentRead = Extract<CaldavNativeCreateReadEvidence, { kind: "present" }>;
export type CaldavRuntimeCreateRemoteFact =
  | { readonly kind: "unobserved" }
  /** Scoped GET 404 permits only the original conditional write, not a global delete. */
  | { readonly kind: "absent"; readonly observationId: string }
  | { readonly kind: "confirmed" | "conflict"; readonly observationId: string;
      readonly read: CaldavRuntimeCreatePresentRead; readonly projection: CaldavTimedProjection | null };
export interface CaldavRuntimeCreateNativeFacts {
  readonly provider: CaldavRuntimeCreateProviderFact;
  readonly remote: CaldavRuntimeCreateRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedCaldavPersonalCreate {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  readonly nativeTarget: CaldavEventTarget;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: CaldavRuntimeCreateProviderFact;
}
export interface CaldavPersonalCreatePolicy {
  readonly completion: "provider-response" | "exact-readback";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly nativeProfile: "existing-caldav" | "strict-reference";
  readonly requireStrongReadback: boolean;
}
export type CaldavRuntimeCreateCompletionEvidence =
  | { readonly kind: "provider-response"; readonly resourceUrl: string; readonly uid: string; readonly validator: string | null;
      readonly facts: CaldavRuntimeCreateNativeFacts }
  | { readonly kind: "exact-readback"; readonly resourceUrl: string; readonly uid: string; readonly validator: string | null;
      readonly projection: CaldavTimedProjection; readonly read: CaldavRuntimeCreatePresentRead; readonly facts: CaldavRuntimeCreateNativeFacts };
export interface CaldavRuntimeCreateFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: CaldavRuntimeErrorInfo;
  readonly facts: CaldavRuntimeCreateNativeFacts;
  readonly retryAfterMs?: number;
  /** Host-local only; never serialize into receipts, traces or diagnostics. */
  readonly cause?: unknown;
}
export interface CaldavPersonalCreateHostPorts {
  prepare?(signal: AbortSignal): Promise<void>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: CaldavCreateProviderPorts["accountSession"];
  beforeMutation(request: CaldavPersonalCreate, signal: AbortSignal): Promise<void>;
  /** Actual host CREATE normalizer. Fresh PUT responses skip normalization. */
  normalizeObservation(read: CaldavRuntimeCreatePresentRead, signal: AbortSignal):
    CaldavTimedProjection | null | Promise<CaldavTimedProjection | null>;
  recordEvidence(facts: CaldavRuntimeCreateNativeFacts, signal: AbortSignal): Promise<void>;
  ack(evidence: CaldavRuntimeCreateCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: CaldavRuntimeCreateFinishOutcome): Promise<void>;
  observationId(): string;
  recordDecision?(context: CaldavRuntimeCreateDecisionContext, frame: CaldavRuntimeCreateRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type CaldavCreateRuntimeProviderPorts = Pick<CaldavCreateProviderPorts, "network" | "http" | "clock" | "telemetry">;
export interface CaldavRuntimeCreateRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: CaldavRuntimeCreateNativeFacts;
  readonly error?: CaldavRuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}
export interface CaldavRuntimeCreateDecisionContext {
  readonly operationId: string;
  readonly resourceUrl: string;
  readonly uid: string;
  readonly projection: CaldavTimedProjection;
  readonly policy: CaldavPersonalCreatePolicy;
}
export type CaldavRuntimeCreateDecisionFact =
  | { readonly kind: "recovery-read" | "readback"; readonly read: CaldavNativeCreateReadEvidence; readonly projection: CaldavTimedProjection | null }
  | { readonly kind: "create" }
  | { readonly kind: "failure"; readonly error: CaldavRuntimeErrorInfo };
export type CaldavRuntimeCreateDecisionReason = "profile-unavailable" | "resource-absent" | "creation-identity-changed" |
  "readback-differs" | "remote-validator-unavailable" | "native-rejection";
export interface CaldavRuntimeCreateEvaluatedDecision {
  readonly decision: RuntimeTraceEntry["decision"];
  readonly reason?: CaldavRuntimeCreateDecisionReason;
}
export interface CaldavRuntimeCreateRecordedFrame {
  readonly fact: CaldavRuntimeCreateDecisionFact;
  readonly authoritative: CaldavRuntimeCreateEvaluatedDecision;
}
