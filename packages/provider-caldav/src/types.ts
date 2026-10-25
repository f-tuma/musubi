import type { LookupAddress } from "node:dns";
import type { LookupAll } from "./network-origin";

/** Opaque host account revision and exact admitted native address/UID. */
export interface CaldavEventTarget {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly calendarUrl: string;
  readonly resourceUrl: string;
  readonly uid: string;
}
export interface CaldavPersonalDelete {
  readonly target: CaldavEventTarget;
  readonly acceptedEtag: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "caldav-personal-event"; readonly version: 1 };
}
export interface CaldavAccountSession {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  /** Exact host-created Basic authorization value; never receipt/diagnostic data. */
  readonly authorization: string;
}
export type CaldavNativeProfile = "existing-caldav" | "strict-reference";
export interface CaldavDeleteProviderOptions { readonly nativeProfile: CaldavNativeProfile }
export interface CaldavRequestMetric {
  readonly provider: "caldav";
  readonly family: "event";
  readonly method: "GET" | "PROPFIND" | "DELETE";
  readonly status: number | "network-error" | "aborted";
  readonly durationMs: number;
}
export interface CaldavDeleteProviderPorts {
  readonly accountSession: {
    open(connection: Pick<CaldavEventTarget, "connectionId" | "connectionGeneration">, signal?: AbortSignal): Promise<CaldavAccountSession>;
  };
  readonly network: { readonly allowPrivate: boolean; readonly lookupImpl: LookupAll };
  readonly http: { fetchPinned(url: URL, init: RequestInit, address: LookupAddress): Promise<Response> };
  readonly clock: { nowEpochMs(): number; nowMonotonicMs(): number };
  /** Exactly once per actual native HTTP hop; no resource, account, UID or credential labels. */
  readonly telemetry: { record(metric: CaldavRequestMetric): void };
  readonly beforeMutation: (request: CaldavPersonalDelete, signal?: AbortSignal) => Promise<void>;
}
/** Complete UTF-8 native calendar data at the admitted request address. Existing
 * transport aliases are not adopted as a new stored resource identity. */
export interface CaldavNativeResource {
  readonly resourceUrl: string;
  readonly uid: string;
  readonly data: string;
}
export type CaldavNativeDeleteAbsence = { readonly kind: "absent"; readonly status: 404 };
export type CaldavNativeDeleteReadEvidence =
  | { readonly kind: "present"; readonly resource: CaldavNativeResource; readonly etag: string | null }
  | CaldavNativeDeleteAbsence;
/** Unlike initial/recovery GET, generic preflight 404 is an error and cannot ACK. */
export type CaldavNativeDeletePreflight = {
  readonly kind: "allowed";
  readonly resource: CaldavNativeResource;
  readonly etag: string;
};
/** Native acceptance only, independently of scoped absence and host settlement. */
export type CaldavNativeDeleteEvidence = { readonly kind: "deleted"; readonly status: 200 | 201 | 204 | 404 };
export type CaldavProviderErrorCode =
  | "provider-conflict" | "provider-version-unavailable" | "event-diff-unavailable"
  | "provider-write-failed" | "account-session-changed" | "capability-evidence";
export class CaldavProviderError extends Error {
  constructor(
    readonly code: CaldavProviderErrorCode,
    readonly outcome: "not-written" | "unconfirmed" = "not-written",
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
    readonly capability?: "event-write" | "organizer" | "recurrence",
    readonly evidence?: "denied" | "unknown" | "unsupported",
  ) {
    super(`CalDAV event delivery: ${code}.`);
    this.name = "CaldavProviderError";
  }
}
