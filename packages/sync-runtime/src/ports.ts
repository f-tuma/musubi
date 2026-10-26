import type { BudgetDeferral } from "./provider-budget";
import type {
  GoogleAccountSession, GoogleEventTarget, GoogleNativeEvent, GoogleNativeReadEvidence, GoogleNativeUpdateEvidence, GooglePersonalUpdate, GoogleProviderPorts,
} from "@musubi/provider-google";
import type { SyncError, SyncOperationRowBinding } from "@musubi/types";

export type RuntimeProviderFact =
  | { readonly kind: "not-dispatched" }
  | { readonly kind: "accepted"; readonly validator: string | null }
  | { readonly kind: "uncertain" }
  | { readonly kind: "rejected"; readonly error: SyncError };
export interface GoogleTimedProjection {
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly start: string;
  readonly end: string;
  readonly isAllDay: false;
  readonly recurrence: null;
}
export type RuntimeRemoteFact =
  | { readonly kind: "unobserved" }
  | { readonly kind: "confirmed"; readonly observationId: string;
      readonly read: Extract<GoogleNativeReadEvidence, { kind: "present" }>; readonly projection: GoogleTimedProjection }
  | { readonly kind: "conflict"; readonly observationId: string; readonly read: GoogleNativeReadEvidence; readonly projection: GoogleTimedProjection | null };
/** Native facts do not claim a host canonical commit, mapping ACK, or notification delivery. */
export interface RuntimeNativeFacts {
  readonly provider: RuntimeProviderFact;
  readonly remote: RuntimeRemoteFact;
  readonly possibleDispatch: boolean;
}
export interface ClaimedGooglePersonalUpdate {
  readonly operationId: string;
  readonly attemptId: string;
  readonly payload: unknown;
  readonly binding: SyncOperationRowBinding;
  /** Calendar/event must match the admitted address; physical credential identity may differ. */
  readonly nativeTarget: GoogleEventTarget;
  readonly acceptedEtag: unknown;
  readonly recovery: { readonly required: boolean; readonly possibleDispatch: boolean };
  readonly priorProvider: RuntimeProviderFact;
}
/** Hosts own claim and private capture tokens. The operational entry is already-claimed only. */
export interface RuntimeClaimPort<TClaim> { claim(operationId: string): Promise<TClaim | null> }

export interface GooglePersonalUpdatePolicy {
  readonly completion: "provider-response" | "exact-readback";
  readonly ambiguousRecovery: "deferred" | "within-attempt";
  readonly compareContent: "literal" | "nullable-empty";
  readonly untouchedPreflight: boolean;
  readonly nativeProfile: "strict-reference" | "existing-google";
  /** Preserve hosts which collect one exact observation after a native conflict. */
  readonly observeConflict: boolean;
}
export type RuntimePhase = "decode" | "credentials" | "recovery-read" | "preflight" | "mutation" | "readback" | "evidence" | "ack" | "finish";
export interface RuntimeErrorInfo {
  readonly deferral?: BudgetDeferral;
  readonly code: string;
  readonly outcome: "not-written" | "unconfirmed";
  readonly phase: RuntimePhase;
  readonly providerStatus?: number;
  readonly retryAfterMs?: number;
  readonly capability?: "event-write" | "organizer";
  readonly evidence?: "denied" | "unknown" | "unsupported";
  readonly interruption?: "timeout" | "lease-lost" | "cancelled";
}
/** Hosts may translate their own errors without importing product classes into the kernel. */
export class SyncRuntimeHostError extends Error {
  constructor(readonly info: Omit<RuntimeErrorInfo, "phase">) {
    super(`Sync runtime host: ${info.code}`);
    this.name = "SyncRuntimeHostError";
  }
}
export type RuntimeCompletionEvidence =
  | { readonly kind: "provider-response"; readonly validator: string | null; readonly facts: RuntimeNativeFacts }
  | { readonly kind: "exact-readback"; readonly validator: string; readonly projection: GoogleTimedProjection;
      readonly read: Extract<GoogleNativeReadEvidence, { kind: "present" }>; readonly facts: RuntimeNativeFacts };
