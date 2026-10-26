import { dispatchNativeHttp } from "./http-dispatch";
import { createGuardedCaldavFetch } from "./network";
import { createCaldavPrivilegeReader, caldavAllows } from "./dav-privileges";
import {
  assertStrictCaldavPersonalResource, caldavComponentString, selectCaldavEventMaster,
  strictCaldavResourceURL, validateCaldavObservation, validateCaldavPhysicalResource,
} from "./native-event";
import { CaldavProviderError } from "./types";
import { strongCaldavEtag } from "./native-etag";
import type {
  CaldavAccountSession, CaldavDeleteProviderOptions, CaldavDeleteProviderPorts, CaldavEventTarget, CaldavNativeDeleteEvidence,
  CaldavNativeDeletePreflight, CaldavNativeDeleteReadEvidence, CaldavNativeProfile, CaldavPersonalDelete,
} from "./types";
export * from "./types";
export { strongCaldavEtag } from "./native-etag";
export { createCaldavPersonalEventCreateProvider, caldavPersonalCreateIdentityV1, normalizeCaldavCreateProjection } from "./create";
export { selectCaldavEventMaster, strictCaldavResourceURL, validateCaldavPhysicalResource } from "./native-event";

const failed = () => new CaldavProviderError("provider-write-failed");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"))) throw failed();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]) {
  const item = record(value);
  if (Reflect.ownKeys(item).length !== keys.length || keys.some(key => !Object.getOwnPropertyDescriptor(item, key)?.enumerable))
    throw new CaldavProviderError("event-diff-unavailable");
  return item;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw new CaldavProviderError("provider-conflict");
  return value;
}
function requireEtag(value: unknown): string {
  const etag = strongCaldavEtag(value);
  if (etag === null) throw new CaldavProviderError("provider-version-unavailable");
  return etag;
}
function target(value: unknown, profile: CaldavNativeProfile): CaldavEventTarget {
  const item = exact(value, ["connectionId", "connectionGeneration", "calendarUrl", "resourceUrl", "uid"]);
  const scope = Object.freeze({ connectionId: id(item.connectionId), connectionGeneration: id(item.connectionGeneration),
    calendarUrl: id(item.calendarUrl), resourceUrl: id(item.resourceUrl), uid: id(item.uid) });
  if (/[\r\n]/.test(scope.uid)) throw new CaldavProviderError("provider-conflict");
  try {
    for (const value of [scope.calendarUrl, scope.resourceUrl]) if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error();
    if (profile === "strict-reference") strictCaldavResourceURL(scope.calendarUrl, scope.resourceUrl);
  } catch { throw new CaldavProviderError("provider-conflict"); }
  return scope;
}
function deletion(value: unknown, profile: CaldavNativeProfile): CaldavPersonalDelete {
  const item = exact(value, ["target", "acceptedEtag", "operationId", "attemptId", "serializer"]), serializer = exact(item.serializer, ["id", "version"]);
  if (serializer.id !== "caldav-personal-event" || serializer.version !== 1) throw new CaldavProviderError("event-diff-unavailable");
  return Object.freeze({ target: target(item.target, profile), acceptedEtag: requireEtag(item.acceptedEtag), operationId: id(item.operationId),
    attemptId: id(item.attemptId), serializer: Object.freeze({ id: "caldav-personal-event" as const, version: 1 as const }) });
}
function capability(allowed: boolean | undefined, subject: "event-write" | "organizer") {
  if (allowed !== true) throw new CaldavProviderError("capability-evidence", "not-written", undefined, undefined, subject, allowed === false ? "denied" : "unknown");
}
function retryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
/** The selected profile is fixed before any await. Existing native aliases and
 * reference's narrower exact-resource policy remain deliberately distinct. */
