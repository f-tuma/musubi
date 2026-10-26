import { withSyncReadTransaction } from "./read-work-transaction";
import type { SyncReadWorkExecution } from "./read-work-transaction";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "..";
import { account, caldavAccounts, calendarEvents, calendarMembers, events, externalCalendars } from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { lockCalendarRemovalEvents, removeCalendarInTransaction } from "./calendars";
import { redactGoogleCalendarMirror } from "./external-access-redaction";

/** Only call after authoritative provider collection discovery completes. Candidates
 * carry the source identity observed by that discovery's reconciliation pass. */
export async function removeGoogleCalendarMirrors(
  userID: string,
  accountID: string,
  candidates: { sourceID: string; calendarID: string; externalCalendarID: string }[],
  provider: "google" | "microsoft" | "caldav" = "google",
  readWork?: SyncReadWorkExecution,
) {
  if (!candidates.length) return { calendarIDs: [], userIDs: [] };
  return withSyncReadTransaction(readWork, async tx => {
    await lockCalendarLifecycle(tx, candidates.map(source => source.calendarID), "exclusive");
    const sources = await tx.select().from(externalCalendars).where(and(
      eq(externalCalendars.provider, provider), eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID), eq(externalCalendars.disabled, false),
      provider === "caldav" ? undefined : eq(externalCalendars.supportsEvents, true),
      provider === "caldav" ? sql`exists (select 1 from ${caldavAccounts} where ${caldavAccounts.id}::text = ${accountID} and ${caldavAccounts.userID} = ${userID})` : sql`exists (select 1 from ${account} where ${account.userId} = ${userID}
        and ${account.providerId} = ${provider} and ${account.accountId} = ${accountID}
        and ${account.syncStatus} = 'active')`,
      or(...candidates.map(source => and(eq(externalCalendars.id, source.sourceID),
        eq(externalCalendars.calendarID, source.calendarID),
        eq(externalCalendars.externalCalendarID, source.externalCalendarID)))),
    ));
    const calendarIDs = sources.flatMap(source => source.calendarID ? [source.calendarID] : []);
    if (!calendarIDs.length) return { calendarIDs: [], userIDs: [] };
    // Lock the full union before either redaction or removal locks any subset.
    await lockCalendarRemovalEvents(tx, calendarIDs);
    const links = await tx.select({ calendarID: calendarEvents.calendarID }).from(calendarEvents).where(sql`${calendarEvents.eventID} in (
      select ${events.id} from ${events} where ${inArray(events.originCalendarID, calendarIDs)}
      or ${events.id} in (select ${calendarEvents.eventID} from ${calendarEvents} where ${inArray(calendarEvents.calendarID, calendarIDs)})
    )`);
    const affected = [...new Set([...calendarIDs, ...links.map(link => link.calendarID)])];
    const members = await tx.select({ userID: calendarMembers.userID }).from(calendarMembers).where(inArray(calendarMembers.calendarID, affected));
    for (const source of sources) {
      if (!source.calendarID) continue;
      await redactGoogleCalendarMirror(tx, source.calendarID, userID, source.id, provider);
      await removeCalendarInTransaction(tx, source.calendarID);
    }
    // Return invalidation addresses, never a removed calendar's private DTO.
    return { calendarIDs: affected, userIDs: [...new Set([userID, ...members.map(member => member.userID)])] };
  });
}
