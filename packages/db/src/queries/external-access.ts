import { withSyncReadTransaction } from "./read-work-transaction";
import type { SyncReadWorkExecution } from "./read-work-transaction";
import { redactGoogleCalendarMirror } from "./external-access-redaction";
import { and, eq, sql } from "drizzle-orm";
import { db } from "..";
import { calendarEvents, calendarMembers, events, externalCalendars } from "../schema";
import type { DbTransaction } from "./calendars";
import { lockCalendarLifecycle } from "./calendar-lifecycle";

export type GoogleCalendarAccessRole = "owner" | "writer" | "reader" | "writerWithoutPrivateAccess" | "unknown";
export type ExternalCalendarAccessContext = {
  provider?: "google" | "caldav" | "microsoft";
  linkID: string;
  revision: number;
  userID: string;
  accountID: string;
  externalCalendarID: string;
};

/** Local ordering of complete discovery observations, not a native ACL version. */
export async function reconcileGoogleCalendarAccess(userID: string, accountID: string, calendarID: string, accessRole: GoogleCalendarAccessRole, readWork?: SyncReadWorkExecution) {
  if (!["owner", "writer", "reader", "writerWithoutPrivateAccess", "unknown"].includes(accessRole)) throw new Error("Invalid Google access role.");
  return withSyncReadTransaction(readWork, async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "exclusive");
    const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.provider, "google"), eq(externalCalendars.userID, userID), eq(externalCalendars.accountID, accountID), eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.disabled, false), eq(externalCalendars.supportsEvents, true))).for("update");
    if (!source) throw new Error("Calendar access source changed.");
    const [member] = await tx.select().from(calendarMembers).where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID))).for("update");
    if (!member) throw new Error("Calendar access membership changed.");
    const role = ["owner", "writer"].includes(accessRole) ? "owner" : "viewer";
    if (member.role !== role) await tx.update(calendarMembers).set({ role }).where(eq(calendarMembers.id, member.id));
    if (source.providerAccessRole === accessRole && member.role === role) return false;
    await tx.update(externalCalendars).set({ providerAccessRole: accessRole, providerAccessRevision: sql`${externalCalendars.providerAccessRevision} + 1`, sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`, checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1`, cursor: null, readCoverage: null }).where(eq(externalCalendars.id, source.id));
    return role === "viewer" ? redactGoogleCalendarMirror(tx, calendarID, userID, source.id) : [calendarID];
  });
}

/** Call after the calendar lifecycle shared fence, before any imported mutation. */
export async function assertExternalCalendarAccess(tx: DbTransaction, provider: string, calendarID: string, context?: ExternalCalendarAccessContext) {
  if (!context) return;
  if (!["google", "caldav", "microsoft"].includes(provider) || (context.provider ?? "google") !== provider || !Number.isSafeInteger(context.revision) || context.revision < (provider === "caldav" ? 0 : 1)) throw new Error("Invalid calendar access context.");
  const [source] = await tx.select({ id: externalCalendars.id, role: externalCalendars.providerAccessRole }).from(externalCalendars).where(and(eq(externalCalendars.id, context.linkID), eq(externalCalendars.provider, provider), eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.userID, context.userID), eq(externalCalendars.accountID, context.accountID), eq(externalCalendars.externalCalendarID, context.externalCalendarID), eq(externalCalendars.disabled, false), (provider === "caldav" ? sql`(${externalCalendars.supportsEvents} or ${externalCalendars.supportsTasks})` : eq(externalCalendars.supportsEvents, true)), eq(externalCalendars.providerAccessRevision, context.revision)));
  if (!source) throw new Error("Calendar access changed during sync. Retry with fresh discovery.");
  if (provider === "caldav") {
    const [membership] = await tx.select({ id: calendarMembers.id }).from(calendarMembers).where(and(eq(calendarMembers.calendarID, calendarID), eq(calendarMembers.userID, context.userID), sql`exists (select 1 from caldav_accounts account where account.id::text = ${context.accountID} and account.user_id = ${context.userID})`));
    if (!membership || source.role?.startsWith("caldav:read=no;")) throw new Error("CalDAV read access is unavailable.");
  }
  return source;
}

/** All local readers of rows whose authoritative content comes from this mirror. */
export async function getGoogleMirrorReadCalendars(calendarID: string) {
  const links = await db.selectDistinct({ calendarID: calendarEvents.calendarID }).from(events)
    .innerJoin(calendarEvents, eq(calendarEvents.eventID, events.id))
    .where(eq(events.originCalendarID, calendarID));
  return [...new Set([calendarID, ...links.map(link => link.calendarID)])];
}
