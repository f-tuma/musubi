import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { eventWindow, useEventsStore } from "@/store/useEventsStore";
import { useSettingsStore } from "@/store/useSettingsStore";

export function useRefreshData() {
  const api = useApi();
  const { loadCalendars } = useCalendarsStore();
  const { loadEvents } = useEventsStore();
  const { loadSettings } = useSettingsStore();

  return async () => {
    // Triggers server-side syncUser (all providers; no-op for unconnected ones).
    // Best-effort — a sync failure must not block loading local data.
    // ponytail: endpoint is still named /calendars/google from the google-first days.
    try { await api.getGoogleCalendars(); } catch (e) { console.error("Sync failed:", e); }
    const { from, to } = eventWindow(new Date());
    const [settings, calendars, events] = await Promise.all([
      api.getSettings(), api.getCalendars(), api.getEvents(from, to),
    ]);
    loadSettings(settings); loadCalendars(calendars); loadEvents(events, from, to);
  };
}

