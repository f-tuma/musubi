import { AsyncLocalStorage } from "node:async_hooks";
import { assertDavReadResponse, canonicalDavReadXML, requestedDavHrefs, davMultistatus, successfulDavProperty, CALDAV, DavReadResponseError } from "./caldav_properties";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { config } from "@musubi/config";
import { createDAVClient } from "tsdav";
import { type LookupAll } from "../federation_origin";
import { assertCaldavTarget as sharedAssertCaldavTarget, createGuardedCaldavFetch as sharedGuardedCaldavFetch, createPinnedCaldavFetch } from "@musubi/provider-caldav/network";
import { observedProviderFetch } from "./provider_http_metrics";
import { ProviderEventWriteError, providerRetryAfterMs } from "./event_write";
import { copyCaldavDiscoveryMaterial, type CaldavDiscoveryMaterial } from "./caldav_discovery_material";
import { budgetAttemptSignal, providerDeferral } from "./provider_budget";

export type CaldavDiscoveryMaterialPort = Readonly<{
  material?: CaldavDiscoveryMaterial;
  commit(material: CaldavDiscoveryMaterial): void | Promise<void>;
  invalidate(): void;
}>;
export type CaldavRequestScope = <T>(run: () => Promise<T>) => Promise<T>;

const fetchPinned = createPinnedCaldavFetch(observedProviderFetch);
/** New provider telemetry records each raw leaf; legacy leaves remain observed above. */
export const fetchCaldavPinned = createPinnedCaldavFetch((input, init) => globalThis.fetch(input, {
  ...init, signal: budgetAttemptSignal(init?.signal ?? undefined),
}));

export function assertCaldavTarget(value: string, {
  allowPrivate = config.security.federationAllowPrivateHosts,
  lookupImpl = lookup,
}: { allowPrivate?: boolean; lookupImpl?: LookupAll } = {}) {
  return sharedAssertCaldavTarget(value, { allowPrivate, lookupImpl });
}

export function createGuardedCaldavFetch({
  allowPrivate = config.security.federationAllowPrivateHosts,
  lookupImpl = lookup,
  fetchPinnedImpl = fetchPinned,
}: {
  allowPrivate?: boolean;
  lookupImpl?: LookupAll;
  fetchPinnedImpl?: (url: URL, init: RequestInit, address: LookupAddress) => Promise<Response>;
} = {}): typeof globalThis.fetch {
  return sharedGuardedCaldavFetch({ allowPrivate, lookupImpl, fetchPinnedImpl });
}

