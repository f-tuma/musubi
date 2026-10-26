import { config } from "@musubi/config";
import { AvailabilityRequestSchema, AvailabilityResponseSchema, ForbiddenError, type AvailabilityResponse } from "@musubi/types";
import { readAvailabilitySources, googleAvailabilityScope } from "@musubi/db";
import { getGoogleAccessToken } from "./adapters/google";
import { queryGoogleFreebusy } from "./adapters/google_freebusy";
import { withAccountBudgetScope } from "./provider_budget";
export function requireAvailabilityEnabled() {
  if (!config.api.googleAvailabilityEnabled) throw new ForbiddenError("Google availability is not enabled.");
}
export async function readGoogleAvailability(userID: string, input: unknown): Promise<AvailabilityResponse> {
  requireAvailabilityEnabled();
  const range = AvailabilityRequestSchema.parse(input);
  const all = await readAvailabilitySources(userID);
  const sources = range.sourceIds.map(id => all.find(row => row.source.id === id && row.source.enabled));
  if (sources.some(row => !row)) throw new ForbiddenError("Availability source is not available.");
  const results = await Promise.all(sources.map(async row => {
    const { source, nativeAccountID, scope, syncStatus, refreshToken } = row!;
    const base = { sourceId: source.id, generation: source.generation };
    if (!refreshToken || syncStatus !== "active" || !googleAvailabilityScope(scope)) return { ...base, status: "reconnect-required" as const };
    try { return await withAccountBudgetScope("google", userID, nativeAccountID, async () => {
      const token = await getGoogleAccessToken(userID, nativeAccountID);
      const before = (await readAvailabilitySources(userID)).find(current => current.source.id === source.id);
      if (!before || before.source.generation !== source.generation || !before.source.enabled || (before.accountGeneration !== row!.accountGeneration || before.accountEpoch !== row!.accountEpoch)) return { ...base, status: "unavailable" as const };
      if (!before.refreshToken || before.syncStatus !== "active" || !googleAvailabilityScope(before.scope)) return { ...base, status: "reconnect-required" as const };
      const intervals = await queryGoogleFreebusy(token, source.externalID, range, AbortSignal.timeout(10_000));
      return { ...base, status: "available" as const, intervals };
    }, { purpose: "pull" });
    } catch { return { ...base, status: "unavailable" as const }; }
  }));
  // No in-flight observation crosses a selection/access/account generation.
  const current = await readAvailabilitySources(userID);
  requireAvailabilityEnabled();
  const safe = results.map((result, index) => {
    const before = sources[index]!;
    const after = current.find(row => row.source.id === before.source.id);
    if (!after || !after.source.enabled || after.source.generation !== before.source.generation || (after.accountGeneration !== before.accountGeneration || after.accountEpoch !== before.accountEpoch)) return { sourceId: before.source.id, generation: before.source.generation, status: "unavailable" as const };
    if (!after.refreshToken || after.syncStatus !== "active" || !googleAvailabilityScope(after.scope)) return { sourceId: before.source.id, generation: before.source.generation, status: "reconnect-required" as const };
    return result;
  });
  return AvailabilityResponseSchema.parse({ start: range.start, end: range.end, observedAt: new Date().toISOString(), sources: safe });
}
