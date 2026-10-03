import { AsyncLocalStorage } from "node:async_hooks";
import { assertDavReadResponse, canonicalDavReadXML, requestedDavHrefs, davMultistatus, successfulDavProperty, CALDAV, DavReadResponseError } from "./caldav_properties";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { config } from "@musubi/config";
import { createDAVClient } from "tsdav";
import { Agent } from "undici";
import { type LookupAll, resolveHttpAddresses } from "../federation_origin";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const pinnedAgents = new Map<string, Agent>();

function fetchPinned(
	url: URL,
	init: RequestInit,
	address: LookupAddress,
): Promise<Response> {
	const key = `${url.origin}|${address.address}|${address.family}`;
	let dispatcher = pinnedAgents.get(key);
	if (!dispatcher) {
		if (pinnedAgents.size >= 256) {
			const oldest = pinnedAgents.keys().next().value;
			if (oldest) void pinnedAgents.get(oldest)?.close();
			if (oldest) pinnedAgents.delete(oldest);
		}
		dispatcher = new Agent({
			connect: {
				autoSelectFamily: false,
				lookup(_hostname, _options, callback) {
					callback(null, address.address, address.family);
				},
			},
		});
		pinnedAgents.set(key, dispatcher);
	}
	return globalThis.fetch(url, {
		...init,
		dispatcher,
	} as RequestInit & { dispatcher: Agent });
}

export async function assertCaldavTarget(
	value: string,
	{
		allowPrivate = config.security.federationAllowPrivateHosts,
		lookupImpl = lookup,
	}: { allowPrivate?: boolean; lookupImpl?: LookupAll } = {},
) {
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new Error("CalDAV server URL must be an absolute HTTP(S) URL.");
	}
	if (target.protocol !== "https:" && target.protocol !== "http:") {
		throw new Error("CalDAV server URL must use HTTP or HTTPS.");
	}
	if (!allowPrivate && target.protocol !== "https:") {
		throw new Error("CalDAV server URL must use HTTPS outside development.");
	}
	return resolveHttpAddresses(target.origin, { allowPrivate, lookupImpl });
}

export function createGuardedCaldavFetch({
	allowPrivate = config.security.federationAllowPrivateHosts,
	lookupImpl = lookup,
	fetchPinnedImpl = fetchPinned,
}: {
	allowPrivate?: boolean;
	lookupImpl?: LookupAll;
	fetchPinnedImpl?: (
		url: URL,
		init: RequestInit,
		address: LookupAddress,
	) => Promise<Response>;
} = {}): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		let url: URL;
		try {
			url = new URL(input instanceof Request ? input.url : String(input));
		} catch {
			throw new Error("CalDAV server URL must be absolute.");
		}
		let requestInit: RequestInit =
			input instanceof Request
				? {
						headers: new Headers(input.headers),
						method: input.method,
						signal: input.signal,
						...init,
					}
				: { ...init };

		for (let redirects = 0; ; redirects += 1) {
			const [address] = await assertCaldavTarget(url.href, {
				allowPrivate,
				lookupImpl,
			});
			const response = await fetchPinnedImpl(
				url,
				{ ...requestInit, redirect: "manual" },
				address!,
			);
			if (!REDIRECT_STATUSES.has(response.status)) return response;
			if (requestInit.redirect === "error") {
				await response.body?.cancel();
				throw new Error("CalDAV scoped resource request cannot redirect.");
			}
			if (redirects >= 5) {
				await response.body?.cancel();
				throw new Error("Too many CalDAV redirects.");
			}

			const location = response.headers.get("location");
			if (!location) {
				await response.body?.cancel();
				throw new Error("CalDAV redirect has no destination.");
			}
			const next = new URL(location, url);
			const method = requestInit.method?.toUpperCase() ?? "GET";
			const becomesGet =
				response.status === 303 ||
				((response.status === 301 || response.status === 302) && method === "POST");
			const headers = new Headers(requestInit.headers);
			// A GET after a conditional PUT/DELETE is not acknowledgement of that
			// mutation. Never turn a redirect into apparent compare-write success.
			if (
				becomesGet &&
				method !== "GET" &&
				method !== "HEAD" &&
				(headers.has("if-match") || headers.has("if-none-match"))
			) {
				await response.body?.cancel();
				throw new Error("CalDAV conditional mutation cannot redirect to GET.");
			}
			if (next.origin !== url.origin) headers.delete("authorization");
			if (becomesGet) {
				headers.delete("content-encoding");
				headers.delete("content-language");
				headers.delete("content-location");
				headers.delete("content-type");
				requestInit = {
					...requestInit,
					body: undefined,
					headers,
					method: "GET",
				};
			} else {
				requestInit = { ...requestInit, headers };
			}
			await response.body?.cancel();
			url = next;
		}
	}) as typeof globalThis.fetch;
}

// Builds a CalDAV client (Basic auth). Every initial, discovered, and redirected
// request goes through the same SSRF/TLS boundary before credentials can leave.
export function createCaldavClient(
	serverUrl: string,
	username: string,
	password: string,
) {
  const guarded = createGuardedCaldavFetch();
  const resourceReads = new AsyncLocalStorage<Map<string, string>>();
  let discoveryFailure: unknown;
  const verified: typeof globalThis.fetch = async (input, init) => {
    if (discoveryFailure) throw discoveryFailure;
    const method = init?.method?.toUpperCase(), headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const kind = method === "PROPFIND" && body.includes("current-user-principal") ? "principal" : method === "PROPFIND" && body.includes("calendar-home-set") ? "home" : method === "PROPFIND" && headers.get("depth") === "1" ? (body.includes("resourcetype") ? "discovery" : body.includes("getetag") ? "listing" : undefined) : method === "REPORT" && body.includes("calendar-multiget") ? "multiget" : method === "REPORT" && body.includes("sync-collection") ? "sync" : undefined;
    let response: Response;
    try { response = await guarded(input, kind === "multiget" ? { ...init, redirect: "error" } : init); } catch (error) {
      if (kind === "principal" || kind === "home") discoveryFailure = error;
      throw error;
    }
    if (kind) {
      try {
      if (response.status !== 207) throw new DavReadResponseError("http-status", { readKind: kind, httpStatus: response.status });
      if (response.headers.has("content-range")) throw new DavReadResponseError("http-partial", { readKind: kind, httpStatus: response.status });
      if (!/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?xml(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new DavReadResponseError("http-content-type", { readKind: kind, httpStatus: response.status });
      const xml = await response.text();
      assertDavReadResponse(xml, response.url || String(input), kind, kind === "multiget" ? requestedDavHrefs(body) : undefined, response.headers.get("content-location") ?? undefined);
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
		defaultAccountType: "caldav",
		fetch: verified,
	}).then(client => {
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
    return client;
  });
}