export type RuntimeAckResult =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "authority-rejected" | "lease-rejected" | "mapping-conflict" };
export interface RuntimeFinishOutcome {
  readonly status: "hold" | "conflict";
  readonly error: RuntimeErrorInfo;
  readonly facts: RuntimeNativeFacts;
  /** Infinity means the host must retain an indefinite gate, never clamp to an early retry. */
  readonly retryAfterMs?: number;
  /** Opaque host-local error only: never put this value in receipts, traces, logs or serialized results. */
  readonly cause?: unknown;
}
export type RuntimeCheckpoint = "afterCredentials" | "beforeDispatch" | "afterAcceptance" | "afterUncertain" | "afterReadback" | "afterAck";
export interface GooglePersonalUpdateHostPorts {
  /** Resolve a predecessor/native validator under this attempt budget; address and body remain pinned. */
  prepare?(signal: AbortSignal): Promise<{ acceptedEtag: unknown }>;
  renew(signal: AbortSignal): Promise<boolean>;
  accountSession: {
    open(connection: Pick<GoogleEventTarget, "connectionId" | "connectionGeneration">, signal?: AbortSignal): Promise<GoogleAccountSession>;
  };
  /** Reprove host authority/live lease and persist possible dispatch before resolving. */
  beforeMutation(request: GooglePersonalUpdate, signal: AbortSignal): Promise<void>;
  /** Must keep an abandoned/stale attempt from overwriting its successor. */
  recordEvidence(facts: RuntimeNativeFacts, signal: AbortSignal): Promise<void>;
  /** Host-owned atomic mapping/settlement. Check the active signal inside a waiting transaction. */
  ack(evidence: RuntimeCompletionEvidence, signal: AbortSignal): Promise<RuntimeAckResult>;
  finish(outcome: RuntimeFinishOutcome): Promise<void>;
  observationId(): string;
  /** Synchronous private diagnostic capture; never serialize native payloads or add shadow capabilities. */
  recordDecision?(context: RuntimeDecisionContext, frame: RuntimeRecordedFrame): void;
  checkpoint?(phase: RuntimeCheckpoint, signal: AbortSignal): void | Promise<void>;
}
export type GoogleRuntimeProviderPorts = Pick<GoogleProviderPorts, "http" | "clock" | "telemetry">;
export interface RuntimeAttemptOptions {
  timeoutMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}
export type RuntimeDecision = "hold" | "observe" | "preflight" | "dispatch" | "accepted" | "uncertain" | "confirmed" | "conflict" | "acknowledged";
export interface RuntimeTraceEntry { readonly decision: RuntimeDecision; readonly phase: RuntimePhase }
export interface RuntimeRunResult {
  readonly status: "acked" | "hold" | "conflict";
  readonly operationId: string;
  readonly attemptId: string;
  readonly facts: RuntimeNativeFacts;
  readonly error?: RuntimeErrorInfo;
  readonly trace: readonly RuntimeTraceEntry[];
}

export interface RuntimeDecisionContext {
  readonly projection: GoogleTimedProjection;
  readonly acceptedEtag: string;
  readonly body: Readonly<Record<string, string | null>>;
  readonly policy: GooglePersonalUpdatePolicy;
}
export type RuntimeDecisionFact =
  | { readonly kind: "recovery-read" | "readback"; readonly read: GoogleNativeReadEvidence }
  | { readonly kind: "preflight"; readonly event: GoogleNativeEvent }
  | { readonly kind: "write"; readonly write: GoogleNativeUpdateEvidence }
  | { readonly kind: "failure"; readonly error: RuntimeErrorInfo };
export type RuntimeDecisionReason = "profile-unavailable" | "resource-absent" | "resource-cancelled" | "readback-differs" | "recovery-validator-changed" | "untouched-fields-differ" | "native-rejection";
export interface RuntimeEvaluatedDecision { readonly decision: RuntimeDecision; readonly reason?: RuntimeDecisionReason }
export interface RuntimeRecordedFrame { readonly fact: RuntimeDecisionFact; readonly authoritative: RuntimeEvaluatedDecision }
