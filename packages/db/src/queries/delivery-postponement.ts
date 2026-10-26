import { sql } from "drizzle-orm";
import { db } from "..";
import { eventOutbox, taskOutbox, outlookMoves } from "../schema";
import type { OutlookMoveRow } from "./outlook-moves";

// Only this closed table map supplies SQL identifiers; callers supply data only.
const journals = {
  event: { table: eventOutbox, id: eventOutbox.id, status: eventOutbox.status,
    token: eventOutbox.leaseToken, lease: eventOutbox.leaseUntil, due: eventOutbox.nextAttemptAt,
    updated: eventOutbox.updatedAt, active: "attempting" },
  task: { table: taskOutbox, id: taskOutbox.id, status: taskOutbox.status,
    token: taskOutbox.leaseToken, lease: taskOutbox.leaseUntil, due: taskOutbox.nextAttemptAt,
    updated: taskOutbox.updatedAt, active: "attempting" },
  move: { table: outlookMoves, id: outlookMoves.id, status: outlookMoves.status,
    token: outlookMoves.leaseToken, lease: outlookMoves.leaseUntil, due: outlookMoves.nextAttemptAt,
    updated: outlookMoves.updatedAt, active: "running" },
} as const;
/** Park metadata preserves the exact native continuation's claim, uncertainty,
 * accepted facts and immutable journal. No provider HTTP under the short lock. */
async function postpone(kind: keyof typeof journals, id: string, token: string | null, retryAtMs: number) {
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253402300799999) throw new TypeError("Invalid delivery retry time.");
  if (!token) return false;
  const j = journals[kind];
  return db.transaction(async tx => {
    await tx.execute(sql`select ${j.id} from ${j.table} where ${j.id}=${id} for update`);
    // Fresh statement: an expiry during the actual lock wait cannot postpone.
    const result = await tx.execute<{ id: string }>(sql`update ${j.table}
      set ${sql.identifier(j.due.name)}=greatest(${j.due},${new Date(retryAtMs).toISOString()}::timestamptz),
        ${sql.identifier(j.updated.name)}=clock_timestamp()
      where ${j.id}=${id} and ${j.status}=${j.active} and ${j.token}=${token}
        and ${j.lease}>clock_timestamp() returning ${j.id} as id`);
    return result.rows.length === 1;
  });
}
export function postponeEventOutbox(id: string, token: string, retryAtMs: number) {
  return postpone("event", id, token, retryAtMs);
}
export function postponeTaskOutbox(id: string, token: string, retryAtMs: number) {
  return postpone("task", id, token, retryAtMs);
}
export function postponeOutlookMove(row: Pick<OutlookMoveRow, "id" | "leaseToken">, retryAtMs: number) {
  return postpone("move", row.id, row.leaseToken, retryAtMs);
}
