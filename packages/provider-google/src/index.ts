import { GoogleProviderError } from "./types";
import type {
  GoogleAccountSession, GoogleEventTarget, GoogleNativeAttendee, GoogleNativeEndpoint,
  GoogleNativeEvent, GoogleNativePerson, GoogleNativeReadEvidence,
  GoogleNativeUpdateEvidence, GooglePersonalContentBody, GooglePersonalUpdate,
  GoogleProviderPorts,
} from "./types";
export * from "./types";

const GOOGLE_CALENDAR_ORIGIN = "https://www.googleapis.com/calendar/v3";
const MAX_STRING = 2_000_000;
const MAX_IDENTITY = 2048;
const MAX_LIST = 10_000;
const failed = () => new GoogleProviderError("provider-write-failed");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failed();
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"))) throw failed();
  return value as Record<string, unknown>;
};
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_STRING) throw failed();
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_IDENTITY) throw failed();
  return value;
}
function optionalText(item: Record<string, unknown>, key: string): string | undefined {
  return item[key] === undefined ? undefined : text(item[key]);
}
function optionalBoolean(item: Record<string, unknown>, key: string): boolean | undefined {
  const value = item[key];
  if (value !== undefined && typeof value !== "boolean") throw failed();
  return value as boolean | undefined;
}
function optionalContent(item: Record<string, unknown>, key: string): string | null | undefined {
  return item[key] == null ? item[key] as null | undefined : text(item[key]);
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) throw failed();
  return value;
}

/** RFC 9110 strong entity-tag comparison, without repairing a native value. */
export function strongGoogleEtag(value: unknown): string | null {
  return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : null;
}
function acceptedEtag(value: unknown): string {
  const tag = strongGoogleEtag(value);
  if (tag === null) throw new GoogleProviderError("provider-version-unavailable");
  return tag;
}
function capability(allowed: boolean | undefined, subject: "event-write" | "organizer") {
  if (allowed !== true) throw new GoogleProviderError("capability-evidence", "not-written", undefined, undefined, subject, allowed === false ? "denied" : "unknown");
}
function unsupported(subject: "event-write" | "organizer"): never {
  throw new GoogleProviderError("capability-evidence", "not-written", undefined, undefined, subject, "unsupported");
}

