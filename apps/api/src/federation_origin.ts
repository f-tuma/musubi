import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { config } from "@musubi/config";
import { resolveHttpAddresses as sharedResolveHttpAddresses, type LookupAll } from "@musubi/provider-caldav/network-origin";
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
