import { dispatchNativeHttp } from "./http-dispatch";
import ICAL from "ical.js";
import { createGuardedCaldavFetch } from "./network";
import { createCaldavPrivilegeReader, caldavAllows } from "./dav-privileges";
import { assertStrictCaldavPersonalResource, selectCaldavEventMaster, strictCaldavResourceURL, validateCaldavPhysicalResource } from "./native-event";
import { strongCaldavEtag } from "./native-etag";
import { CaldavProviderError } from "./types";
import type {
  CaldavAccountSession, CaldavCreateProviderOptions, CaldavCreateProviderPorts, CaldavEventTarget,
  CaldavNativeCreateEvidence, CaldavNativeCreatePreflight, CaldavNativeCreateReadEvidence, CaldavNativeCreateProjection,
  CaldavNativeResource, CaldavNativeProfile, CaldavPersonalCreate,
} from "./types";

const failed = () => new CaldavProviderError("provider-write-failed");
const invalid = () => new CaldavProviderError("event-diff-unavailable");
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
      })) throw invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw invalid();
  return value;
}
/** Same raw concatenation as the admitted v1 serializer: no URL normalization. */
export function caldavPersonalCreateIdentityV1(calendarUrl: unknown, operationId: unknown): { resourceUrl: string; uid: string } | null {
  if (typeof calendarUrl !== "string" || !calendarUrl || typeof operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) return null;
  const uid = `musubi-${operationId}`;
  return { resourceUrl: `${calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`}${uid}.ics`, uid };
}
function creation(value: unknown, profile: CaldavNativeProfile): CaldavPersonalCreate {
  const item = exact(value, ["target", "body", "operationId", "attemptId", "serializer"]);
  const target = exact(item.target, ["connectionId", "connectionGeneration", "calendarUrl", "resourceUrl", "uid"]), serializer = exact(item.serializer, ["id", "version"]);
  if (serializer.id !== "caldav-personal-event" || serializer.version !== 1 || typeof item.body !== "string" || !item.body || item.body.length > 2_000_000) throw invalid();
  if (typeof target.resourceUrl !== "string") throw invalid();
  const scope: CaldavEventTarget = Object.freeze({ connectionId: id(target.connectionId), connectionGeneration: id(target.connectionGeneration),
    calendarUrl: id(target.calendarUrl), resourceUrl: target.resourceUrl, uid: id(target.uid) });
  const identity = caldavPersonalCreateIdentityV1(scope.calendarUrl, item.operationId);
  if (!identity || identity.resourceUrl !== scope.resourceUrl || identity.uid !== scope.uid) throw new CaldavProviderError("provider-conflict");
  try {
    for (const url of [scope.calendarUrl, scope.resourceUrl]) if (!["http:", "https:"].includes(new URL(url).protocol)) throw invalid();
    if (profile === "strict-reference") strictCaldavResourceURL(scope.calendarUrl.endsWith("/") ? scope.calendarUrl : `${scope.calendarUrl}/`, scope.resourceUrl);
  } catch { throw new CaldavProviderError("provider-conflict"); }
  const selected = selectCaldavEventMaster(item.body, scope.uid); validateCaldavPhysicalResource(item.body, selected.index);
  assertStrictCaldavPersonalResource(selected);
  if (selected.master.hasProperty("organizer")) throw invalid();
  return Object.freeze({ target: scope, body: item.body, operationId: item.operationId as string, attemptId: id(item.attemptId),
    serializer: Object.freeze({ id: "caldav-personal-event" as const, version: 1 as const }) });
}
function retryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
/** Portable reference projection using ICAL's UTC or resource-owned embedded
 * timezone. Floating times and ambient global timezone registrations are not proof. */
export function normalizeCaldavCreateProjection(resource: CaldavNativeResource): CaldavNativeCreateProjection | null {
  try {
    const input = exact(resource, ["resourceUrl", "uid", "data"]);
    if (typeof input.data !== "string" || typeof input.uid !== "string") return null;
    const selected = selectCaldavEventMaster(input.data, input.uid); validateCaldavPhysicalResource(input.data, selected.index);
    assertStrictCaldavPersonalResource(selected);
    if (selected.master.hasProperty("organizer")) return null;
    const event = new ICAL.Event(selected.master), start = event.startDate, end = event.endDate;
    const ownedZone = (time: ICAL.Time, property: string) => {
      const tzid = selected.master.getFirstProperty(property)?.getParameter("tzid");
      // An ambient alias may resolve an unrelated explicit TZID to this exact
      // UTC singleton. Inspect the native label before accepting that identity.
      if (tzid == null || tzid === "UTC") return time.zone === ICAL.Timezone.utcTimezone;
      return typeof tzid === "string" && selected.calendar.getAllSubcomponents("vtimezone").filter(zone => zone.getFirstPropertyValue("tzid") === tzid).length === 1 &&
        selected.calendar.getTimeZoneByID(tzid) === time.zone;
    };
    if (start.isDate || end.isDate || !ownedZone(start, "dtstart") || !ownedZone(end, "dtend")) return null;
    const startsAt = start.toJSDate(), endsAt = end.toJSDate();
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || startsAt > endsAt) return null;
    const text = (name: string) => {
      const properties = selected.master.getAllProperties(name);
      if (properties.length > 1) throw invalid();
      const value = properties[0]?.getFirstValue();
      if (value != null && typeof value !== "string") throw invalid();
      return typeof value === "string" && value ? value : null;
    };
    const summary = selected.master.getAllProperties("summary"), title = summary[0]?.getFirstValue();
    const description = text("description"), location = text("location");
    if (summary.length !== 1 || typeof title !== "string" || selected.master.getFirstPropertyValue("status")?.toString().toUpperCase() === "CANCELLED") return null;
    return Object.freeze({ title, description, location, start: startsAt.toISOString(), end: endsAt.toISOString(), isAllDay: false, recurrence: null });
  } catch { return null; }
}
/** Frozen conditional CREATE with shared DAV transport; no storage or automatic retry. */
export function createCaldavPersonalEventCreateProvider(ports: CaldavCreateProviderPorts, options: CaldavCreateProviderOptions) {
  const nativeProfile = exact(options, ["nativeProfile"]).nativeProfile;
  if (nativeProfile !== "existing-caldav" && nativeProfile !== "strict-reference" || typeof ports.network.allowPrivate !== "boolean" ||
      typeof ports.network.lookupImpl !== "function") throw invalid();
  const fetch = createGuardedCaldavFetch({ allowPrivate: ports.network.allowPrivate, lookupImpl: ports.network.lookupImpl,
    async fetchPinnedImpl(url, init, address) {
      const method = (init.method ?? "GET") as "GET" | "PROPFIND" | "PUT";
      try { const response = await dispatchNativeHttp(ports.http, String(url), init, (requestInit) => ports.http.fetchPinned(url, requestInit, address), ports.clock, (status, durationMs) => ports.telemetry.record({ provider: "caldav", family: "event", method, status, durationMs })); init.signal?.throwIfAborted(); return response; }
      catch (error) { throw error; }

    },
  });
  const redirect: RequestRedirect = nativeProfile === "strict-reference" ? "error" : "follow";
  async function request(url: string, init: RequestInit): Promise<Response> {
    init.signal?.throwIfAborted();
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    try {
      const response = await fetch(url, { ...init, redirect, signal });
      // Native PUT acceptance is independently retained before strict readback.
      if (nativeProfile === "strict-reference" && init.method !== "PUT" && (response.redirected || response.url && response.url !== new URL(url).href)) throw failed();
      signal.throwIfAborted(); return response;
    } catch (error) {
      if (ports.http.isDispatchDeferred?.(error)) throw error;
      if (error instanceof CaldavProviderError) throw error;
      if (nativeProfile === "existing-caldav") throw error;
      throw new CaldavProviderError("provider-write-failed", init.method === "PUT" ? "unconfirmed" : "not-written");
    }
  }
  const privileges = createCaldavPrivilegeReader({ fetch: ((input, init) => request(String(input), init ?? {})) as typeof globalThis.fetch,
    nowEpochMs: () => ports.clock.nowEpochMs() });
  async function session(scope: CaldavEventTarget, signal?: AbortSignal): Promise<CaldavAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted();
    if (current.connectionId !== scope.connectionId || current.connectionGeneration !== scope.connectionGeneration) throw new CaldavProviderError("account-session-changed");
    if (typeof current.authorization !== "string" || !current.authorization) throw failed();
    return Object.freeze({ connectionId: current.connectionId, connectionGeneration: current.connectionGeneration, authorization: current.authorization });
  }
  function readStatus(response: Response): void {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new CaldavProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new CaldavProviderError("capability-evidence", "not-written", response.status, undefined, "event-write", [401, 403].includes(response.status) ? "denied" : "unknown");
    }
    if (response.status !== 200 || response.headers.has("content-range")) throw failed();
  }
  return {
    async preflightCreate(input: CaldavPersonalCreate, signal?: AbortSignal): Promise<CaldavNativeCreatePreflight> {
      const accepted = creation(input, nativeProfile), current = await session(accepted.target, signal);
      const grant = await privileges.caldavEventPrivileges(accepted.target.calendarUrl, current.authorization, signal, redirect);
      const allowed = caldavAllows(grant, "create");
      if (allowed !== true) throw new CaldavProviderError("capability-evidence", "not-written", undefined, undefined, "event-write", allowed === false ? "denied" : "unknown");
      signal?.throwIfAborted(); return Object.freeze({ kind: "allowed" });
    },
    async create(input: CaldavPersonalCreate, signal?: AbortSignal): Promise<CaldavNativeCreateEvidence> {
      const accepted = creation(input, nativeProfile), current = await session(accepted.target, signal);
      await ports.beforeMutation(accepted, signal); signal?.throwIfAborted();
      const response = await request(accepted.target.resourceUrl, { method: "PUT", signal,
        headers: { authorization: current.authorization, "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" }, body: accepted.body });
      if ([200, 201, 204].includes(response.status)) return Object.freeze({ kind: "created", status: response.status as 200 | 201 | 204,
        resourceUrl: accepted.target.resourceUrl, uid: accepted.target.uid, etag: strongCaldavEtag(response.headers.get("etag")) });
      throw new CaldavProviderError(response.status === 412 ? "provider-conflict" : "provider-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
    },
    async readCreated(input: CaldavPersonalCreate, signal?: AbortSignal): Promise<CaldavNativeCreateReadEvidence> {
      const accepted = creation(input, nativeProfile), current = await session(accepted.target, signal);
      const response = await request(accepted.target.resourceUrl, { signal,
        headers: { authorization: current.authorization, accept: "text/calendar", "Cache-Control": "no-cache" } });
      if (response.status === 404) return Object.freeze({ kind: "absent", status: 404 });
      readStatus(response);
      const data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
      const selected = selectCaldavEventMaster(data, accepted.target.uid); validateCaldavPhysicalResource(data, selected.index);
      if (nativeProfile === "strict-reference") {
        assertStrictCaldavPersonalResource(selected);
        if (selected.master.hasProperty("organizer")) throw new CaldavProviderError("capability-evidence", "not-written", undefined, undefined, "organizer", "unsupported");
      }
      // CREATE host normalization intentionally precedes cancelled-event refusal.
      // Do not substitute DELETE's cancellation/date/recurrence observation path.
      signal?.throwIfAborted();
      return Object.freeze({ kind: "present", resource: Object.freeze({ resourceUrl: accepted.target.resourceUrl, uid: selected.uid, data }),
        etag: strongCaldavEtag(response.headers.get("etag")) });
    },
  };
}
