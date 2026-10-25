export { createGoogleTaskUpdateProvider } from "./task-update";
import { strongGoogleEtag } from "./etag";
export { strongGoogleEtag } from "./etag";
export * from "./task-types";
export { parseGoogleTaskProjection, parseGoogleTaskPatch, googleTaskProjectionFromNative, diffGoogleTaskProjection, sameGoogleTaskProjection, achievesGoogleTaskPatch, isStrictGoogleNativeTask } from "./task-projection";
import { GoogleProviderError } from "./types";
import type {
  GoogleAccountSession, GoogleEventTarget, GoogleNativeAttendee, GoogleNativeEndpoint,
  GoogleNativeEvent, GoogleNativePerson, GoogleNativeReadEvidence,
  GoogleNativeUpdateEvidence, GooglePersonalContentBody, GooglePersonalUpdate,
  GoogleProviderPorts, GoogleDeleteProviderPorts, GoogleNativeDeleteReadEvidence, GoogleNativeDeleteEvidence,
  GoogleNativeDeletePreflight, GooglePersonalDelete,
  GoogleCreateProviderPorts, GooglePersonalCreate, GooglePersonalCreateBody,
  GoogleNativeCreateEvidence, GoogleNativeCreateReadEvidence,
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

function deleteInput(input: GooglePersonalDelete): GooglePersonalDelete {
  const item = record(input), serializer = record(item.serializer);
  if (serializer.id !== "google-personal-event" || serializer.version !== 1)
    throw new GoogleProviderError("event-diff-unavailable");
  return Object.freeze({ target: target(item.target as GoogleEventTarget), acceptedEtag: acceptedEtag(item.acceptedEtag),
    operationId: identity(item.operationId), attemptId: identity(item.attemptId),
    serializer: Object.freeze({ id: "google-personal-event" as const, version: 1 as const }) });
}
/** Native deletion ports are distinct from UPDATE: absence has no validator,
 * projection, acceptance or authority beyond this exact scoped observation. */
export function createGooglePersonalEventDeleteProvider(ports: GoogleDeleteProviderPorts) {
  const eventURL = (scope: GoogleEventTarget) =>
    `${GOOGLE_CALENDAR_ORIGIN}/calendars/${encodeURIComponent(scope.calendarId)}/events/${encodeURIComponent(scope.eventId)}`;
  async function session(scope: GoogleEventTarget, signal?: AbortSignal): Promise<GoogleAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted();
    if (current.connectionId !== scope.connectionId || current.connectionGeneration !== scope.connectionGeneration)
      throw new GoogleProviderError("account-session-changed");
    if (typeof current.accessToken !== "string" || !current.accessToken) throw failed();
    return current;
  }
  async function request(url: string, method: "GET" | "DELETE", current: GoogleAccountSession, signal?: AbortSignal, etag?: string): Promise<Response> {
    signal?.throwIfAborted();
    const started = ports.clock.nowMonotonicMs();
    let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(url, { method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${current.accessToken}`, ...(method === "GET" ? { "Cache-Control": "no-cache" } : { "If-Match": etag! }) } });
      status = response.status;
      // A host transport must not silently convert exact reads or conditional
      // mutations into redirected or differently scoped resources.
      if (response.redirected || response.url && response.url !== url)
        throw new GoogleProviderError("provider-write-failed", method === "DELETE" ? "unconfirmed" : "not-written", response.status);
      signal?.throwIfAborted();
      return response;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) status = "aborted";
      if (error instanceof GoogleProviderError) throw error;
      throw new GoogleProviderError("provider-write-failed", method === "DELETE" ? "unconfirmed" : "not-written");
    } finally {
      const durationMs = Math.max(0, ports.clock.nowMonotonicMs() - started);
      try { ports.telemetry.record({ provider: "google", family: "event", method, status, durationMs }); } catch { /* Diagnostics have no authority. */ }
    }
  }
  function completeRead(response: Response) {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new GoogleProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new GoogleProviderError("capability-evidence", "not-written", response.status, undefined, "event-write",
        response.status === 401 || response.status === 403 ? "denied" : "unknown");
    }
    if (response.status !== 200 || response.headers.has("content-range"))
      throw new GoogleProviderError("provider-write-failed", "not-written", response.status);
  }
  async function json(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { throw new GoogleProviderError("provider-write-failed", "not-written", response.status); }
  }
  async function read(scope: GoogleEventTarget, current: GoogleAccountSession, signal?: AbortSignal): Promise<GoogleNativeDeleteReadEvidence> {
    const response = await request(eventURL(scope), "GET", current, signal);
    if (response.status === 404 || response.status === 410) return { kind: "absent", status: response.status };
    completeRead(response);
    const value = record(await json(response));
    signal?.throwIfAborted();
    if (value.id !== scope.eventId) throw new GoogleProviderError("provider-conflict");
    if (value.status === "cancelled") return { kind: "cancelled" };
    const event = nativeEvent(value.etag === null ? { ...value, etag: undefined } : value, scope.eventId);
    return { kind: "present", event, etag: strongGoogleEtag(value.etag) };
  }
  return {
    async readForDelete(input: GoogleEventTarget, signal?: AbortSignal): Promise<GoogleNativeDeleteReadEvidence> {
      const scope = target(input), current = await session(scope, signal);
      return read(scope, current, signal);
    },
    async preflightDelete(input: GooglePersonalDelete, signal?: AbortSignal): Promise<GoogleNativeDeletePreflight> {
      const accepted = deleteInput(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed, "event-write");
      const calendarResponse = await request(`${GOOGLE_CALENDAR_ORIGIN}/users/me/calendarList/${encodeURIComponent(accepted.target.calendarId)}`, "GET", current, signal);
      completeRead(calendarResponse);
      const calendar = record(await json(calendarResponse));
      signal?.throwIfAborted();
      if (calendar.id !== accepted.target.calendarId) throw new GoogleProviderError("provider-conflict");
      capability(typeof calendar.accessRole === "string" ? ["owner", "writer"].includes(calendar.accessRole) : undefined, "event-write");
      const observed = await read(accepted.target, current, signal);
      if (observed.kind !== "present") return observed;
      if (observed.etag === null || observed.etag !== accepted.acceptedEtag) throw new GoogleProviderError("provider-conflict");
      const event = observed.event;
      // The explicit organizer action owns guest notification. Removing an
      // attendee's own copy is permitted by the existing native DELETE guard.
      const email = event.organizer?.email;
      const self = typeof event.organizer?.self === "boolean" ? event.organizer.self : email ? false : undefined;
      if (self === true && event.attendees?.some(guest => !guest.self && !guest.organizer)) unsupported("organizer");
      capability(self === undefined ? undefined : true, "organizer");
      return { kind: "allowed", event, etag: observed.etag };
    },
    async delete(input: GooglePersonalDelete, signal?: AbortSignal): Promise<GoogleNativeDeleteEvidence> {
      const accepted = deleteInput(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed, "event-write");
      await ports.beforeMutation(accepted, signal);
      signal?.throwIfAborted();
      const response = await request(eventURL(accepted.target), "DELETE", current, signal, accepted.acceptedEtag);
      if ([200, 201, 204, 404, 410].includes(response.status))
        return { kind: "deleted", status: response.status as GoogleNativeDeleteEvidence["status"] };
      if (response.status === 412) throw new GoogleProviderError("provider-conflict", "not-written", response.status);
      if (response.status === 401 || response.status === 403 || response.status === 429)
        throw new GoogleProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new GoogleProviderError("provider-write-failed", "unconfirmed", response.status, retryAfter(response, ports.clock.nowEpochMs()));
    },
  };
}

function createRecord(value: unknown, allowed: readonly string[], required: readonly string[] = allowed) {
  const item = record(value);
  if (Reflect.ownKeys(item).some(key => !allowed.includes(key as string) || !Object.getOwnPropertyDescriptor(item, key)?.enumerable) ||
      required.some(key => !Object.prototype.hasOwnProperty.call(item, key))) throw new GoogleProviderError("event-diff-unavailable");
  return item;
}
function createInput(input: GooglePersonalCreate): GooglePersonalCreate {
  const item = createRecord(input, ["target", "body", "operationId", "attemptId", "serializer"]);
  const serializer = createRecord(item.serializer, ["id", "version"]);
  if (serializer.id !== "google-personal-event" || serializer.version !== 1)
    throw new GoogleProviderError("event-diff-unavailable");
  const operationId = identity(item.operationId), attemptId = identity(item.attemptId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId))
    throw new GoogleProviderError("event-diff-unavailable");
  const scope = target(createRecord(item.target, ["connectionId", "connectionGeneration", "calendarId", "eventId"]) as unknown as GoogleEventTarget);
  const value = createRecord(item.body, ["id", "summary", "description", "location", "recurrence", "start", "end", "extendedProperties"],
    ["id", "summary", "recurrence", "start", "end", "extendedProperties"]);
  const properties = createRecord(value.extendedProperties, ["private"]), marker = createRecord(properties.private, ["musubiOperationID"]);
  if (value.id !== `musubi${operationId.replace(/-/g, "")}` || scope.eventId !== value.id || marker.musubiOperationID !== operationId || value.recurrence !== null)
    throw new GoogleProviderError("event-diff-unavailable");
  const start = endpoint(createRecord(value.start, ["dateTime"])), end = endpoint(createRecord(value.end, ["dateTime"]));
  if (Date.parse(start.dateTime!) > Date.parse(end.dateTime!)) throw new GoogleProviderError("event-diff-unavailable");
  const content: { summary: string; description?: string | null; location?: string | null } = { summary: text(value.summary) };
  for (const key of ["description", "location"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key)) content[key] = value[key] === null ? null : text(value[key]);
  }
  if ([content.summary, content.description, content.location].reduce<number>((sum, part) => sum + (part?.length ?? 0), 0) > MAX_STRING)
    throw new GoogleProviderError("event-diff-unavailable");
  // Preserve the saved JSON property order as well as its exact values. Only
  // nested containers are replaced with owned immutable snapshots.
  const body = Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === "start" ? Object.freeze({ dateTime: start.dateTime! }) :
    key === "end" ? Object.freeze({ dateTime: end.dateTime! }) :
    key === "extendedProperties" ? Object.freeze({ private: Object.freeze({ musubiOperationID: operationId }) }) : entry,
  ]))) as unknown as GooglePersonalCreateBody;
  return Object.freeze({ target: scope, body, operationId, attemptId,
    serializer: Object.freeze({ id: "google-personal-event" as const, version: 1 as const }) });
}

/** Action-specific creation transport. Recovery observes one owned native ID;
 * the host alone decides whether matching content may be adopted or 404 retried. */
export function createGooglePersonalEventCreateProvider(ports: GoogleCreateProviderPorts) {
  const eventURL = (scope: GoogleEventTarget) =>
    `${GOOGLE_CALENDAR_ORIGIN}/calendars/${encodeURIComponent(scope.calendarId)}/events/${encodeURIComponent(scope.eventId)}`;
  async function session(scope: GoogleEventTarget, signal?: AbortSignal): Promise<GoogleAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted();
    if (current.connectionId !== scope.connectionId || current.connectionGeneration !== scope.connectionGeneration)
      throw new GoogleProviderError("account-session-changed");
    if (typeof current.accessToken !== "string" || !current.accessToken) throw failed();
    return { connectionId: current.connectionId, connectionGeneration: current.connectionGeneration,
      accessToken: current.accessToken, eventWriteAllowed: current.eventWriteAllowed };
  }
  async function request(url: string, method: "GET" | "POST", current: GoogleAccountSession, signal?: AbortSignal, body?: GooglePersonalCreateBody): Promise<Response> {
    signal?.throwIfAborted();
    const started = ports.clock.nowMonotonicMs();
    let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(url, { method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${current.accessToken}`, ...(method === "GET" ? { "Cache-Control": "no-cache" } : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      status = response.status;
      if (response.redirected || response.url && response.url !== url)
        throw new GoogleProviderError("provider-write-failed", method === "POST" ? "unconfirmed" : "not-written", response.status);
      signal?.throwIfAborted();
      return response;
    } catch (error) {
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") status = "aborted";
      if (error instanceof GoogleProviderError) throw error;
      throw new GoogleProviderError("provider-write-failed", method === "POST" ? "unconfirmed" : "not-written");
    } finally {
      try { ports.telemetry.record({ provider: "google", family: "event", method, status,
        durationMs: Math.max(0, ports.clock.nowMonotonicMs() - started) }); } catch { /* Diagnostics have no authority. */ }
    }
  }
  function completeRead(response: Response) {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new GoogleProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new GoogleProviderError("capability-evidence", "not-written", response.status, undefined, "event-write",
        response.status === 401 || response.status === 403 ? "denied" : "unknown");
    }
    if (response.status !== 200 || response.headers.has("content-range"))
      throw new GoogleProviderError("provider-write-failed", "not-written", response.status);
  }
  async function json(response: Response, outcome: "not-written" | "unconfirmed", signal?: AbortSignal) {
    try { const value = record(await response.json()); signal?.throwIfAborted(); return value; }
    catch { throw new GoogleProviderError("provider-write-failed", outcome, response.status); }
  }
  return {
    async preflightCreate(input: GooglePersonalCreate, signal?: AbortSignal): Promise<{ kind: "allowed" }> {
      const accepted = createInput(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed, "event-write");
      const response = await request(`${GOOGLE_CALENDAR_ORIGIN}/users/me/calendarList/${encodeURIComponent(accepted.target.calendarId)}`, "GET", current, signal);
      completeRead(response);
      const calendar = await json(response, "not-written", signal);
      if (calendar.id !== accepted.target.calendarId) throw new GoogleProviderError("provider-conflict");
      capability(typeof calendar.accessRole === "string" ? ["owner", "writer"].includes(calendar.accessRole) : undefined, "event-write");
      return { kind: "allowed" };
    },
    async create(input: GooglePersonalCreate, signal?: AbortSignal): Promise<GoogleNativeCreateEvidence> {
      const accepted = createInput(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed, "event-write");
      await ports.beforeMutation(accepted, signal);
      signal?.throwIfAborted();
      const response = await request(`${GOOGLE_CALENDAR_ORIGIN}/calendars/${encodeURIComponent(accepted.target.calendarId)}/events`, "POST", current, signal, accepted.body);
      if (![200, 201, 204].includes(response.status))
        throw new GoogleProviderError(response.status === 412 ? "provider-conflict" : "provider-write-failed",
          response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      if (response.headers.has("content-range")) throw new GoogleProviderError("provider-write-failed", "unconfirmed", response.status);
      const value = await json(response, "unconfirmed", signal);
      if (value.id !== accepted.target.eventId) throw new GoogleProviderError("provider-write-failed", "unconfirmed", response.status);
      return { kind: "created", eventId: accepted.target.eventId, etag: strongGoogleEtag(value.etag) };
    },
    async readCreated(input: GooglePersonalCreate, signal?: AbortSignal): Promise<GoogleNativeCreateReadEvidence> {
      const accepted = createInput(input), current = await session(accepted.target, signal);
      const response = await request(eventURL(accepted.target), "GET", current, signal);
      if (response.status === 404) return { kind: "absent", status: 404 };
      if (response.status === 410) throw new GoogleProviderError("provider-conflict");
      completeRead(response);
      const value = await json(response, "not-written", signal);
      let marker: unknown;
      try { marker = record(record(value.extendedProperties).private).musubiOperationID; }
      catch { throw new GoogleProviderError("provider-conflict"); }
      if (value.id !== accepted.target.eventId || value.status === "cancelled" || marker !== accepted.operationId)
        throw new GoogleProviderError("provider-conflict");
      const event = nativeEvent(value.etag === null ? { ...value, etag: undefined } : value, accepted.target.eventId);
      return { kind: "present", event, etag: strongGoogleEtag(value.etag) };
    },
  };
}
