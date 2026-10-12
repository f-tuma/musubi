import { and, eq, sql } from "drizzle-orm";
import { SyncOperationCaptureSchema } from "@musubi/types";
import { account, caldavAccounts, eventOutbox, externalCalendars, taskOutbox } from "../schema";
import type { DbTransaction } from "./calendars";
import type { EventOutboxRow } from "./event-outbox";
import type { TaskOutboxRow } from "./task-outbox";
import { decodeEventOutboxOperation, decodeTaskOutboxOperation } from "./outbox-operation";

type Target = Pick<EventOutboxRow, "calendarID" | "externalCalendarLinkID" | "provider" | "userID" | "accountID" | "externalCalendarID">;
const retirementCode = "superseded-admission-generation";
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** A source/connection change cannot erase a possible remote effect. In
 * particular, an attempting row is unsafe even after its lease expires and even
 * if an old writer left uncertain=false. Saved dispatch/read evidence also
 * remains a causal barrier. No payload or native evidence is rewritten here.
 */
function hasNoEffectEvidence(row: EventOutboxRow | TaskOutboxRow, alreadyRetired = false) {
  if (row.uncertain || row.resultRef !== null || row.remoteSnapshot !== null ||
      row.leaseToken !== null || row.leaseUntil !== null || own(row.payload, "dispatchProjection") ||
      "personalReadRecovery" in row && row.personalReadRecovery !== null) return false;
  if (alreadyRetired) return row.status === "cancelled" && row.errorCode === retirementCode;
  return ["blocked", "not-written", "retry"].includes(row.status) || row.status === "pending" && row.attempts === 0;
}

/** Caller holds the canonical/lifecycle admission locks. Take the same short
 * source/connection SHARE fence as admission, then lock candidate receipts so
 * a claim cannot race their retirement. No HTTP or ambient grant mutation.
 * An inactive connection is still an incarnation; authority is checked later
 * by dispatch and ACK, not inferred by this local no-effect retirement.
 */
export async function retireKnownUnwrittenOutboxInTransaction(tx: DbTransaction, target: Target,
  object: { kind: "event" | "task"; id: string; privacyEpoch: string }) {
  const [source] = await tx.select().from(externalCalendars).where(and(
    eq(externalCalendars.id, target.externalCalendarLinkID), eq(externalCalendars.calendarID, target.calendarID),
    eq(externalCalendars.provider, target.provider), eq(externalCalendars.userID, target.userID),
    eq(externalCalendars.accountID, target.accountID), eq(externalCalendars.externalCalendarID, target.externalCalendarID),
  )).for("share");
  if (!source) return [];
  let connection: { id: string; generation: number } | undefined;
  if (target.provider === "caldav") {
    // Only this physical credential table uses UUIDs. Legacy source/portable
    // locator keys remain opaque; without a physical account key there is no
    // connection-incarnation proof to derive, so retain the causal history.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.accountID)) return [];
    const [row] = await tx.select({ id: caldavAccounts.id, updatedAt: caldavAccounts.updatedAt }).from(caldavAccounts)
      .where(and(eq(caldavAccounts.id, target.accountID), eq(caldavAccounts.userID, target.userID))).for("share");
    if (row) connection = { id: row.id, generation: row.updatedAt.getTime() };
  } else if (target.provider === "google" || target.provider === "microsoft") {
    const [row] = await tx.select({ id: account.id, generation: sql<number>`sync_read_generation` }).from(account)
      .where(and(eq(account.userId, target.userID), eq(account.providerId, target.provider), eq(account.accountId, target.accountID))).for("share");
    if (row && Number.isSafeInteger(row.generation) && row.generation >= 0) connection = row;
  }
  if (!connection) return [];
  const table = object.kind === "event" ? eventOutbox : taskOutbox;
  const rows = await tx.select().from(table).where(and(
    eq(object.kind === "event" ? eventOutbox.eventID : taskOutbox.taskID, object.id),
    eq(table.calendarID, target.calendarID), eq(table.externalCalendarLinkID, target.externalCalendarLinkID),
    eq(table.provider, target.provider), eq(table.userID, target.userID), eq(table.accountID, target.accountID),
    eq(table.externalCalendarID, target.externalCalendarID),
    sql`(${table.status} in ('pending', 'blocked', 'not-written', 'retry') or
      (${table.status} = 'cancelled' and ${table.errorCode} = ${retirementCode}))`,
  )).orderBy(table.id).for("update");
  const retired: { id: string; action: "create" | "update" | "delete" }[] = [];
  for (const candidate of rows) {
    const row = candidate as EventOutboxRow | TaskOutboxRow;
    const decoded = object.kind === "event" ? decodeEventOutboxOperation(row as EventOutboxRow) : decodeTaskOutboxOperation(row as TaskOutboxRow);
    if (decoded.kind !== "pinned-v1") continue; // Unknown and legacy formats never acquire this proof.
    const capture = SyncOperationCaptureSchema.safeParse(row.payload.operationCapture);
    if (!capture.success || capture.data.sourceId !== source.id) continue;
    if (row.status === "cancelled") {
      if (hasNoEffectEvidence(row, true)) retired.push({ id: row.id, action: row.action });
      continue;
    }
    if (!hasNoEffectEvidence(row) || capture.data.writeGeneration === source.providerAccessRevision &&
        capture.data.privacyEpoch === object.privacyEpoch && capture.data.connectionId === connection.id &&
        capture.data.connectionGeneration === connection.generation) continue;
    await tx.update(table).set({ status: "cancelled", errorCode: retirementCode, updatedAt: new Date() }).where(eq(table.id, row.id));
    retired.push({ id: row.id, action: row.action });
  }
  return retired;
}
