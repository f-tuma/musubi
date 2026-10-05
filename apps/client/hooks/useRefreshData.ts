import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { getEventLifecycle, useEventsStore } from "@/store/useEventsStore";
import {
  adoptLegacyReminderRules,
  storeReminderRules,
  syncScheduledReminders,
} from "@/services/notifications";
import { useSettingsStore } from "@/store/useSettingsStore";
import { syncFederatedAccounts } from "@/services/federation";
import {
  cacheDeleteEvents,
  cacheGetAllEvents,
  cacheGetCalendars,
  cacheReplaceAllEvents,
  cacheSetCalendars,
  cacheUpsertEvents,
  getLastSync,
  setLastSync,
} from "@/services/eventsCache";
import { refreshSettingsDocument } from "@/services/settingsSync";
import { mergeHomeEventSnapshot, serializeEventRefresh } from "@/lib/eventSync";
import { widgetCalendarsLoaded, widgetEventsFailed, widgetEventsLoaded } from "@/store/useWidgetDataStore";

export function useRefreshData() {
  const api = useApi();
  return (opts?: RefreshOptions) => refreshEventData(api, opts);
}

type RefreshOptions = {
  providerSync?: boolean;
  full?: boolean;
  settingsOnly?: boolean;
};

export function refreshEventData(
  api: ReturnType<typeof useApi>,
  opts?: RefreshOptions,
) {
  const lifecycle = getEventLifecycle();
  const isCurrent = () => lifecycle === getEventLifecycle();
  const { loadCalendars } = useCalendarsStore.getState();
  const { loadEvents } = useEventsStore.getState();

  // providerSync=false: skip triggering the server-side provider sync — used by
  // the SSE "external_sync" handler, where the server JUST synced (re-triggering
  // would loop) and the delta below picks up exactly what changed.
  // full=true forces an authoritative home event snapshot after launch,
  // reconnect, or joining a calendar. Cached federated events are retained until
  // their origin server can provide its own authoritative snapshot.
  return serializeEventRefresh(async () => {
    if (!isCurrent()) return;
    // Load settings FIRST and independently: the onboarding gate (and theme)
    // depend on `onboarded` arriving. It must not be held hostage to the
    // events/calendar pipeline below — a throw there used to leave `onboarded`
    // at its default (true), silently skipping onboarding for new users.
    try {
      await refreshSettingsDocument(api);
    } catch (e) {
      console.error("Settings load failed:", e);
    }
    if (opts?.settingsOnly || !isCurrent()) return;

    if (opts?.providerSync !== false) {
      // trigger server-side provider sync first, so its imported/changed events
      // show up in the delta below (best-effort, no-op for unconnected providers)
      try {
        await api.syncProviderCalendars();
      } catch (e) {
        console.error("Sync failed:", e);
      }
    }

    // delta: only events changed since our last sync (+ tombstones to drop).
    // Tolerate a garbage stored value → fall back to a full sync (self-heals).
    const lastSync = opts?.full ? null : await getLastSync();
    const sinceDate = lastSync ? new Date(lastSync) : null;
    const since =
      sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : undefined;
    const { events, deletedIds, serverTime } = await api.getEvents(since);
    const cachedCalendars = await cacheGetCalendars().catch(error => {
      console.warn("Calendar cache could not hydrate; rebuilding from server:", error);
      return useCalendarsStore.getState().calendars;
    });
    if (!isCurrent()) return;
    // Membership is required to reconcile these rows. If its read fails, keep
    // the valid cache intact rather than persisting links we may have lost.
    const homeCalendars = await api.getCalendars();
    if (!isCurrent()) return;
    if (since === undefined) {
      const cachedEvents = await cacheGetAllEvents().catch(error => {
        console.warn("Event cache could not hydrate; rebuilding from server:", error);
        return useEventsStore.getState().events;
      });
      if (!isCurrent()) return;
      await cacheReplaceAllEvents(
        mergeHomeEventSnapshot(events, cachedEvents, cachedCalendars),
      );
    } else {
      await cacheUpsertEvents(events);
      if (!isCurrent()) return;
      await cacheDeleteEvents(deletedIds);
    }
    if (!isCurrent()) return;
    await setLastSync(serverTime);

    // Pull shared calendars + events from each connected Musubi server through
    // the home gateway (v1: full fetch — no delta). The registry is refreshed
    // from the home server inside, falling back to the offline cache; token
    // rotation now happens server-side (ADR-005). A server that's down keeps
    // its last-cached calendars so the reconcile below doesn't wipe local copies.
    if (!isCurrent()) return;
    const fed = await syncFederatedAccounts(cachedCalendars);
    if (!isCurrent()) return;
    if (fed.syncedServers.size) {
      // full-set semantics per synced server: cached events living only in that
      // server's calendars and absent from the fresh pull were deleted remotely
      const syncedCalIds = new Set(
        fed.calendars
          .filter((c) => c.serverUrl && fed.syncedServers.has(c.serverUrl))
          .map((c) => c.id),
      );
      const fetchedIds = new Set(fed.events.map((e) => e.id));
      const cachedNow = await cacheGetAllEvents();
      if (!isCurrent()) return;
      const staleRemote = cachedNow
        .filter(
          (e) =>
            (e.calendars?.length ?? 0) > 0 &&
            e.calendars.every((id) => syncedCalIds.has(id)) &&
            !fetchedIds.has(e.id),
        )
        .map((e) => e.id);
      if (staleRemote.length) await cacheDeleteEvents(staleRemote);
    }
    if (!isCurrent()) return;
    if (fed.events.length) await cacheUpsertEvents(fed.events);

    if (!isCurrent()) return;
    const calendars = [...homeCalendars, ...fed.calendars];
    loadCalendars(calendars);
    widgetCalendarsLoaded(true);
    const all = await cacheGetAllEvents();
    if (!isCurrent()) return;

    // Reconcile against membership: an offline kick sends no SSE and the delta
    // can't tombstone events we merely lost access to — drop links to calendars
    // we're no longer in, and events left with none.
    const memberOf = new Set(calendars.map((c) => c.id));
    const dropped: string[] = [];
    const fixed: typeof all = [];
    const kept: typeof all = [];
    for (const e of all) {
      const cals = e.calendars?.filter((id) => memberOf.has(id)) ?? [];
      if (cals.length === 0) {
        dropped.push(e.id);
        continue;
      }
      if (cals.length !== e.calendars.length) {
        const updated = { ...e, calendars: cals };
        fixed.push(updated);
        kept.push(updated);
      } else kept.push(e);
    }
    if (dropped.length) await cacheDeleteEvents(dropped);
    if (!isCurrent()) return;
    if (fixed.length) await cacheUpsertEvents(fixed);

    if (!isCurrent()) return;
    loadEvents(kept, { reconciled: true });
    await cacheSetCalendars(calendars);
    if (isCurrent()) widgetEventsLoaded(Date.now());

    // Rules first, then reschedule: they are what decides which of these events
    // ring at all, and a stale document would schedule the previous answer.
    // Best-effort — the cached rules stand in when the request fails.
    try {
      const reminders = await api.getReminders();
      if (!isCurrent()) return;
      if (reminders) {
        await storeReminderRules(reminders);
      } else {
        // null, not a throw: this server predates reminder rules. Fall back to
        // the one thing it does say, or the phone schedules nothing at all and
        // a feature that worked before the app update silently stops.
        await adoptLegacyReminderRules(
          useSettingsStore.getState().notificationsOnByDefault,
        );
      }
    } catch (e) {
      console.error("Reminder rules load failed:", e);
    }
    // fire-and-forget: drop reminders of gone events, refresh the rest
    if (!isCurrent()) return;
    syncScheduledReminders(useEventsStore.getState().events).catch(() => {});
  }).catch(error => {
    if (isCurrent() && !opts?.settingsOnly) widgetEventsFailed();
    throw error;
  });
}
