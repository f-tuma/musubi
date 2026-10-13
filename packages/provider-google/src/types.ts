/** Native provider inputs. Connection identities are opaque host values. */
export interface GoogleEventTarget {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly calendarId: string;
  readonly eventId: string;
}

/** Only these already admitted personal content properties may be sent. */
export interface GooglePersonalContentBody {
  readonly summary?: string;
  readonly description?: string | null;
  readonly location?: string | null;
}

export interface GooglePersonalUpdate {
  readonly target: GoogleEventTarget;
  readonly acceptedEtag: string;
  readonly body: GooglePersonalContentBody;
  readonly operationId: string;
  readonly attemptId: string;
  readonly serializer: { readonly id: "google-personal-event"; readonly version: 1 };
}

export interface GoogleAccountSession {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly accessToken: string;
  /** Evidence after any host-owned token refresh. Undefined is not a grant. */
  readonly eventWriteAllowed: boolean | undefined;
}

export interface GoogleRequestMetric {
  readonly provider: "google";
  readonly family: "event";
  readonly method: "GET" | "PATCH";
  readonly status: number | "network-error" | "aborted";
  readonly durationMs: number;
}

export interface GoogleProviderPorts {
  readonly accountSession: {
    open(connection: Pick<GoogleEventTarget, "connectionId" | "connectionGeneration">, signal?: AbortSignal): Promise<GoogleAccountSession>;
  };
  readonly http: { fetch(url: string, init: RequestInit): Promise<Response> };
  readonly clock: { nowEpochMs(): number; nowMonotonicMs(): number };
  /** Diagnostic failures cannot change the provider outcome. No sensitive labels. */
  readonly telemetry: { record(metric: GoogleRequestMetric): void };
  /** Host authority/lease fence, after credentials, immediately before dispatch. */
  readonly beforeMutation: (request: GooglePersonalUpdate, signal?: AbortSignal) => Promise<void>;
}

export interface GoogleNativePerson {
  readonly email?: string;
  readonly displayName?: string;
  readonly self?: boolean;
}
export interface GoogleNativeAttendee extends GoogleNativePerson {
  readonly organizer?: boolean;
  readonly optional?: boolean;
  readonly resource?: boolean;
  readonly responseStatus?: string;
}
export interface GoogleNativeEndpoint {
  readonly date?: string;
  readonly dateTime?: string;
  readonly timeZone?: string;
}

/** Selected Google wire fields, without a product event or storage reference. */
export interface GoogleNativeEvent {
  readonly id: string;
  readonly etag?: string;
  readonly status?: string;
  readonly summary?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly start: GoogleNativeEndpoint;
  readonly end: GoogleNativeEndpoint;
  readonly organizer?: GoogleNativePerson;
  readonly attendees?: readonly GoogleNativeAttendee[];
  readonly attendeesOmitted?: boolean;
  readonly recurrence?: readonly string[];
  readonly recurringEventId?: string;
  readonly originalStartTime?: GoogleNativeEndpoint;
  readonly iCalUID?: string;
  readonly htmlLink?: string;
  readonly eventType?: string;
  readonly transparency?: string;
  readonly visibility?: string;
  readonly hangoutLink?: string;
  readonly source?: { readonly url?: string };
  readonly extendedProperties?: { readonly private?: Readonly<Record<string, string>> };
  readonly reminders?: { readonly useDefault?: boolean; readonly overrides?: readonly { readonly method?: string; readonly minutes?: number }[] };
  readonly conferenceData?: { readonly entryPoints?: readonly { readonly uri?: string }[] };
}

/** These are observations/acceptance, never a canonical commit or local ACK. */
export type GoogleNativeReadEvidence =
  | { readonly kind: "present"; readonly event: GoogleNativeEvent; readonly etag: string }
  | { readonly kind: "absent"; readonly status: 404 | 410 }
  | { readonly kind: "cancelled" };
export type GoogleNativeUpdateEvidence =
  | { readonly kind: "written"; readonly etag: string | null }
  | { readonly kind: "not-written"; readonly reason: "empty-body" };

export type GoogleProviderErrorCode =
  | "provider-conflict"
  | "provider-version-unavailable"
  | "event-diff-unavailable"
  | "provider-write-failed"
  | "account-session-changed"
  | "capability-evidence";
export class GoogleProviderError extends Error {
  constructor(
    readonly code: GoogleProviderErrorCode,
    readonly outcome: "not-written" | "unconfirmed" = "not-written",
    readonly providerStatus?: number,
    readonly retryAfterMs?: number,
    readonly capability?: "event-write" | "organizer",
    readonly evidence?: "denied" | "unknown" | "unsupported",
  ) {
    super(`Google event delivery: ${code}.`);
    this.name = "GoogleProviderError";
  }
}
