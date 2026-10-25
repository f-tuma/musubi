import { createCaldavPrivilegeReader } from "@musubi/provider-caldav/dav-privileges";
import { CaldavProviderError } from "@musubi/provider-caldav";
import { createGuardedCaldavFetch } from "./caldav_client";
import { ProviderEventWriteError } from "./event_write";
export { caldavAllows, caldavReadAccess } from "@musubi/provider-caldav/dav-privileges";

const reader = createCaldavPrivilegeReader({ fetch: createGuardedCaldavFetch(), nowEpochMs: () => Date.now() });
async function legacy<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof CaldavProviderError) throw new ProviderEventWriteError("provider-write-failed", error.outcome, error.providerStatus, error.retryAfterMs);
    throw error;
  }
}
export function caldavEventPrivileges(...args: Parameters<typeof reader.caldavEventPrivileges>) {
  return legacy(() => reader.caldavEventPrivileges(...args));
}
export function caldavEventWritePermission(...args: Parameters<typeof reader.caldavEventWritePermission>) {
  return legacy(() => reader.caldavEventWritePermission(...args));
}
export function caldavOrganizerAddresses(...args: Parameters<typeof reader.caldavOrganizerAddresses>) {
  return legacy(() => reader.caldavOrganizerAddresses(...args));
}
