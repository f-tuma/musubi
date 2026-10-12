import { sql } from "drizzle-orm";
import type { DbTransaction } from "./calendars";

/** Calendar lifecycle fence, before ALL event row locks. Namespace is the stable
 * literal `musubi:calendar-lifecycle:`. Hash collisions only reduce concurrency.
 * Acquire the complete set once; never upgrade shared locks to exclusive ones.
 * Row ordering remains event -> link/map. These locks grant no authorization. */
export async function lockCalendarLifecycle(
  tx: DbTransaction,
  calendarIDs: string[],
  mode: "shared" | "exclusive",
) {
  return lockLifecycle(tx, calendarIDs.map((id) => id.toLowerCase()), "musubi:calendar-lifecycle:", mode);
}

/** Stabilizes user-owned calendar admission/deletion, before calendar fences. */
export function lockUserLifecycle(tx: DbTransaction, userIDs: string[], mode: "shared" | "exclusive") {
  return lockLifecycle(tx, userIDs, "musubi:user-lifecycle:", mode);
}

async function lockLifecycle(tx: DbTransaction, ids: string[], namespace: string, mode: "shared" | "exclusive") {
  // Order actual lock keys, not UUIDs, so even hash collisions cannot invert order.
  const keys = await tx.execute<{ key: string }>(sql`
    select distinct hashtextextended(${namespace} || id, 0)::text as key
    from unnest(${sql.param(ids)}::text[]) as id
    order by key`);
  for (const { key } of keys.rows) {
    if (mode === "exclusive") await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    else await tx.execute(sql`select pg_advisory_xact_lock_shared(${key}::bigint)`);
  }
}
