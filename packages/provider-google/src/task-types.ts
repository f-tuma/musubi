/** A captured Google Tasks address, separate from Calendar event identities. */
export interface GoogleTaskTarget {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly taskListId: string;
  readonly taskId: string;
}
export type GoogleTaskProjection = Readonly<{
  title: string;
  notes: string | null;
  status: "needsAction" | "completed";
  due: string | null;
}>;
export type GoogleTaskUpdateBody = Readonly<Partial<GoogleTaskProjection>>;
/** Existing native reads deliberately retain malformed notes/date values for
 * the host's original normalization floor. Admitted targets remain strict. */
export type GoogleTaskObservedProjection = Readonly<{
  title: string;
  notes: unknown;
  status: "needsAction" | "completed";
  due: string | null;
}>;
export interface GoogleTaskUpdate {
  readonly target: GoogleTaskTarget;
  readonly acceptedEtag: string;
  readonly body: GoogleTaskUpdateBody;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "google-task"; readonly version: 1 };
}
export interface GoogleTaskAccountSession {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly accessToken: string;
  /** The current Tasks grant AFTER any host-owned refresh. Calendar is separate. */
  readonly taskWriteAllowed: boolean | undefined;
}
export interface GoogleTaskRequestMetric {
  readonly provider: "google";
  readonly family: "task";
  readonly method: "GET" | "PATCH";
  readonly status: number | "network-error" | "aborted";
  readonly durationMs: number;
}
export interface GoogleNativeTask extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly title: string;
  readonly status: "needsAction" | "completed";
  readonly etag: string;
  readonly notes?: unknown;
  readonly due?: unknown;
  readonly assignmentInfo?: unknown;
}
export type GoogleNativeTaskReadEvidence =
  | { readonly kind: "present"; readonly task: GoogleNativeTask; readonly etag: string }
  | { readonly kind: "absent"; readonly status: 404 | 410 };
export type GoogleNativeTaskUpdatePreflight = {
  readonly kind: "allowed";
  readonly read: Extract<GoogleNativeTaskReadEvidence, { kind: "present" }>;
};
export type GoogleNativeTaskUpdateEvidence =
  | { readonly kind: "written"; readonly etag: string }
  | { readonly kind: "not-written"; readonly reason: "empty-body" };
/** Raw accepted HTTP status is a separate fact before success JSON is parsed. */
export interface GoogleNativeTaskAcceptedResponse {
  readonly status: 200 | 201 | 204;
  readonly validator: null;
}
export interface GoogleTaskProviderPorts {
  readonly accountSession: {
    open(connection: Pick<GoogleTaskTarget, "connectionId" | "connectionGeneration">, signal?: AbortSignal): Promise<GoogleTaskAccountSession>;
    /** Retry only a concrete rejected delivery GET, never PATCH or the final
     * native read immediately before PATCH. Refresh/CAS remains host-owned. */
    recoverRejectedRead?(connection: Pick<GoogleTaskTarget, "connectionId" | "connectionGeneration">,
      rejectedAccessToken: string, signal?: AbortSignal): Promise<GoogleTaskAccountSession>;
    /** Existing hosts preserve their own raw resource_401 error after cancelling
     * the second rejected delivery GET. No retry hint is invented. */
    onReadAuthenticationRejected?(signal?: AbortSignal): Promise<never>;
  };
  readonly http: { fetch(url: string, init: RequestInit): Promise<Response> };
  readonly clock: { nowEpochMs(): number; nowMonotonicMs(): number };
  readonly telemetry: { record(metric: GoogleTaskRequestMetric): void };
  readonly beforeMutation: (request: GoogleTaskUpdate, signal?: AbortSignal) => Promise<void>;
  readonly onAcceptedResponse: (acceptance: GoogleNativeTaskAcceptedResponse, signal?: AbortSignal) => Promise<void>;
}
export type GoogleTaskProviderErrorCode =
  | "task-provider-conflict" | "task-version-unavailable" | "task-write-failed"
  | "task-conditional-write-unsupported" | "task-recurrence-projection-unsupported"
  | "task-source-read-only" | "task-create-unconfirmed" | "task-projection-unavailable"
  | "account-session-changed" | "task-scope-missing";
export class GoogleTaskProviderError extends Error {
  constructor(readonly code: GoogleTaskProviderErrorCode, readonly outcome: "not-written" | "unconfirmed" = "not-written",
    readonly providerStatus?: number, readonly retryAfterMs?: number) {
    super(`Google task delivery: ${code}.`);
    this.name = "GoogleTaskProviderError";
  }
}