function endpoint(value: unknown): GoogleNativeEndpoint {
  const item = record(value);
  const date = optionalText(item, "date"), dateTime = optionalText(item, "dateTime"), timeZone = optionalText(item, "timeZone");
  if ((date === undefined) === (dateTime === undefined)) throw failed();
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(Date.parse(date)).toISOString().slice(0, 10) !== date)) throw failed();
  if (dateTime !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime) || !Number.isFinite(Date.parse(dateTime)))) throw failed();
  if (dateTime !== undefined) {
    const day = dateTime.slice(0, 10), wall = dateTime.slice(11, 19).split(":").map(Number);
    const offset = dateTime.match(/[+-](\d{2}):(\d{2})$/);
    if (new Date(Date.parse(day)).toISOString().slice(0, 10) !== day || wall[0]! > 23 || wall[1]! > 59 || wall[2]! > 59 || (offset && (+offset[1]! > 23 || +offset[2]! > 59))) throw failed();
  }
  return { ...(date === undefined ? {} : { date }), ...(dateTime === undefined ? {} : { dateTime }), ...(timeZone === undefined ? {} : { timeZone }) };
}
function person(value: unknown): GoogleNativePerson {
  const item = record(value);
  return { email: optionalText(item, "email"), displayName: optionalText(item, "displayName"), self: optionalBoolean(item, "self") };
}
function attendee(value: unknown): GoogleNativeAttendee {
  const item = record(value);
  return { ...person(item), organizer: optionalBoolean(item, "organizer"), optional: optionalBoolean(item, "optional"), resource: optionalBoolean(item, "resource"), responseStatus: optionalText(item, "responseStatus") };
}
function nativeEvent(value: unknown, expectedId: string): GoogleNativeEvent {
  const item = record(value);
  if (item.id !== expectedId) throw new GoogleProviderError("provider-conflict");
  const start = endpoint(item.start), end = endpoint(item.end);
  if ((start.date === undefined) !== (end.date === undefined)) throw failed();
  const startMs = Date.parse(start.date ?? start.dateTime!), endMs = Date.parse(end.date ?? end.dateTime!);
  if (endMs < startMs || (start.date !== undefined && endMs === startMs)) throw failed();
  const event: GoogleNativeEvent = {
    id: expectedId, start, end,
    etag: optionalText(item, "etag"), status: optionalText(item, "status"),
    summary: optionalContent(item, "summary"), description: optionalContent(item, "description"), location: optionalContent(item, "location"),
    organizer: item.organizer == null ? undefined : person(item.organizer),
    attendees: item.attendees === undefined ? undefined : list(item.attendees).map(attendee),
    attendeesOmitted: optionalBoolean(item, "attendeesOmitted"),
    recurrence: item.recurrence == null ? undefined : list(item.recurrence).map(text),
    recurringEventId: optionalText(item, "recurringEventId"),
    originalStartTime: item.originalStartTime === undefined ? undefined : endpoint(item.originalStartTime),
    iCalUID: optionalText(item, "iCalUID"), htmlLink: optionalText(item, "htmlLink"), eventType: optionalText(item, "eventType"),
    transparency: optionalText(item, "transparency"), visibility: optionalText(item, "visibility"), hangoutLink: optionalText(item, "hangoutLink"),
    source: item.source == null ? undefined : { url: optionalText(record(item.source), "url") },
  };
  const extras: { extendedProperties?: GoogleNativeEvent["extendedProperties"]; reminders?: GoogleNativeEvent["reminders"]; conferenceData?: GoogleNativeEvent["conferenceData"] } = {};
  if (item.extendedProperties != null) {
    const values = record(item.extendedProperties).private;
    if (values != null) {
      const properties = Object.entries(record(values));
      if (properties.length > MAX_LIST) throw failed();
      extras.extendedProperties = { private: Object.fromEntries(properties.map(([key, v]) => [text(key), text(v)])) };
    }
  }
  if (item.reminders != null) {
    const reminders = record(item.reminders);
    extras.reminders = { useDefault: optionalBoolean(reminders, "useDefault"), overrides: reminders.overrides == null ? undefined : list(reminders.overrides).map(value => {
      const entry = record(value), minutes = entry.minutes;
      if (minutes !== undefined && (typeof minutes !== "number" || !Number.isSafeInteger(minutes))) throw failed();
      return { method: optionalText(entry, "method"), minutes: minutes as number | undefined };
    }) };
  }
  if (item.conferenceData != null) {
    const conference = record(item.conferenceData);
    extras.conferenceData = { entryPoints: conference.entryPoints == null ? undefined : list(conference.entryPoints).map(value => ({ uri: optionalText(record(value), "uri") })) };
  }
  return { ...event, ...extras };
}

