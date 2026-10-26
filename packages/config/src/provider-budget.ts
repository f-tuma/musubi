export type ProviderBudgetProvider = "google" | "microsoft" | "caldav";
export type ProviderBudgetDimension = "provider" | "application" | "account";
export type ProviderBudgetLimits = Record<ProviderBudgetProvider, Record<ProviderBudgetDimension, { capacity: number; refillPerSecond: number }>>;
/** API continuation retention policy; these values are not provider quotas. */
export const PROVIDER_BUDGET_CONTINUATION_WINDOW_MS = 15_000;
export const MIN_PROVIDER_BUDGET_REFILL_PER_SECOND = 1000 / PROVIDER_BUDGET_CONTINUATION_WINDOW_MS;
/** Operator-selected local bounds. These are not official provider quota figures. */
export function parseProviderBudgetLimits(value: string | undefined): ProviderBudgetLimits {
  const defaults = Object.fromEntries(["google", "microsoft", "caldav"].map(provider => [provider, {
    provider: { capacity: 16, refillPerSecond: 8 }, application: { capacity: 16, refillPerSecond: 8 }, account: { capacity: 4, refillPerSecond: 2 },
  }]));
  if (value === undefined) return defaults as ProviderBudgetLimits;
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("Invalid EXTERNAL_PROVIDER_BUDGETS_JSON."); }
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object" && !Array.isArray(input);
  if (!object(parsed) || Object.keys(parsed).some(key => !["google", "microsoft", "caldav"].includes(key))) throw new Error("Invalid provider budget provider.");
  for (const [provider, dimensions] of Object.entries(parsed)) {
    if (!object(dimensions) || Object.keys(dimensions).some(key => !["provider", "application", "account"].includes(key))) throw new Error("Invalid provider budget dimension.");
    for (const [dimension, limit] of Object.entries(dimensions)) {
      if (!object(limit) || Object.keys(limit).length !== 2 || !Object.prototype.hasOwnProperty.call(limit, "capacity") || !Object.prototype.hasOwnProperty.call(limit, "refillPerSecond") ||
        typeof limit.capacity !== "number" || !Number.isSafeInteger(limit.capacity) || limit.capacity < 1 ||
        typeof limit.refillPerSecond !== "number" || !Number.isFinite(limit.refillPerSecond) || limit.refillPerSecond <= 0)
        throw new Error("Invalid provider token bucket bounds.");
      if (limit.refillPerSecond < MIN_PROVIDER_BUDGET_REFILL_PER_SECOND)
        throw new Error("Provider token refill must supply at least one token per 15 seconds to retain native continuation progress.");
      (defaults as ProviderBudgetLimits)[provider as ProviderBudgetProvider][dimension as ProviderBudgetDimension] = { capacity: limit.capacity, refillPerSecond: limit.refillPerSecond };
    }
  }
  return defaults as ProviderBudgetLimits;
}
export function parseProviderBudgetNamespace(value: string | undefined) {
  const namespace = value ?? "musubi-sync-v1";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new Error("Invalid EXTERNAL_PROVIDER_BUDGET_NAMESPACE.");
  return namespace;
}
