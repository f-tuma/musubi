import { Event } from "@musubi/types";
import { logger } from "@musubi/config";
import {
  deleteExternalEvent,
  getCalendarMembers,
  getExternalEventID,
  getDisabledExternalCalendarIDs,
  getExternalLinkForCalendar,
  getUserExternalCalendars,
  importExternalCalendar,
  importExternalEvent,
  removeCalendar,
  setAccountLabel,
  setCursor,
  setMemberRole,
  sweepExternalEvents,
  upsertExternalEvent,
} from "@musubi/db";
import { notifyCalendarMembers } from "../handlers/stream";
import { CalendarAdapter, NormalizedEvent } from "./adapter";
import { googleAdapter } from "./adapters/google";
import { caldavAdapter } from "./adapters/caldav";
import { microsoftAdapter } from "./adapters/microsoft";
import { providerAuthErrorFields } from "./errors";
import { recordExternalSyncFailure } from "../metrics";

// provider -> adapter. Register new providers here.
const adapters: Record<string, CalendarAdapter> = {
  google: googleAdapter,
  caldav: caldavAdapter,
  microsoft: microsoftAdapter,
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
  const startedAt = performance.now();
  const provider = adapter.provider;
  const accountId = account.id;

  logger.debug("sync.account.started", { provider, userId: userID, accountId });

  // keep the human label fresh on this account's calendars
  await setAccountLabel(provider, userID, accountId, account.label);

  // 1. reconcile the calendar list
  const remote = await adapter.listCalendars(userID, accountId);
  const remoteIDs = new Set(remote.map((c) => c.externalId));
  logger.debug("sync.account.calendars_discovered", {
    provider,
    userId: userID,
    accountId,
    calendars: remote.length,
  });

  // remote calendar gone -> drop the Musubi mirror (removeCalendar handles orphan events)
  for (const link of await getUserExternalCalendars(provider, userID, accountId)) {
    if (!remoteIDs.has(link.externalCalendarID)) {
      await removeCalendar(link.calendarID);
    }
  }
  // new remote calendar -> import; existing -> keep the read-only flag fresh
  // (also self-heals calendars imported before readOnly existed, e.g. holidays)
  const links = await getUserExternalCalendars(provider, userID, accountId);
  const disabled = new Set(await getDisabledExternalCalendarIDs(provider, userID, accountId));
  for (const cal of remote) {
    if (disabled.has(cal.externalId)) continue; // user opted this calendar out of sync
    const desiredRole = cal.readOnly ? "viewer" : "owner";
    const link = links.find((l) => l.externalCalendarID === cal.externalId);
    if (!link) {
      await importExternalCalendar(provider, userID, accountId, account.label, cal, desiredRole);
    } else {
      await setMemberRole(userID, link.calendarID, desiredRole);
    }
  }

  // 2. pull events per (now reconciled) calendar. Track which calendars really
  // changed so the scheduled sync can wake connected clients — the etag-aware
  // upsert makes a CalDAV full-fetch a quiet no-op when nothing moved.
  const changedCalendarIDs: string[] = [];
  for (const link of await getUserExternalCalendars(provider, userID, accountId)) {
    const calendarStartedAt = performance.now();
    const { changes, nextCursor, reset } = await adapter.fetchChanges(
      userID,
      accountId,
      link.externalCalendarID,
      link.cursor,
    );

    let changed = 0;
    const seen: string[] = [];
    for (const ev of changes) {
      if (ev.status === "cancelled") {
        if (await deleteExternalEvent(provider, link.calendarID, ev.externalId)) changed++;
      } else {
        seen.push(ev.externalId);
        if (await upsertExternalEvent(
          provider,
          userID,
          link.calendarID,
          link.externalCalendarID,
          ev.externalId,
          toEventValues(ev, link.calColor),
          ev.etag ?? null,
        )) changed++;
      }
    }

    // reset = the fetch was the FULL set (CalDAV always, Google after 410):
    // events missing from it were deleted on the provider — tombstone them.
    if (reset) changed += await sweepExternalEvents(provider, link.calendarID, seen);

    if (changed > 0) changedCalendarIDs.push(link.calendarID);
    await setCursor(link.calendarID, nextCursor);
    logger.debug("sync.calendar.completed", {
      provider,
      userId: userID,
      accountId,
      calendarId: link.calendarID,
      fetchedEvents: changes.length,
      changedEvents: changed,
      fullSet: !!reset,
      durationMs: Math.round((performance.now() - calendarStartedAt) * 10) / 10,
    });
  }
  logger.debug("sync.account.completed", {
    provider,
    userId: userID,
    accountId,
    calendars: remote.length,
    changedCalendars: changedCalendarIDs.length,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
  });
  return changedCalendarIDs;
}

// Sync every connected account of every registered provider. listAccounts returns
// [] when the provider isn't connected, so unconnected providers are a clean no-op.
// When anything actually changed, the affected calendars' members get an SSE
// "external_sync" nudge — connected clients run a silent delta refresh, which is
// what makes provider changes land in the app without a manual pull-to-refresh.
type SyncUserOptions = {
  /** Limit a strict, user-triggered sync to the account that initiated it. */
  provider?: string;
  accountId?: string;
  /** Scheduled sync stays best-effort; connect flows use this to fail loudly. */
  throwOnError?: boolean;
};

export async function syncUser(userID: string, options: SyncUserOptions = {}) {
  const changedCalendarIDs: string[] = [];
  for (const adapter of Object.values(adapters)) {
    if (options.provider && adapter.provider !== options.provider) continue;

    let accounts: { id: string; label: string }[];
    try {
      accounts = await adapter.listAccounts(userID);
    } catch (e) {
      recordExternalSyncFailure("discovery", adapter.provider);
      logger.error("sync.provider.failed", {
        provider: adapter.provider,
        userId: userID,
        error: e,
        ...providerAuthErrorFields(e),
      });
      if (options.throwOnError) throw e;
      continue;
    }

    for (const account of accounts) {
      if (options.accountId && account.id !== options.accountId) continue;
      try {
        changedCalendarIDs.push(...await syncProvider(adapter, userID, account));
      } catch (e) {
        recordExternalSyncFailure("account", adapter.provider);
        logger.error("sync.account.failed", {
          provider: adapter.provider,
          userId: userID,
          accountId: account.id,
          error: e,
          ...providerAuthErrorFields(e),
        });
        if (options.throwOnError) throw e;
      }
    }
  }

  if (changedCalendarIDs.length > 0) {
    const memberIDs = new Set<string>();
    for (const cal of changedCalendarIDs) {
      for (const m of await getCalendarMembers(cal)) memberIDs.add(m.userID);
    }
    notifyCalendarMembers([...memberIDs], "external_sync", { calendars: changedCalendarIDs });
  }
  return changedCalendarIDs;
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
        await importExternalEvent(link.provider, event.id, calendarID, link.externalCalendarID, externalEventId);
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
      recordExternalSyncFailure("push", link.provider);
      logger.error("sync.push.failed", {
        action,
        provider: link.provider,
        userId: link.userID,
        accountId: link.accountID,
        calendarId: calendarID,
        eventId: event.id,
        error: e,
      });
    }
  }
}
