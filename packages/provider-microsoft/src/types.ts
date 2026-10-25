/** Native addresses and host-owned connection incarnations; no storage identity is interpreted here. */
export interface MicrosoftEventTarget {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly calendarId: string;
  readonly eventId: string;
}
/** The accepted native weak ETag is a preflight guard, never a DELETE CAS guarantee. */
export interface MicrosoftPersonalDelete {
  readonly target: MicrosoftEventTarget;
  readonly acceptedEtag: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "microsoft-personal-event"; readonly version: 1 };
}
export interface MicrosoftAccountSession {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly accessToken: string;
  /** Current evidence after any host-owned token refresh. Missing evidence is not a grant. */
  readonly eventWriteAllowed: boolean | undefined;
}
export interface MicrosoftRequestMetric {
  readonly provider: "microsoft";
  readonly family: "event";
  readonly method: "GET" | "DELETE" | "POST";
  readonly status: number | "network-error" | "aborted";
  readonly durationMs: number;
}
export interface MicrosoftDeleteProviderPorts {
  readonly accountSession: {
    open(connection: Pick<MicrosoftEventTarget, "connectionId" | "connectionGeneration">, signal?: AbortSignal): Promise<MicrosoftAccountSession>;
  };
  readonly http: { fetch(url: string, init: RequestInit): Promise<Response> };
  readonly clock: { nowEpochMs(): number; nowMonotonicMs(): number };
  /** Diagnostic failures cannot change the provider outcome; labels contain no native identities or payloads. */
  readonly telemetry: { record(metric: MicrosoftRequestMetric): void };
  /** Host authority and lease fence after credentials, immediately before dispatch. */
  readonly beforeMutation: (request: MicrosoftPersonalDelete, signal?: AbortSignal) => Promise<void>;
}
export type MicrosoftNativeJsonValue = null | boolean | number | string | readonly MicrosoftNativeJsonValue[] | { readonly [key: string]: MicrosoftNativeJsonValue };
export interface MicrosoftNativeEndpoint {
  readonly dateTime: string;
  readonly timeZone?: string;
}
/** Retained bounded native JSON, not a canonical product Event or a write command.
 * Only identity and usable dates are required for observation; personal guards belong to preflight. */
export type MicrosoftNativeEvent = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly start: MicrosoftNativeEndpoint;
  readonly end: MicrosoftNativeEndpoint;
};
export type MicrosoftNativeDeleteAbsence = { readonly kind: "absent"; readonly status: 404 };
export type MicrosoftNativeDeleteReadEvidence =
  | { readonly kind: "present"; readonly event: MicrosoftNativeEvent; readonly etag: string | null }
  | MicrosoftNativeDeleteAbsence;
export type MicrosoftNativeDeletePreflight =
  | { readonly kind: "allowed"; readonly event: MicrosoftNativeEvent; readonly etag: string }
  | MicrosoftNativeDeleteAbsence;
/** Native acceptance only. The caller must separately persist this and verify exact 404 before ACK. */
export type MicrosoftNativeDeleteEvidence = { readonly kind: "deleted"; readonly status: 204 | 404 };
/** CREATE has no admitted native event ID; Graph assigns it after dispatch. */
export interface MicrosoftCreateTarget {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly calendarId: string;
}
/** Frozen microsoft-personal-event@1 timed, nonrecurring CREATE body. */
export interface MicrosoftPersonalCreateBody {
  readonly subject: string;
  readonly body: { readonly contentType: "text"; readonly content: string };
  readonly location: { readonly displayName: string };
  readonly isAllDay: false;
  readonly start: { readonly dateTime: string; readonly timeZone: "UTC" };
  readonly end: { readonly dateTime: string; readonly timeZone: "UTC" };
  readonly transactionId: string;
}
export interface MicrosoftPersonalCreate {
  readonly target: MicrosoftCreateTarget;
  readonly body: MicrosoftPersonalCreateBody;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "microsoft-personal-event"; readonly version: 1 };
}
export type MicrosoftCreateNativeProfile = "existing-microsoft" | "strict-reference";
export interface MicrosoftCreateProviderPorts extends Omit<MicrosoftDeleteProviderPorts, "beforeMutation"> {
  readonly beforeMutation: (request: MicrosoftPersonalCreate, signal?: AbortSignal) => Promise<void>;
}
export type MicrosoftNativeCreatePreflight = { readonly kind: "allowed" };
/** Raw provider acceptance; its ETag is any native string, not a DELETE guard. */
export type MicrosoftNativeCreateEvidence = {
  readonly kind: "created"; readonly status: 200 | 201 | 204; readonly eventId: string; readonly etag: string | null;
};
/** A missing complete listing is observation only, never proof that re-POST is safe. */
export type MicrosoftNativeCreateReadEvidence =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly event: MicrosoftNativeEvent; readonly etag: string | null };
export type MicrosoftProviderErrorCode =
  | "provider-conflict"
  | "provider-version-unavailable"
  | "event-diff-unavailable"
  | "provider-write-failed"
  | "account-session-changed"
  | "capability-evidence";
export class MicrosoftProviderError extends Error {
  constructor(
    readonly code: MicrosoftProviderErrorCode,
    readonly outcome: "not-written" | "unconfirmed" = "not-written",
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
    readonly capability?: "event-write" | "organizer",
    readonly evidence?: "denied" | "unknown" | "unsupported",
  ) {
    super(`Microsoft event delivery: ${code}.`);
    this.name = "MicrosoftProviderError";
  }
}
