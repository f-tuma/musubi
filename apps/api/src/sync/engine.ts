import { Event } from "@musubi/types";
import {
  clearCalendarEvents,
  deleteExternalEvent,
  getExternalEventID,
  getExternalLinkForCalendar,
  getUserExternalCalendars,
  importExternalCalendar,
  importExternalEvent,
  removeCalendar,
  setAccountLabel,
  setCursor,
  setMemberRole,
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

// Pull: reconcile calendars, then pull each calendar's changes into Musubi. Scoped
// to ONE connected account of the provider.
export async function syncProvider(
  adapter: CalendarAdapter,
  userID: string,
  account: { id: string; label: string },
) {
  const provider = adapter.provider;
  const accountId = account.id;

  // keep the human label fresh on this account's calendars
  await setAccountLabel(provider, userID, accountId, account.label);

  // 1. reconcile the calendar list
  const remote = await adapter.listCalendars(userID, accountId);
  const remoteIDs = new Set(remote.map((c) => c.externalId));

  // remote calendar gone -> drop the Musubi mirror (removeCalendar handles orphan events)
  for (const link of await getUserExternalCalendars(provider, userID, accountId)) {
    if (!remoteIDs.has(link.externalCalendarID)) {
      await removeCalendar(link.calendarID);
    }
  }
  // new remote calendar -> import; existing -> keep the read-only flag fresh
  // (also self-heals calendars imported before readOnly existed, e.g. holidays)
  const links = await getUserExternalCalendars(provider, userID, accountId);
  for (const cal of remote) {
    const desiredRole = cal.readOnly ? "viewer" : "owner";
    const link = links.find((l) => l.externalCalendarID === cal.externalId);
    if (!link) {
      await importExternalCalendar(provider, userID, accountId, account.label, cal, desiredRole);
    } else {
      await setMemberRole(userID, link.calendarID, desiredRole);
    }
  }

  // 2. pull events per (now reconciled) calendar
  for (const link of await getUserExternalCalendars(provider, userID, accountId)) {
    const { changes, nextCursor, reset } = await adapter.fetchChanges(
      userID,
      accountId,
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

// Sync every connected account of every registered provider. listAccounts returns
// [] when the provider isn't connected, so unconnected providers are a clean no-op.
export async function syncUser(userID: string) {
  for (const adapter of Object.values(adapters)) {
    try {
      for (const account of await adapter.listAccounts(userID)) {
        await syncProvider(adapter, userID, account);
      }
    } catch (e) {
      console.error(`Sync ${adapter.provider} failed:`, e);
    }
  }
}

// Push a Musubi event out to every provider-linked calendar it belongs to.
// For "delete", the caller MUST invoke this BEFORE removing the Musubi event,
// so the external mapping is still present to look up.
export async function pushEventToProviders(event: Event, action: "create" | "update" | "delete") {
  return pushEventToCalendars(event, event.calendars, action);
}

// Push an event to a specific set of calendars (used by update to reconcile the
// diff: "delete" for removed calendars, "create" for added, "update" for kept).
export async function pushEventToCalendars(event: Event, calendarIDs: string[], action: "create" | "update" | "delete") {
  for (const calendarID of calendarIDs) {
    const link = await getExternalLinkForCalendar(calendarID);
    if (!link) continue;
    const adapter = getAdapter(link.provider);
    if (!adapter) continue;

    try {
      if (action === "create") {
        const { externalEventId } = await adapter.pushCreate(link.userID, link.accountID, link.externalCalendarID, event);
        await importExternalEvent(link.provider, event.id, link.externalCalendarID, externalEventId);
      } else {
        const externalEventId = await getExternalEventID(link.provider, event.id, link.externalCalendarID);
        if (!externalEventId) continue;
        if (action === "update") {
          await adapter.pushUpdate(link.userID, link.accountID, link.externalCalendarID, externalEventId, event);
        } else {
          await adapter.pushDelete(link.userID, link.accountID, link.externalCalendarID, externalEventId);
        }
      }
    } catch (e) {
      console.error(`Push (${action}) to ${link.provider} failed:`, e);
    }
  }
}