function target(input: GoogleEventTarget): GoogleEventTarget {
  const item = record(input);
  return Object.freeze({ connectionId: identity(item.connectionId), connectionGeneration: identity(item.connectionGeneration), calendarId: identity(item.calendarId), eventId: identity(item.eventId) });
}
function updateInput(input: GooglePersonalUpdate): GooglePersonalUpdate {
  const item = record(input), serializer = record(item.serializer), value = record(item.body);
  identity(item.operationId); identity(item.attemptId);
  if (serializer.id !== "google-personal-event" || serializer.version !== 1) throw new GoogleProviderError("event-diff-unavailable");
  const body: Record<string, string | null> = {};
  let total = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!["summary", "description", "location"].includes(key) ||
        (typeof entry !== "string" && !(key !== "summary" && entry === null))) throw new GoogleProviderError("event-diff-unavailable");
    if (typeof entry === "string") { total += entry.length; if (total > MAX_STRING) throw new GoogleProviderError("event-diff-unavailable"); }
    body[key] = entry as string | null;
  }
  return Object.freeze({ target: target(input.target), acceptedEtag: acceptedEtag(input.acceptedEtag), body: Object.freeze(body) as GooglePersonalContentBody,
    operationId: input.operationId, attemptId: input.attemptId, serializer: Object.freeze({ id: "google-personal-event" as const, version: 1 as const }) });
}
function retryAfter(response: Response, epochMs: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - epochMs;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

export function createGooglePersonalEventProvider(ports: GoogleProviderPorts) {
  async function session(scope: GoogleEventTarget, signal?: AbortSignal): Promise<GoogleAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted();
    if (current.connectionId !== scope.connectionId || current.connectionGeneration !== scope.connectionGeneration) throw new GoogleProviderError("account-session-changed");
    if (typeof current.accessToken !== "string" || !current.accessToken) throw failed();
    return current;
  }
  async function request(url: string, method: "GET" | "PATCH", current: GoogleAccountSession, signal?: AbortSignal, body?: GooglePersonalContentBody, etag?: string): Promise<Response> {
    signal?.throwIfAborted();
    const started = ports.clock.nowMonotonicMs();
    let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(url, { method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${current.accessToken}`, ...(method === "GET" ? { "Cache-Control": "no-cache" } : { "Content-Type": "application/json", "If-Match": etag! }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = response.status;
      return response;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) status = "aborted";
      throw new GoogleProviderError("provider-write-failed", method === "PATCH" ? "unconfirmed" : "not-written");
    } finally {
      const durationMs = Math.max(0, ports.clock.nowMonotonicMs() - started);
      try { ports.telemetry.record({ provider: "google", family: "event", method, status, durationMs }); } catch { /* Diagnostics never authorize or revoke a write. */ }
    }
  }
  function eventURL(scope: GoogleEventTarget) {
    return `${GOOGLE_CALENDAR_ORIGIN}/calendars/${encodeURIComponent(scope.calendarId)}/events/${encodeURIComponent(scope.eventId)}`;
  }
  function readResponse(response: Response) {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500) throw new GoogleProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new GoogleProviderError("capability-evidence", "not-written", response.status, undefined, "event-write", response.status === 401 || response.status === 403 ? "denied" : "unknown");
    }
    if (response.status !== 200 || response.headers.has("content-range")) throw new GoogleProviderError("provider-write-failed", "not-written", response.status);
  }
  async function json(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { throw new GoogleProviderError("provider-write-failed", "not-written", response.status); }
  }
  return {
    async preflightUpdate(input: GooglePersonalUpdate, signal?: AbortSignal) {
      const accepted = updateInput(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed, "event-write");
      const calendarResponse = await request(`${GOOGLE_CALENDAR_ORIGIN}/users/me/calendarList/${encodeURIComponent(accepted.target.calendarId)}`, "GET", current, signal);
      readResponse(calendarResponse);
      const calendar = record(await json(calendarResponse));
      if (calendar.id !== accepted.target.calendarId) throw new GoogleProviderError("provider-conflict");
      capability(typeof calendar.accessRole === "string" ? ["owner", "writer"].includes(calendar.accessRole) : undefined, "event-write");
      const response = await request(eventURL(accepted.target), "GET", current, signal);
      readResponse(response);
      const value = record(await json(response));
      if (value.id !== accepted.target.eventId || value.status === "cancelled") throw new GoogleProviderError("provider-conflict");
      if (accepted.acceptedEtag !== acceptedEtag(value.etag)) throw new GoogleProviderError("provider-conflict");
      const event = nativeEvent(value, accepted.target.eventId);
      if (event.recurringEventId || event.originalStartTime || event.recurrence?.length) unsupported("event-write");
      const self = typeof event.organizer?.self === "boolean" ? event.organizer.self : event.organizer?.email ? false : undefined;
      capability(self, "organizer");
      if (event.attendeesOmitted === true || event.attendees?.some(guest => !guest.self && !guest.organizer)) unsupported("organizer");
      return { kind: "allowed" as const, event, etag: accepted.acceptedEtag };
    },
    async readEvent(input: GoogleEventTarget, signal?: AbortSignal): Promise<GoogleNativeReadEvidence> {
      const scope = target(input), current = await session(scope, signal);
      const response = await request(eventURL(scope), "GET", current, signal);
      if (response.status === 404 || response.status === 410) return { kind: "absent", status: response.status };
      readResponse(response);
      const value = record(await json(response));
      if (value.id !== scope.eventId) throw new GoogleProviderError("provider-conflict");
      if (value.status === "cancelled") return { kind: "cancelled" };
      const event = nativeEvent(value, scope.eventId);
      return { kind: "present", event, etag: acceptedEtag(event.etag) };
    },
    async update(input: GooglePersonalUpdate, signal?: AbortSignal): Promise<GoogleNativeUpdateEvidence> {
      const accepted = updateInput(input);
      if (Object.keys(accepted.body).length === 0) return { kind: "not-written", reason: "empty-body" };
      const current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed, "event-write");
      await ports.beforeMutation(accepted, signal);
      signal?.throwIfAborted();
      const response = await request(eventURL(accepted.target), "PATCH", current, signal, accepted.body, accepted.acceptedEtag);
      if (![200, 201, 204].includes(response.status)) throw new GoogleProviderError(response.status === 412 ? "provider-conflict" : "provider-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      // Native acceptance without a usable validator cannot be upgraded by a later read.
      const value = await response.json().catch(() => null);
      if (value && typeof value === "object" && "id" in value && value.id !== accepted.target.eventId) throw new GoogleProviderError("provider-write-failed", "unconfirmed", response.status);
      return { kind: "written", etag: strongGoogleEtag(value && typeof value === "object" ? (value as Record<string, unknown>).etag : null) };
    },
  };
}
