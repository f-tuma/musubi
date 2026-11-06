import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { config } from "@musubi/config";
import { createPinnedCaldavFetch } from "@musubi/provider-caldav/network";
import {
  canonicalHttpOrigin,
  resolveHttpAddresses as sharedResolveHttpAddresses,
  type LookupAll,
} from "@musubi/provider-caldav/network-origin";
export { canonicalHttpOrigin, isBlockedAddress, type LookupAll } from "@musubi/provider-caldav/network-origin";

export function resolveHttpAddresses(origin: string, {
  allowPrivate = config.security.federationAllowPrivateHosts,
  lookupImpl = lookup as LookupAll,
}: { allowPrivate?: boolean; lookupImpl?: LookupAll } = {}): Promise<LookupAddress[]> {
  return sharedResolveHttpAddresses(origin, { allowPrivate, lookupImpl });
}

/** Resolve `origin` and refuse it when any address is internal. */
export async function assertPublicOrigin(origin: string, options: { allowPrivate?: boolean } = {}): Promise<void> {
  if (options.allowPrivate ?? config.security.federationAllowPrivateHosts) return;
  await resolveHttpAddresses(origin, options);
}

/** `redirect` may only be `"manual"`; the wrapper enforces it regardless (F-01 variant a). */
export type FederationFetchInit = Omit<RequestInit, "redirect"> & { redirect?: "manual" };
export type FederationFetch = (input: string | URL, init?: FederationFetchInit) => Promise<Response>;

const defaultFetchPinned = createPinnedCaldavFetch((input, init) => globalThis.fetch(input, init));

/**
 * Race a pending promise against an abort signal.
 *
 * On abort the result rejects with the identical `signal.reason` object and the
 * abandoned promise keeps a no-op rejection handler: getaddrinfo cannot be
 * cancelled, and a late failure must not surface as an unhandled rejection.
 * The abort listener is removed on both paths.
 */
function raceAbort<T>(signal: AbortSignal | undefined, pending: Promise<T>): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Outbound fetch for every federation call (gateway, preview, connect, peer
 * probe, token rotation, SSE stream): the connection may only reach addresses
 * that passed the private-network policy in the same resolve, so a DNS answer
 * that changes between the check and the connect cannot move the socket. The
 * hostname stays in the URL (Host, SNI and certificate verification are native),
 * redirects are never followed and abort/timeout also cover the DNS wait.
 */
export function createFederationFetch({
  allowPrivate,
  lookupImpl = lookup as LookupAll,
  fetchPinnedImpl = defaultFetchPinned,
}: {
  /** Default: read from `config.security.federationAllowPrivateHosts` at every call. */
  allowPrivate?: boolean;
  lookupImpl?: LookupAll;
  fetchPinnedImpl?: (url: URL, init: RequestInit, pin: readonly LookupAddress[]) => Promise<Response>;
} = {}): FederationFetch {
  return async function federationFetch(input, init = {}) {
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    if ((input as unknown) instanceof globalThis.Request) {
      throw new TypeError("Federation fetch takes a URL, not a Request.");
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Federation URL must be absolute.");
    }
    if (url.username || url.password) throw new Error("Federation URL must not carry credentials.");
    // A non-http(s) scheme has origin "null" and fails here before any lookup.
    if (!canonicalHttpOrigin(url.origin)) throw new Error("Federation URL must use http(s).");
    const addresses = await raceAbort(
      signal,
      sharedResolveHttpAddresses(url.origin, {
        allowPrivate: allowPrivate ?? config.security.federationAllowPrivateHosts,
        lookupImpl,
      }),
    );
    // An abort that lands in the same tick as the lookup result must still win.
    signal?.throwIfAborted();
    return fetchPinnedImpl(url, { ...init, redirect: "manual", signal }, addresses);
  };
}

export const federationFetch = createFederationFetch();
