import { Event } from "@musubi/types";
import {
  clearCalendarEvents,
  deleteExternalEvent,
  doesExternalCalIDExist,
  getExternalEventID,
  getExternalLinkForCalendar,
  getUserExternalCalendars,
  importExternalCalendar,
  importExternalEvent,
  removeCalendar,
  setCursor,
  upsertExternalEvent,
} from "@musubi/db";
import { CalendarAdapter, NormalizedEvent } from "./adapter";
import { googleAdapter } from "./adapters/google";
import { caldavAdapter } from "./adapters/caldav";

// provider -> adapter. Register new providers here.
const adapters: Record<string, CalendarAdapter> = {
  google: googleAdapter,
  caldav: caldavAdapter,
  // microsoft: microsoftAdapter,   // (next)
};

export function getAdapter(provider: string): CalendarAdapter | null {
  return adapters[provider] ?? null;
}

// NormalizedEvent -> the primitive column values the DB layer expects.
// (organizer is NOT NULL in the schema; color comes from the calendar.)
function toEventValues(n: NormalizedEvent, calColor: string) {
  return {
    title: n.title,
    color: calColor,
    start: n.start,
    end: n.end,
    isAllDay: n.isAllDay,
    description: n.description,
    location: n.location,
    organizer: n.organizer ?? "",
    recurrence: n.recurrence,
    url: n.url,
  };
}

// Pull: reconcile calendars, then pull each calendar's changes into Musubi.
export async function syncProvider(adapter: CalendarAdapter, userID: string) {
  const provider = adapter.provider;

  // 1. reconcile the calendar list
  const remote = await adapter.listCalendars(userID);
  const remoteIDs = new Set(remote.map((c) => c.externalId));

  // remote calendar gone -> drop the Musubi mirror (removeCalendar handles orphan events)
  for (const link of await getUserExternalCalendars(provider, userID)) {
    if (!remoteIDs.has(link.externalCalendarID)) {
      await removeCalendar(link.calendarID);
    }
  }
  // new remote calendar -> import
  for (const cal of remote) {
    if (!(await doesExternalCalIDExist(provider, userID, cal.externalId))) {
      await importExternalCalendar(provider, userID, cal);
    }
  }

  // 2. pull events per (now reconciled) calendar
  for (const link of await getUserExternalCalendars(provider, userID)) {
    const { changes, nextCursor, reset } = await adapter.fetchChanges(
      userID,
      link.externalCalendarID,
      link.cursor,
    );

    if (reset) await clearCalendarEvents(link.calendarID);

    for (const ev of changes) {
      if (ev.status === "cancelled") {
        await deleteExternalEvent(provider, link.externalCalendarID, ev.externalId);
      } else {
        await upsertExternalEvent(
          provider,
          userID,
          link.calendarID,
          link.externalCalendarID,
          ev.externalId,
          toEventValues(ev, link.calColor),
          ev.etag ?? null,
        );
      }
    }

    await setCursor(link.calendarID, nextCursor);
  }
}

// Sync every registered provider the user is connected to. A provider the user
// hasn't connected throws in listCalendars (no credentials) and is skipped.
// ponytail: try-each is wasteful for unconnected providers; add a per-provider
// isConnected() check if provider count grows.
export async function syncUser(userID: string) {
  for (const adapter of Object.values(adapters)) {
    try {
      await syncProvider(adapter, userID);
    } catch (e) {
      console.error(`Sync ${adapter.provider} failed:`, e);
    }
  }
}

// Push a Musubi event out to every provider-linked calendar it belongs to.
// For "delete", the caller MUST invoke this BEFORE removing the Musubi event,
// so the external mapping is still present to look up.
export async function pushEventToProviders(event: Event, action: "create" | "update" | "delete") {
  for (const calendarID of event.calendars) {
    const link = await getExternalLinkForCalendar(calendarID);
    if (!link) continue;
    const adapter = getAdapter(link.provider);
    if (!adapter) continue;

    try {
      if (action === "create") {
        const { externalEventId } = await adapter.pushCreate(link.userID, link.externalCalendarID, event);
        await importExternalEvent(link.provider, event.id, link.externalCalendarID, externalEventId);
      } else {
        const externalEventId = await getExternalEventID(link.provider, event.id, link.externalCalendarID);
        if (!externalEventId) continue;
        if (action === "update") {
          await adapter.pushUpdate(link.userID, link.externalCalendarID, externalEventId, event);
        } else {
          await adapter.pushDelete(link.userID, link.externalCalendarID, externalEventId);
        }
      }
    } catch (e) {
      console.error(`Push (${action}) to ${link.provider} failed:`, e);
    }
  }
}
