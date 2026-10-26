import type { SyncOperationDecodeResult, Task } from "@musubi/types";
import type { RuntimeAttemptOptions } from "./ports";

/** These are host-native JSON projections, not the portable task schema. In
 * particular, retained v0 data keeps the existing provider parser's floor. */
export type TaskCompatibilityProjection = Record<string, unknown>;
export interface TaskCompatibilityRef {
  readonly externalTaskId: string;
  readonly etag?: string | null;
  readonly icalUid?: string | null;
}
export interface TaskCompatibilityExpectedRef {
  readonly externalTaskId: string | null;
  readonly etag: string | null;
  readonly icalUid: string | null;
}
export interface TaskCompatibilityRead {
  readonly ref: TaskCompatibilityRef;
  readonly projection: TaskCompatibilityProjection;
}
export interface TaskCompatibilitySavedProjection {
  readonly version: 1;
  readonly projection: TaskCompatibilityProjection;
  readonly baseline: TaskCompatibilityProjection | null;
  readonly patch: TaskCompatibilityProjection;
  readonly errorCode?: string;
}
/** Explicitly host-only: this runner neither supplies a native implementation
 * nor proves To Do conditional writes or a portable VTODO resource profile. */
export interface TaskCompatibilityProfile {
  readonly kind: "host-only";
  readonly family: "google-predecessor-create" | "google-task" | "todo-home" | "todo-secondary-refusal" | "vtodo-resource" | "retained-provider";
  readonly representation: "pinned-v1" | "retained-v0";
}
export interface ClaimedTaskCompatibility {
  readonly operationId: string;
  readonly attemptId: string;
  readonly action: "create" | "update" | "delete";
  readonly reconciling: boolean;
  readonly priorResultRef?: TaskCompatibilityRef | null;
}
export type TaskCompatibilityPreparation =
  | { readonly kind: "blocked"; readonly code: string }
  | { readonly kind: "not-needed" }
  | {
    readonly kind: "ready";
    /** Keep the original decoded claim. No v0 re-encoding or new admission. */
    readonly decoded: Exclude<SyncOperationDecodeResult, { kind: "blocked" }>;
    readonly profile: TaskCompatibilityProfile;
    readonly task: Task;
    readonly authority: "home" | "secondary";
    readonly dispatchAllowed: boolean;
    /** Address/version and baseline come from one host-validated history. */
    readonly paired: {
      readonly ref: TaskCompatibilityExpectedRef;
      readonly projectionBaseline: TaskCompatibilityProjection | null;
      readonly hasPredecessor: boolean;
    };
    readonly projectionBaseline: TaskCompatibilityProjection | null;
    readonly target: TaskCompatibilityProjection;
    readonly saved?: TaskCompatibilitySavedProjection;
    readonly recovery: {
      readonly kind: "response-address-only" | "task-uuid-resource";
      readonly ref?: TaskCompatibilityRef;
    };
  };
export type ReadyTaskCompatibility = Extract<TaskCompatibilityPreparation, { kind: "ready" }>;
export interface TaskCompatibilityWrite {
  readonly action: ClaimedTaskCompatibility["action"];
  readonly task: Task;
  readonly external?: TaskCompatibilityRef;
  readonly projection: TaskCompatibilityProjection;
  readonly secondary: boolean;
}
export interface TaskCompatibilityNativePorts {
  read(ref: TaskCompatibilityRef, signal: AbortSignal): Promise<TaskCompatibilityRead | null>;
  preflight(request: TaskCompatibilityWrite, signal: AbortSignal): Promise<void>;
  create(task: Task, beforeMutation: () => Promise<void>, signal: AbortSignal): Promise<TaskCompatibilityRef>;
  update(task: Task, ref: TaskCompatibilityRef, patch: TaskCompatibilityProjection, beforeMutation: () => Promise<void>, signal: AbortSignal): Promise<Pick<TaskCompatibilityRef, "etag" | "icalUid"> | void>;
  delete(ref: TaskCompatibilityRef, beforeMutation: () => Promise<void>, signal: AbortSignal): Promise<void>;
}
export interface TaskCompatibilityFailureInfo {
  readonly code: string;
  readonly outcome: "not-written" | "unconfirmed";
  readonly providerStatus?: number;
  readonly retryAfterMs?: number;
}
export class TaskCompatibilityError extends Error {
  constructor(readonly info: TaskCompatibilityFailureInfo) {
    super(`Task compatibility delivery: ${info.code}.`);
    this.name = "TaskCompatibilityError";
  }
}
export interface TaskCompatibilityFacts {
  readonly possibleDispatch: boolean;
  /** Complete awaited writer fulfillment is NOT known HTTP acceptance. A
   * native DELETE may return after a GET proves absence without dispatch. */
  readonly writerFulfilled: boolean;
  readonly resultRef?: TaskCompatibilityRef;
  /** Captured before a waiting host ACK, including a subsequently rejected ACK. */
  readonly acknowledgementProjection?: TaskCompatibilityProjection;
}
export type TaskCompatibilityFinish =
  | { readonly kind: "blocked"; readonly code: string; readonly facts: TaskCompatibilityFacts }
  | { readonly kind: "not-needed"; readonly current?: TaskCompatibilityRead | null; readonly facts: TaskCompatibilityFacts }
  | { readonly kind: "failed"; readonly error?: TaskCompatibilityFailureInfo; readonly facts: TaskCompatibilityFacts; readonly cause: unknown };
export interface TaskCompatibilityHostPorts {
  prepare(signal: AbortSignal): Promise<TaskCompatibilityPreparation>;
  saveProjection(saved: TaskCompatibilitySavedProjection, signal: AbortSignal): Promise<boolean>;
  renew(signal: AbortSignal): Promise<boolean>;
  /** Revalidate current lease/source/privacy; no transaction spans native I/O. */
  beforeMutation(signal: AbortSignal): Promise<boolean>;
  ack(evidence: TaskCompatibilityRead | null, deletionRef: TaskCompatibilityRef | undefined, expected: TaskCompatibilityExpectedRef,
    signal: AbortSignal): Promise<boolean>;
  finish(outcome: TaskCompatibilityFinish): Promise<void>;
  classifyError(error: unknown): TaskCompatibilityFailureInfo | undefined;
}
export interface TaskCompatibilityResult {
  readonly status: "acknowledged" | "finished";
  readonly facts: TaskCompatibilityFacts;
}
export type TaskCompatibilityAttemptOptions = RuntimeAttemptOptions;
