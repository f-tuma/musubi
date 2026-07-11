import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { reconcileEventNotifications } from "@/services/notifications";
import { setFederatedAccounts, syncFederatedAccounts } from "@/services/federation";
import { cacheDeleteEvents, cacheGetAllEvents, cacheGetCalendars, cacheReplaceAllEvents, cacheSetCalendars, cacheUpsertEvents, getLastSync, setLastSync } from "@/services/eventsCache";

export function useRefreshData() {
  const api = useApi();
  const { loadCalendars } = useCalendarsStore();
  const { loadEvents } = useEventsStore();
  const { loadSettings } = useSettingsStore();

  return async () => {
    // trigger server-side provider sync first, so its imported/changed events
    // show up in the delta below (best-effort, no-op for unconnected providers)
    try { await api.getGoogleCalendars(); } catch (e) { console.error("Sync failed:", e); }

    // delta: only events changed since our last sync (+ tombstones to drop).
    // Tolerate a garbage stored value → fall back to a full sync (self-heals).
    const lastSync = await getLastSync();
    const sinceDate = lastSync ? new Date(lastSync) : null;
    const since = sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : undefined;
    const { events, deletedIds, serverTime } = await api.getEvents(since);
    if (since === undefined) {
      await cacheReplaceAllEvents(events); // full sync = authoritative, drops any drift
    } else {
      await cacheUpsertEvents(events);
      await cacheDeleteEvents(deletedIds);
    }
    await setLastSync(serverTime);

    const [settings, homeCalendars] = await Promise.all([
      api.getSettings(),
      api.getCalendars(),
    ]);
    loadSettings(settings);

    // Federated servers: the registry's source of truth is the HOME server
    // (connections roam across devices); SecureStore is the offline fallback.
    try { await setFederatedAccounts(await api.getMusubiAccounts()); }
    catch { /* home unreachable or pre-federation server → cached registry */ }
    // Pull shared calendars + events from each connected Musubi server (v1:
    // full fetch — no delta). A server that's down keeps its last-cached
    // calendars so the reconcile below doesn't wipe local copies.
    const fed = await syncFederatedAccounts(await cacheGetCalendars());
    if (fed.syncedServers.size) {
      // full-set semantics per synced server: cached events living only in that
      // server's calendars and absent from the fresh pull were deleted remotely
      const syncedCalIds = new Set(
        fed.calendars.filter(c => c.serverUrl && fed.syncedServers.has(c.serverUrl)).map(c => c.id));
      const fetchedIds = new Set(fed.events.map(e => e.id));
      const cachedNow = await cacheGetAllEvents();
      const staleRemote = cachedNow
        .filter(e => (e.calendars?.length ?? 0) > 0
          && e.calendars.every(id => syncedCalIds.has(id))
          && !fetchedIds.has(e.id))
        .map(e => e.id);
      if (staleRemote.length) await cacheDeleteEvents(staleRemote);
    }
    if (fed.events.length) await cacheUpsertEvents(fed.events);

    const calendars = [...homeCalendars, ...fed.calendars];
    loadCalendars(calendars);
    const all = await cacheGetAllEvents();

    // Reconcile against membership: an offline kick sends no SSE and the delta
    // can't tombstone events we merely lost access to — drop links to calendars
    // we're no longer in, and events left with none.
    const memberOf = new Set(calendars.map(c => c.id));
    const dropped: string[] = [];
    const fixed: typeof all = [];
    const kept: typeof all = [];
    for (const e of all) {
      const cals = e.calendars?.filter(id => memberOf.has(id)) ?? [];
      if (cals.length === 0) { dropped.push(e.id); continue; }
      if (cals.length !== e.calendars.length) {
        const updated = { ...e, calendars: cals };
        fixed.push(updated); kept.push(updated);
      } else kept.push(e);
    }
    if (dropped.length) await cacheDeleteEvents(dropped);
    if (fixed.length) await cacheUpsertEvents(fixed);

    loadEvents(kept);
    cacheSetCalendars(calendars);
    // fire-and-forget: drop reminders of gone events, refresh the rest
    reconcileEventNotifications(kept).catch(() => { });
  };
}
