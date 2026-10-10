import { create } from "zustand";

// Screen readiness is independent: a failed cache read may dismiss the loading
// overlay, but it must never authorize an empty launcher snapshot.
export const useWidgetDataStore = create<{
  eventsReady: boolean;
  calendarsReady: boolean;
  calendarsAuthoritative: boolean;
  lastSyncAt: number | null;
  error: boolean;
}>(() => ({ eventsReady: false, calendarsReady: false, calendarsAuthoritative: false, lastSyncAt: null, error: false }));

export function widgetCalendarsLoaded(authoritative = false) {
  useWidgetDataStore.setState(state => ({ calendarsReady: true,
    calendarsAuthoritative: state.calendarsAuthoritative || authoritative }));
}

export function widgetEventsLoaded(lastSyncAt: number | null) {
  useWidgetDataStore.setState({ eventsReady: true, calendarsReady: true, lastSyncAt, error: false });
}

export function widgetEventsFailed() {
  useWidgetDataStore.setState({ error: true });
}

export function resetWidgetData() {
  useWidgetDataStore.setState({ eventsReady: false, calendarsReady: false, calendarsAuthoritative: false, lastSyncAt: null, error: false });
}
