import type { LookupAddress } from "node:dns";
import { Agent } from "undici";
import { resolveHttpAddresses, type LookupAll } from "./network-origin";

/** The host supplies its actual leaf fetch; this helper never uses ambient fetch. */
export function createPinnedCaldavFetch(fetchImpl: typeof globalThis.fetch) {
const pinnedAgents = new Map<string, Agent>();

return function fetchPinned(
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
	return fetchImpl(url, {
		...init,
		dispatcher,
	} as RequestInit & { dispatcher: Agent });
}

}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export async function assertCaldavTarget(
	value: string,
	{
		allowPrivate,
		lookupImpl,
	}: { allowPrivate: boolean; lookupImpl: LookupAll },
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
	allowPrivate,
	lookupImpl,
	fetchPinnedImpl,
}: {
	allowPrivate: boolean;
	lookupImpl: LookupAll;
	fetchPinnedImpl: (
		url: URL,
		init: RequestInit,
		address: LookupAddress,
	) => Promise<Response>;
}): typeof globalThis.fetch {
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
			requestInit.signal?.throwIfAborted();
			const [address] = await assertCaldavTarget(url.href, {
				allowPrivate,
				lookupImpl,
			});
			requestInit.signal?.throwIfAborted();
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
