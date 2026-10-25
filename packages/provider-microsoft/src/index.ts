import { z } from "zod";
import { MicrosoftProviderError } from "./types";
import type {
  MicrosoftAccountSession, MicrosoftDeleteProviderPorts, MicrosoftEventTarget, MicrosoftNativeDeleteEvidence,
  MicrosoftNativeDeletePreflight, MicrosoftNativeDeleteReadEvidence, MicrosoftNativeEvent, MicrosoftPersonalDelete,
} from "./types";
export * from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SMALL_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';
const DELIVERY_PREFER = `${SMALL_PREFER}, odata.maxpagesize=100`;
const MAX_IDENTITY = 2048;
const failed = () => new MicrosoftProviderError("provider-write-failed");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failed();
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"))) throw failed();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = record(value);
  if (Reflect.ownKeys(item).length !== keys.length || keys.some(key => !Object.getOwnPropertyDescriptor(item, key)?.enumerable))
    throw new MicrosoftProviderError("event-diff-unavailable");
  return item;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_IDENTITY || value.trim() !== value || [".", ".."].includes(value))
    throw new MicrosoftProviderError("provider-conflict");
  return value;
}
/** Native weak ETag comparison only. This does not certify DELETE If-Match enforcement. */
export function nativeMicrosoftEtag(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_IDENTITY && /^W\/"[\x21\x23-\x7e\x80-\xff]+"$/.test(value) ? value : null;
}
function requireEtag(value: unknown): string {
  const etag = nativeMicrosoftEtag(value);
  if (etag === null) throw new MicrosoftProviderError("provider-version-unavailable");
  return etag;
}
function target(value: unknown): MicrosoftEventTarget {
  const item = exact(value, ["connectionId", "connectionGeneration", "calendarId", "eventId"]);
  return Object.freeze({ connectionId: identity(item.connectionId), connectionGeneration: identity(item.connectionGeneration),
    calendarId: identity(item.calendarId), eventId: identity(item.eventId) });
}
function deletion(value: unknown): MicrosoftPersonalDelete {
  const item = exact(value, ["target", "acceptedEtag", "operationId", "attemptId", "serializer"]);
  const serializer = exact(item.serializer, ["id", "version"]);
  if (serializer.id !== "microsoft-personal-event" || serializer.version !== 1) throw new MicrosoftProviderError("event-diff-unavailable");
  return Object.freeze({ target: target(item.target), acceptedEtag: requireEtag(item.acceptedEtag),
    operationId: identity(item.operationId), attemptId: identity(item.attemptId),
    serializer: Object.freeze({ id: "microsoft-personal-event" as const, version: 1 as const }) });
}
function capability(allowed: boolean | undefined) {
  if (allowed !== true) throw new MicrosoftProviderError("capability-evidence", "not-written", undefined, undefined, "event-write", allowed === false ? "denied" : "unknown");
}
function unsupported(): never {
  throw new MicrosoftProviderError("capability-evidence", "not-written", undefined, undefined, "event-write", "unsupported");
}
/** Own every retained native value; never invoke accessors/toJSON or retain mutable port objects. */
function nativeSnapshot(value: unknown): unknown {
  let nodes = 0, units = 0;
  const active = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 10_000 || depth > 32) throw failed();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") { units += value.length; if (units > 2_000_000) throw failed(); return value; }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || value === null || active.has(value)) throw failed();
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        if (![Array.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(descriptors).length !== value.length + 1) throw failed();
        return Object.freeze(Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw failed();
          return copy(descriptor.value, depth + 1);
        }));
      }
      record(value);
      return Object.freeze(Object.fromEntries(Reflect.ownKeys(descriptors).map(key => {
        const descriptor = descriptors[key as string]!;
        if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) throw failed();
        units += key.length; if (units > 2_000_000) throw failed();
        return [key, copy(descriptor.value, depth + 1)];
      })));
    } finally { active.delete(value); }
  }
  return copy(value, 0);
}
/** Match the host's existing Graph date parser, including Graph's seven-digit fractions and UTC default. */
function nativeDate(value: unknown): number {
  const endpoint = record(value), dateTime = endpoint.dateTime;
  if (typeof dateTime !== "string") throw failed();
  if (endpoint.timeZone !== undefined && typeof endpoint.timeZone !== "string") throw failed();
  const normalized = dateTime.replace(/(\.\d{3})\d*/, "$1");
  const milliseconds = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  if (!Number.isFinite(milliseconds)) throw failed();
  return milliseconds;
}
function event(value: unknown, expectedId: string): MicrosoftNativeEvent {
  const item = record(nativeSnapshot(value));
  if (item.id !== expectedId) throw new MicrosoftProviderError("provider-conflict");
  nativeDate(item.start); nativeDate(item.end);
  // The normalizer subtracts one day from all-day end. Retain its valid-date floor as well.
  if (item.isAllDay && !Number.isFinite(new Date(nativeDate(item.end) - 86_400_000).getTime())) throw failed();
  return item as MicrosoftNativeEvent;
}
function timedEndpoint(value: unknown): boolean {
  const item = record(value), raw = item.dateTime;
  if (item.timeZone !== "UTC" || typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z?$/.test(raw)) return false;
  const normalized = new Date(nativeDate(item)).toISOString();
  return normalized.slice(0, 19) === raw.slice(0, 19);
}
function personal(current: MicrosoftNativeEvent) {
  if (current.type !== "singleInstance" || current.isCancelled !== false || current.isOrganizer !== true || current.isDraft !== false ||
      current.recurrence !== null || current.seriesMasterId != null || !Array.isArray(current.attendees) || current.attendees.length !== 0 ||
      current.isOnlineMeeting !== false || current.onlineMeeting != null || current.onlineMeetingUrl != null || current["@removed"] ||
      current["@odata.nextLink"] || current["attendees@odata.nextLink"] || current.isAllDay !== false ||
      !timedEndpoint(current.start) || !timedEndpoint(current.end) || nativeDate(current.start) > nativeDate(current.end)) unsupported();
}
function retryAfter(response: Response, epochMs: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - epochMs;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
/** This package supplies native facts only. The runtime owns guarded dispatch,
 * persistence of acceptance and mandatory exact-404 readback before host ACK. */
export function createMicrosoftPersonalEventDeleteProvider(ports: MicrosoftDeleteProviderPorts) {
  const eventURL = (scope: MicrosoftEventTarget) => `${GRAPH}/me/calendars/${encodeURIComponent(scope.calendarId)}/events/${encodeURIComponent(scope.eventId)}`;
  async function session(scope: MicrosoftEventTarget, signal?: AbortSignal): Promise<MicrosoftAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted();
    if (current.connectionId !== scope.connectionId || current.connectionGeneration !== scope.connectionGeneration)
      throw new MicrosoftProviderError("account-session-changed");
    if (typeof current.accessToken !== "string" || !current.accessToken) throw failed();
    return Object.freeze({ connectionId: current.connectionId, connectionGeneration: current.connectionGeneration,
      accessToken: current.accessToken, eventWriteAllowed: current.eventWriteAllowed });
  }
  async function request(url: string, method: "GET" | "DELETE", current: MicrosoftAccountSession, signal?: AbortSignal,
    prefer = SMALL_PREFER, etag?: string): Promise<Response> {
    signal?.throwIfAborted();
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const started = ports.clock.nowMonotonicMs();
    let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(url, { method, redirect: "error", signal: bounded,
        headers: { Authorization: `Bearer ${current.accessToken}`,
          ...(method === "GET" ? { Prefer: prefer, "Cache-Control": "no-cache" } : { "If-Match": etag! }) } });
      status = response.status;
      if (response.redirected || response.url && response.url !== url)
        throw new MicrosoftProviderError("provider-write-failed", method === "DELETE" ? "unconfirmed" : "not-written", response.status);
      bounded.throwIfAborted();
      return response;
    } catch (error) {
      if (bounded.aborted || error instanceof Error && error.name === "AbortError") status = "aborted";
      if (error instanceof MicrosoftProviderError) throw error;
      throw new MicrosoftProviderError("provider-write-failed", method === "DELETE" ? "unconfirmed" : "not-written");
    } finally {
      const durationMs = Math.max(0, ports.clock.nowMonotonicMs() - started);
      try { ports.telemetry.record({ provider: "microsoft", family: "event", method, status, durationMs }); } catch { /* Diagnostics have no authority. */ }
    }
  }
  function completeRead(response: Response) {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new MicrosoftProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new MicrosoftProviderError("capability-evidence", "not-written", response.status, undefined, "event-write",
        response.status === 401 || response.status === 403 ? "denied" : "unknown");
    }
    if (response.status !== 200 || response.headers.has("content-range")) throw new MicrosoftProviderError("provider-write-failed", "not-written", response.status);
  }
  async function json(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { throw new MicrosoftProviderError("provider-write-failed", "not-written", response.status); }
  }
  async function read(scope: MicrosoftEventTarget, current: MicrosoftAccountSession, signal?: AbortSignal,
    prefer = SMALL_PREFER): Promise<MicrosoftNativeDeleteReadEvidence> {
    const response = await request(eventURL(scope), "GET", current, signal, prefer);
    if (response.status === 404) return Object.freeze({ kind: "absent", status: 404 });
    completeRead(response);
    const native = event(await json(response), scope.eventId);
    signal?.throwIfAborted();
    return Object.freeze({ kind: "present", event: native, etag: nativeMicrosoftEtag(native["@odata.etag"]) });
  }
  return {
    async readForDelete(input: MicrosoftEventTarget, signal?: AbortSignal, mode: "delivery" | "verification" = "delivery"): Promise<MicrosoftNativeDeleteReadEvidence> {
      const scope = target(input);
      if (mode !== "delivery" && mode !== "verification") throw new MicrosoftProviderError("event-diff-unavailable");
      const current = await session(scope, signal);
      return read(scope, current, signal, mode === "delivery" ? DELIVERY_PREFER : SMALL_PREFER);
    },
    async preflightDelete(input: MicrosoftPersonalDelete, signal?: AbortSignal): Promise<MicrosoftNativeDeletePreflight> {
      const accepted = deletion(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed);
      const meResponse = await request(`${GRAPH}/me?$select=id,mail,userPrincipalName`, "GET", current, signal);
      completeRead(meResponse); const me = record(nativeSnapshot(await json(meResponse)));
      const calendarResponse = await request(`${GRAPH}/me/calendars/${encodeURIComponent(accepted.target.calendarId)}?$select=id,canEdit,owner`, "GET", current, signal);
      completeRead(calendarResponse); const calendar = record(nativeSnapshot(await json(calendarResponse)));
      signal?.throwIfAborted();
      capability(typeof calendar.canEdit === "boolean" ? calendar.canEdit : undefined);
      const self = me.mail ?? me.userPrincipalName;
      if (typeof me.id !== "string" || !me.id || !z.email().safeParse(self).success || calendar.id !== accepted.target.calendarId ||
          typeof self !== "string" || typeof calendar.owner !== "object" || calendar.owner === null ||
          typeof record(calendar.owner).address !== "string" || (record(calendar.owner).address as string).toLowerCase() !== self.toLowerCase()) unsupported();
      const observed = await read(accepted.target, current, signal);
      if (observed.kind === "absent") return observed;
      const currentEtag = requireEtag(observed.event["@odata.etag"]);
      if (currentEtag !== accepted.acceptedEtag) throw new MicrosoftProviderError("provider-conflict");
      personal(observed.event);
      return Object.freeze({ kind: "allowed", event: observed.event, etag: currentEtag });
    },
    async delete(input: MicrosoftPersonalDelete, signal?: AbortSignal): Promise<MicrosoftNativeDeleteEvidence> {
      const accepted = deletion(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed);
      await ports.beforeMutation(accepted, signal);
      signal?.throwIfAborted();
      const response = await request(eventURL(accepted.target), "DELETE", current, signal, SMALL_PREFER, accepted.acceptedEtag);
      if (response.status === 204 || response.status === 404) return Object.freeze({ kind: "deleted", status: response.status });
      throw new MicrosoftProviderError(response.status === 412 ? "provider-conflict" : "provider-write-failed",
        response.status === 408 || response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status,
        retryAfter(response, ports.clock.nowEpochMs()));
    },
  };
}