// Builds a CalDAV client (Basic auth). Every initial, discovered, and redirected
// request goes through the same SSRF/TLS boundary before credentials can leave.
export function createCaldavClient(
	serverUrl: string,
	username: string,
	password: string,
	signal?: AbortSignal,
	materialPort?: CaldavDiscoveryMaterialPort,
	requestScope?: CaldavRequestScope,
) {
  signal?.throwIfAborted();
  const guarded = createGuardedCaldavFetch();
  const resourceReads = new AsyncLocalStorage<Map<string, string>>();
  const syncReads = new AsyncLocalStorage<{ expectedURL: string; token?: string }>();
  let discoveryFailure: unknown;
  const verified: typeof globalThis.fetch = async (input, init) => {
    signal?.throwIfAborted();
    if (discoveryFailure) throw discoveryFailure;
    const method = init?.method?.toUpperCase(), headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const kind = method === "PROPFIND" && body.includes("current-user-principal") ? "principal" : method === "PROPFIND" && body.includes("calendar-home-set") ? "home" : method === "PROPFIND" && headers.get("depth") === "1" ? (body.includes("resourcetype") ? "discovery" : body.includes("getetag") ? "listing" : undefined) : method === "REPORT" && body.includes("calendar-multiget") ? "multiget" : method === "REPORT" && body.includes("sync-collection") ? "sync" : undefined;
    let response: Response;
    const options = { ...init, ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}), ...(kind === "multiget" || kind === "sync" ? { redirect: "error" as const } : {}) };
    try { response = await (requestScope ? requestScope(() => guarded(input, options)) : guarded(input, options)); } catch (error) {
      materialPort?.invalidate();
      if (kind === "principal" || kind === "home" || providerDeferral(error)) discoveryFailure = error;
      throw error;
    }
    if (kind) {
      try {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new ProviderEventWriteError("provider-write-failed", "not-written", response.status, providerRetryAfterMs(response));
      if (response.status !== 207) throw new DavReadResponseError("http-status", { readKind: kind, httpStatus: response.status });
      if (response.headers.has("content-range")) throw new DavReadResponseError("http-partial", { readKind: kind, httpStatus: response.status });
      if (!/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?xml(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new DavReadResponseError("http-content-type", { readKind: kind, httpStatus: response.status });
      const xml = await response.text();
      const syncToken = assertDavReadResponse(xml, response.url || String(input), kind, kind === "multiget" ? requestedDavHrefs(body) : undefined, response.headers.get("content-location") ?? undefined);
      const syncRead = kind === "sync" ? syncReads.getStore() : undefined;
      if (syncRead) {
        // A token-only REPORT has no resource href that could bind its scope.
        // Keep root metadata only after complete validation of this exact call.
        if (response.redirected || syncRead.token !== undefined || !syncToken ||
          new URL(String(input)).href !== syncRead.expectedURL ||
          new URL(response.url || String(input)).href !== syncRead.expectedURL)
          throw new DavReadResponseError("invalid-structure", { readKind: "sync" });
        syncRead.token = syncToken;
      }
      if (kind === "multiget") {
        const resources = resourceReads.getStore();
        for (const row of davMultistatus(xml, response.url || String(input))) {
          const data = successfulDavProperty(row, CALDAV, "calendar-data")!;
          if (resources?.has(row.href)) throw new Error("CalDAV resource appeared twice in one read.");
          resources?.set(row.href, data.text);
        }
      }
      const originalURL = response.url;
      response = new Response(canonicalDavReadXML(xml, originalURL || String(input)), { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(response, "url", { value: originalURL });
      } catch (error) {
        materialPort?.invalidate();
        // tsdav may catch discovery errors and fall back to the root. Such a
        // fallback must not turn unproven principal/home data into removals.
        if (kind === "principal" || kind === "home") discoveryFailure = error;
        throw error;
      }
    }
    return response;
  };
	return createDAVClient({
		serverUrl,
		credentials: { username, password },
		authMethod: "Basic",
		fetch: verified,
	}).then(async client => {
    // Use tsdav's actual account construction, with fresh credentials and
    // request-local guarded fetch. A cached route only skips endpoint lookup;
    // it never supplies collections, privilege evidence or a sync token.
    signal?.throwIfAborted();
    const material = materialPort?.material && copyCaldavDiscoveryMaterial(materialPort.material);
    const account = await client.createAccount({ account: { accountType: "caldav", ...material } });
    signal?.throwIfAborted();
    // These are exactly the account-default methods createDAVClient normally
    // binds after login. Preserve caller overrides and its own auth merging.
    for (const key of ["smartCollectionSync", "smartCollectionSyncDetailed", "fetchCalendars", "fetchCalendarUserAddresses", "syncCalendars", "syncCalendarsDetailed", "fetchAddressBooks"] as const) {
      const original = client[key] as (parameters?: Record<string, unknown>) => unknown;
      Object.defineProperty(client, key, { configurable: true, enumerable: true, writable: true,
        value: (parameters?: Record<string, unknown>) => original({ account, ...parameters }) });
    }
    const fetchCalendars = client.fetchCalendars.bind(client);
    client.fetchCalendars = async parameters => {
      try {
        const calendars = await fetchCalendars(parameters);
        signal?.throwIfAborted();
        // Explicit alternate accounts/fetch/projections retain their old client
        // behavior, but cannot publish cache material as complete discovery.
        if (materialPort && parameters === undefined) {
          await materialPort.commit(copyCaldavDiscoveryMaterial({ rootUrl: account.rootUrl!, principalUrl: account.principalUrl!, homeUrl: account.homeUrl! }));
          signal?.throwIfAborted();
        }
        return calendars;
      } catch (error) { materialPort?.invalidate(); throw error; }
    };
    const fetchObjects = client.fetchCalendarObjects.bind(client);
    client.fetchCalendarObjects = parameters => resourceReads.run(new Map(), async () => {
      const objects = await fetchObjects(parameters);
      const resources = resourceReads.getStore()!;
      // Use the validated namespace-preserving scalar, not tsdav's trimmed text.
      // The map belongs to this read only, including concurrent calls.
      return objects.map(object => {
        const data = resources.get(object.url);
        if (data === undefined) throw new Error("CalDAV resource lacks a validated complete body.");
        return { ...object, data };
      });
    });
    const syncCollection = client.syncCollection.bind(client);
    // tsdav drops raw root metadata when a valid REPORT has no response rows.
    // The token belongs to this request, never the earlier calendar discovery
    // or another concurrent call. Do not fabricate a DAV resource to carry it.
    const syncCollectionWithToken = async (parameters: Parameters<typeof syncCollection>[0]) => {
      // This result promises guarded response evidence; a caller-supplied fetch
      // could otherwise pair an unrelated nested read with unvalidated rows.
      if (parameters.fetch !== undefined) throw new DavReadResponseError("invalid-structure", { readKind: "sync" });
      let expectedURL: string;
      try { expectedURL = new URL(parameters.url).href; }
      catch { throw new DavReadResponseError("invalid-structure", { readKind: "sync" }); }
      const context: { expectedURL: string; token?: string } = { expectedURL };
      return syncReads.run(context, async () => {
        const responses = await syncCollection(parameters);
        if (context.token === undefined) throw new DavReadResponseError("invalid-structure", { readKind: "sync" });
        return { responses, syncToken: context.token };
      });
    };
    return Object.assign(client, { syncCollectionWithToken, invalidateDiscoveryMaterial: () => materialPort?.invalidate() });
  }).catch(error => { materialPort?.invalidate(); throw error; });
}