export function createCaldavPersonalEventDeleteProvider(ports: CaldavDeleteProviderPorts, options: CaldavDeleteProviderOptions) {
  const nativeProfile = exact(options, ["nativeProfile"]).nativeProfile;
  if (nativeProfile !== "existing-caldav" && nativeProfile !== "strict-reference" || typeof ports.network.allowPrivate !== "boolean" ||
      typeof ports.network.lookupImpl !== "function") throw new CaldavProviderError("event-diff-unavailable");
  const fetch = createGuardedCaldavFetch({ allowPrivate: ports.network.allowPrivate, lookupImpl: ports.network.lookupImpl,
    async fetchPinnedImpl(url, init, address) {
      const method = (init.method ?? "GET") as "GET" | "PROPFIND" | "DELETE";
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
      if (nativeProfile === "strict-reference" && (response.redirected || response.url && response.url !== new URL(url).href))
        throw new CaldavProviderError("provider-write-failed", init.method === "DELETE" ? "unconfirmed" : "not-written", response.status);
      signal.throwIfAborted(); return response;
    } catch (error) {
      if (ports.http.isDispatchDeferred?.(error)) throw error;
      if (error instanceof CaldavProviderError) throw error;
      if (nativeProfile === "existing-caldav") throw error;
      throw new CaldavProviderError("provider-write-failed", init.method === "DELETE" ? "unconfirmed" : "not-written");
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
  function readStatus(response: Response) {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new CaldavProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new CaldavProviderError("capability-evidence", "not-written", response.status, undefined, "event-write", [401, 403].includes(response.status) ? "denied" : "unknown");
    }
  }
  async function resource(response: Response, scope: CaldavEventTarget, observation: boolean) {
    const data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
    const selected = selectCaldavEventMaster(data, scope.uid); validateCaldavPhysicalResource(data, selected.index);
    if (observation) {
      if (caldavComponentString(selected.master, "status")?.toUpperCase() === "CANCELLED") throw new CaldavProviderError("provider-conflict");
      validateCaldavObservation(selected.master);
    }
    return { selected, resource: Object.freeze({ resourceUrl: scope.resourceUrl, uid: selected.uid, data }) };
  }
  return {
    async readForDelete(input: CaldavEventTarget, signal?: AbortSignal): Promise<CaldavNativeDeleteReadEvidence> {
      const scope = target(input, nativeProfile), current = await session(scope, signal);
      const response = await request(scope.resourceUrl, { signal, headers: { authorization: current.authorization, accept: "text/calendar", "Cache-Control": "no-cache" } });
      if (response.status === 404) return Object.freeze({ kind: "absent", status: 404 });
      readStatus(response);
      if (response.status !== 200 || response.headers.has("content-range")) throw failed();
      const native = await resource(response, scope, true); signal?.throwIfAborted();
      return Object.freeze({ kind: "present", resource: native.resource, etag: strongCaldavEtag(response.headers.get("etag")) });
    },
    async preflightDelete(input: CaldavPersonalDelete, signal?: AbortSignal): Promise<CaldavNativeDeletePreflight> {
      const accepted = deletion(input, nativeProfile), current = await session(accepted.target, signal);
      const grant = await privileges.caldavEventPrivileges(accepted.target.calendarUrl, current.authorization, signal, redirect);
      capability(caldavAllows(grant, "delete"), "event-write");
      const response = await request(accepted.target.resourceUrl, { signal, headers: { authorization: current.authorization, accept: "text/calendar", "Cache-Control": "no-cache" } });
      readStatus(response); const etag = requireEtag(response.headers.get("etag"));
      if (etag !== accepted.acceptedEtag) throw new CaldavProviderError("provider-conflict");
      if (response.status !== 200 || response.headers.has("content-range")) throw failed();
      const native = await resource(response, accepted.target, false);
      if (nativeProfile === "strict-reference") { validateCaldavObservation(native.selected.master); assertStrictCaldavPersonalResource(native.selected); }
      const organizer = caldavComponentString(native.selected.master, "organizer");
      if (organizer) {
        const addresses = await privileges.caldavOrganizerAddresses(accepted.target.calendarUrl, current.authorization, signal);
        const self = addresses?.includes(organizer.replace(/^mailto:/i, "").toLowerCase());
        if (self && native.selected.master.getAllProperties("attendee").length)
          throw new CaldavProviderError("capability-evidence", "not-written", undefined, undefined, "organizer", "unsupported");
        capability(self === false ? undefined : self, "organizer");
      }
      signal?.throwIfAborted();
      return Object.freeze({ kind: "allowed", resource: native.resource, etag });
    },
    async delete(input: CaldavPersonalDelete, signal?: AbortSignal): Promise<CaldavNativeDeleteEvidence> {
      const accepted = deletion(input, nativeProfile), current = await session(accepted.target, signal);
      await ports.beforeMutation(accepted, signal); signal?.throwIfAborted();
      const response = await request(accepted.target.resourceUrl, { method: "DELETE", signal, headers: { authorization: current.authorization, "If-Match": accepted.acceptedEtag } });
      if ([200, 201, 204, 404].includes(response.status)) return Object.freeze({ kind: "deleted", status: response.status as CaldavNativeDeleteEvidence["status"] });
      throw new CaldavProviderError(response.status === 412 ? "provider-conflict" : "provider-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
    },
  };
}
