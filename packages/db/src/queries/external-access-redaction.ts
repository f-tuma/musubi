import { markGooglePersonalReadRedaction } from "./google-personal-read-recovery";
import { and, eq, inArray, sql } from "drizzle-orm";
import { calendarEvents, calendarTasks, calendars, events, externalEvents, externalTasks, tasks, pendingNotifications } from "../schema";
import type { DbTransaction } from "./calendars";

/** Under the source calendar's exclusive lifecycle fence. Keep native identity,
 * temporal meaning and private pending intents; retire only the readable mirror.
 * Refresh must establish what the narrower native grant still allows reading. */
export async function redactGoogleCalendarMirror(tx: DbTransaction, calendarID: string, userID: string, sourceID: string, provider: "google" | "microsoft" | "caldav" = "google") {
  const [calendar] = await tx.select({ color: calendars.color }).from(calendars).where(eq(calendars.id, calendarID));
  if (!calendar) throw new Error("Calendar access source changed.");
  const rows = await tx.select().from(events).where(and(eq(events.originCalendarID, calendarID), eq(events.creatorID, userID), sql`exists (select 1 from ${externalEvents} where (${externalEvents.eventID} = ${events.id} or (${provider} in ('microsoft', 'caldav') and ${externalEvents.eventID} = ${events.seriesID})) and ${externalEvents.calendarID} = ${calendarID} and ${externalEvents.provider} = ${provider})`)).orderBy(events.id).for("update");
  const taskReadCalendars: string[] = [];
  {
    const taskIDs = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.originCalendarID, calendarID), sql`exists (select 1 from ${externalTasks} where ${externalTasks.taskID} = ${tasks.id} and ${externalTasks.provider} = ${provider} and ${externalTasks.calendarID} = ${calendarID})`)).orderBy(tasks.id).for("update");
    if (taskIDs.length) {
      const links = await tx.select({ calendarID: calendarTasks.calendarID }).from(calendarTasks).where(inArray(calendarTasks.taskID, taskIDs.map(task => task.id)));
      taskReadCalendars.push(...links.map(link => link.calendarID));
      await tx.update(tasks).set({ title: "Private task", description: null, url: null, relatedTo: null, revision: sql`${tasks.revision} + 1`, providerReadRetiredGeneration: sql`coalesce(${tasks.providerReadRetiredGeneration}, 0) + 1` }).where(inArray(tasks.id, taskIDs.map(task => task.id)));
      await tx.update(externalTasks).set({ etag: null, projectionBaseline: null }).where(and(eq(externalTasks.provider, provider), eq(externalTasks.calendarID, calendarID), inArray(externalTasks.taskID, taskIDs.map(task => task.id))));
    }
  }
  if (!rows.length) return [...new Set([calendarID, ...taskReadCalendars])];
  if (provider === "google") for (const row of rows) await markGooglePersonalReadRedaction(tx, row, sourceID);
  const ids = rows.map(row => row.id);
  const links = await tx.select({ calendarID: calendarEvents.calendarID }).from(calendarEvents).where(inArray(calendarEvents.eventID, ids));
  await tx.update(events).set({ providerReadRetiredRevision: sql`greatest(coalesce(${events.providerReadRetiredRevision}, 0), ${events.revision} + 1)`, title: "Busy", description: null, location: null, organizer: "", url: null, color: calendar.color, revision: sql`${events.revision} + 1` }).where(inArray(events.id, ids));
  // Invalidating the validator also forces a same-ETag fresh observation through
  // normal import. A saved outbox baseline is never a source of restoration.
  await tx.update(externalEvents).set({ etag: null, providerState: null, providerStateObservedAt: null, readRedactionRevision: sql`(select ${events.revision} from ${events} where ${events.id} = ${externalEvents.eventID})` }).where(and(eq(externalEvents.provider, provider), eq(externalEvents.calendarID, calendarID), inArray(externalEvents.eventID, ids)));
  await tx.delete(pendingNotifications).where(and(eq(pendingNotifications.kind, "event_changed"), inArray(pendingNotifications.subjectID, ids)));
  return [...new Set([calendarID, ...taskReadCalendars, ...links.map(link => link.calendarID)])];
}
