import { createHash } from "node:crypto";
import { asc, inArray, sql } from "drizzle-orm";
import { db } from "..";
import { providerBudgetCooldowns } from "../schema";
import type { DbTransaction } from "./calendars";

export type ProviderCooldownDimension = "provider" | "application" | "tenant" | "account";
export type ProviderCooldownScope = Readonly<{ key: string; dimension: ProviderCooldownDimension }>;
export type ProviderCooldownExtension = Readonly<{
  scopes: readonly ProviderCooldownScope[]; notBeforeEpochMs: number; minimumDelayMs?: number;
}>;
export type StoredProviderCooldown = Readonly<{
  scope: ProviderCooldownScope; notBeforeEpochMs: number; minimumRemainingMs: number;
}>;
export type ProviderCooldownSnapshot = Readonly<{ rows: readonly StoredProviderCooldown[] }>;
const MAX_EPOCH_MS = 253402300799999;
const dimensions = ["provider", "application", "tenant", "account"] as const;
function epoch(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MS) throw new TypeError("Unsupported provider cooldown time.");
  return value;
}
/** Rate identity only. Account keys deliberately survive grant/credential
 * rotation; a new physical row is distinct without verified quota alias proof. */
export function providerBudgetScopeKey(namespace: string, input:
  | { dimension: "provider"; provider: string }
  | { dimension: "application"; provider: string; applicationID: string }
  | { dimension: "account"; provider: string; physicalAccountRowID: string }
  | { dimension: "tenant"; provider: string; verifiedTenantID: string }) {
  const identity = input.dimension === "application" ? input.applicationID : input.dimension === "account"
    ? input.physicalAccountRowID : input.dimension === "tenant" ? input.verifiedTenantID : "";
  if (!namespace || !input.provider || input.dimension !== "provider" && !identity || [namespace, input.provider, identity].some(value => value.length > 2048)) throw new TypeError("Invalid provider budget scope.");
  return createHash("sha256").update(JSON.stringify(["provider-budget-v1", namespace, input.dimension, input.provider, identity])).digest("hex");
}
type SnapshotRow = { scope_key: string; dimension: ProviderCooldownDimension; not_before_ms: string; remaining_ms: string };
function snapshot(rows: SnapshotRow[]): ProviderCooldownSnapshot {
  return { rows: rows.map(row => ({ scope: { key: row.scope_key, dimension: row.dimension },
    notBeforeEpochMs: epoch(Number(row.not_before_ms)), minimumRemainingMs: epoch(Number(row.remaining_ms)) })) };
}
async function readSnapshot(tx: Pick<DbTransaction, "execute">, keys?: string[]) {
  const result = await tx.execute<SnapshotRow>(sql`
    with current_clock as materialized (select clock_timestamp() as at)
    select c.scope_key,c.dimension,ceil(extract(epoch from c.not_before)*1000)::text as not_before_ms,
      ceil(greatest(0,extract(epoch from c.not_before-current_clock.at))*1000)::text as remaining_ms
    from provider_budget_cooldowns c cross join current_clock
    where ${keys ? sql`c.scope_key=any(${sql.param(keys)}::text[])` : sql`c.not_before>current_clock.at`}
    order by c.scope_key`);
  return snapshot(result.rows);
}
/** Hydrate before every provider dispatch path is enabled. Remaining duration
 * is DB-derived for conservative local monotonic gates under wall-clock skew. */
export async function loadActiveProviderCooldowns(): Promise<ProviderCooldownSnapshot> {
  return readSnapshot(db);
}
/** Independent short cooldown-only transaction. Never needs a job/source lease
 * and never runs provider HTTP. Responses already observed remain real facts
 * if this persistence port fails; caller owns fail-closed readiness/flush. */
export async function extendProviderCooldowns(observations: readonly ProviderCooldownExtension[]): Promise<ProviderCooldownSnapshot> {
  const entries = new Map<string, { dimension: ProviderCooldownDimension; at: number; delay: number }>();
  for (const observation of observations) {
    epoch(observation.notBeforeEpochMs);
    const delay = epoch(observation.minimumDelayMs ?? 0);
    if (observation.scopes.length > 16) throw new TypeError("Too many provider cooldown scopes.");
    for (const scope of observation.scopes) {
      if (!/^[a-f0-9]{64}$/.test(scope.key) || !dimensions.includes(scope.dimension)) throw new TypeError("Invalid provider cooldown scope.");
      const previous = entries.get(scope.key);
      if (previous && previous.dimension !== scope.dimension) throw new TypeError("Provider cooldown dimension changed.");
      entries.set(scope.key, { dimension: scope.dimension, at: Math.max(previous?.at ?? 0, observation.notBeforeEpochMs), delay: Math.max(previous?.delay ?? 0, delay) });
    }
  }
  if (!entries.size) return { rows: [] };
  if (entries.size > 256) throw new TypeError("Too many provider cooldown scopes.");
  const keys = [...entries.keys()].sort();
  return db.transaction(async tx => {
    await tx.insert(providerBudgetCooldowns).values(keys.map(key => ({ scopeKey: key, dimension: entries.get(key)!.dimension, notBefore: new Date(0) }))).onConflictDoNothing();
    const rows = await tx.select().from(providerBudgetCooldowns).where(inArray(providerBudgetCooldowns.scopeKey, keys)).orderBy(asc(providerBudgetCooldowns.scopeKey)).for("update");
    if (rows.length !== keys.length || rows.some(row => row.dimension !== entries.get(row.scopeKey)!.dimension)) throw new Error("Provider cooldown identity changed.");
    // clock_timestamp is evaluated AFTER all row-lock waits, including inserts.
    await tx.execute(sql`with current_clock as materialized (select clock_timestamp() as at),
      supplied as (select * from unnest(${sql.param(keys)}::text[],
        ${sql.param(keys.map(key => new Date(entries.get(key)!.at).toISOString()))}::timestamptz[],
        ${sql.param(keys.map(key => entries.get(key)!.delay))}::bigint[]) as v(key,absolute_at,delay_ms))
      update provider_budget_cooldowns c set not_before=greatest(c.not_before,supplied.absolute_at,
        current_clock.at+supplied.delay_ms*interval '1 millisecond'),updated_at=current_clock.at
      from supplied,current_clock where c.scope_key=supplied.key`);
    return readSnapshot(tx, keys);
  });
}
export async function deleteExpiredProviderCooldowns(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid cooldown cleanup limit.");
  const result = await db.execute<{ scope_key: string }>(sql`delete from provider_budget_cooldowns where scope_key in (
    select scope_key from provider_budget_cooldowns where not_before<=clock_timestamp()
    order by not_before,scope_key limit ${limit} for update skip locked) returning scope_key`);
  return result.rows.length;
}
