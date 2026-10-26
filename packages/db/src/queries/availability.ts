import { withSyncReadTransaction } from "./read-work-transaction";
import type { SyncReadWorkExecution } from "./read-work-transaction";
import { and, eq, sql } from "drizzle-orm";
import { db } from "..";
import { account, availabilityAccounts, availabilitySources } from "../schema";
import { ForbiddenError, BadRequestError, GOOGLE_AVAILABILITY_SCOPE, AvailabilitySelectionSchema } from "@musubi/types";
export const googleAvailabilityScope = (scope: string | null) => (scope ?? "").split(/[\s,]+/).some(value => [GOOGLE_AVAILABILITY_SCOPE, "https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar"].includes(value));
export type AvailabilityDiscovery = { accountID: string; generation: number; epoch: string };
export async function beginAvailabilityDiscovery(userID: string, nativeAccountID: string, readWork?: SyncReadWorkExecution): Promise<AvailabilityDiscovery | undefined> {
  return withSyncReadTransaction(readWork, async tx => {
    const [owner] = await tx.select().from(account).where(and(eq(account.userId, userID), eq(account.providerId, "google"), eq(account.accountId, nativeAccountID))).for("share");
    if (!owner?.refreshToken || owner.syncStatus !== "active") return;
    const [fence] = await tx.insert(availabilityAccounts).values({ accountID: owner.id, generation: 1 }).onConflictDoUpdate({ target: availabilityAccounts.accountID, set: { generation: sql`${availabilityAccounts.generation} + 1` } }).returning();
    return fence;
  });
}
export async function reconcileAvailabilitySources(userID: string, context: AvailabilityDiscovery, sources: { externalId: string; name: string }[], accountLabel: string, readWork?: SyncReadWorkExecution) {
  return withSyncReadTransaction(readWork, async tx => {
    const [owner] = await tx.select().from(account).where(and(eq(account.id, context.accountID), eq(account.userId, userID), eq(account.providerId, "google"))).for("share");
    const [fence] = await tx.select().from(availabilityAccounts).where(eq(availabilityAccounts.accountID, context.accountID)).for("update");
    if (!owner?.refreshToken || owner.syncStatus !== "active" || fence?.generation !== context.generation || fence.epoch !== context.epoch) return false;
    const old = await tx.select().from(availabilitySources).where(eq(availabilitySources.accountID, owner.id));
    const incoming = new Set(sources.map(s => s.externalId));
    for (const source of old) if (!incoming.has(source.externalID)) await tx.update(availabilitySources).set({ active: false, enabled: false, generation: source.generation + 1 }).where(eq(availabilitySources.id, source.id));
    for (const source of sources) await tx.insert(availabilitySources).values({ accountID: owner.id, externalID: source.externalId, label: source.name, accountLabel }).onConflictDoUpdate({ target: [availabilitySources.accountID, availabilitySources.externalID], set: { active: true, label: source.name, accountLabel, generation: sql`${availabilitySources.generation} + 1` } });
    return true;
  });
}
export async function readAvailabilitySources(userID: string) {
  return db.select({ source: availabilitySources, nativeAccountID: account.accountId, scope: account.scope, refreshToken: account.refreshToken, syncStatus: account.syncStatus, accountGeneration: availabilityAccounts.generation, accountEpoch: availabilityAccounts.epoch }).from(availabilitySources)
    .innerJoin(availabilityAccounts, eq(availabilityAccounts.accountID, availabilitySources.accountID))
    .innerJoin(account, eq(account.id, availabilitySources.accountID))
    .where(and(eq(account.userId, userID), eq(account.providerId, "google"), eq(availabilitySources.active, true)));
}
export async function listAvailabilitySources(userID: string) {
  return (await readAvailabilitySources(userID)).filter(row => !!row.refreshToken || row.syncStatus === "reconnect_required").map(({ source, scope, syncStatus }) => ({ id: source.id, generation: source.generation, label: source.label, accountLabel: source.accountLabel, enabled: source.enabled, reconnectRequired: syncStatus !== "active" || !googleAvailabilityScope(scope) }));
}
export async function setAvailabilitySelection(userID: string, id: string, input: unknown) {
  const request = AvailabilitySelectionSchema.parse(input);
  return db.transaction(async tx => {
    const [row] = await tx.select({ source: availabilitySources, owner: account }).from(availabilitySources).innerJoin(account, eq(account.id, availabilitySources.accountID)).where(and(eq(availabilitySources.id, id), eq(account.userId, userID), eq(account.providerId, "google"), eq(availabilitySources.active, true))).for("update", { of: availabilitySources });
    if (!row || (request.enabled && !row.owner.refreshToken)) throw new ForbiddenError("Availability source is not available.");
    if (row.source.generation !== request.expectedGeneration) throw new BadRequestError("Availability source changed. Refresh before choosing again.");
    await tx.update(availabilitySources).set({ enabled: request.enabled, generation: row.source.generation + 1 }).where(eq(availabilitySources.id, id));
  });
}
