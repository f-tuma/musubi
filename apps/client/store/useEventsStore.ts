import { Event } from "@musubi/types";
import { useApi } from "@/services/api";
import { create } from "zustand";
import { cancelEventNotification, syncEventNotification } from "@/services/notifications";
import { cacheDeleteEvents, cacheUpsertEvents } from "@/services/eventsCache";

type EventsStore = {
  events: Event[],
  addEvent: (event: Event, api: ReturnType<typeof useApi>) => Promise<void>;
  localAddEvent: (event: Event) => void;
  loadEvents: (events: Event[]) => void;
  removeEvent: (event: Event, api: ReturnType<typeof useApi>, unlinkCalendarID?: string) => Promise<void>;
  localRemoveEvent: (event: Event) => void;
  updateEvent: (event: Event, api: ReturnType<typeof useApi>) => Promise<void>;
  localUpdateEvent: (event: Event) => void;
  localRemoveCalendarEvents: (calendarID: string) => void;
  linkEvent: (event: Event, calendarID: string, api: ReturnType<typeof useApi>) => Promise<void>;
  forkEvent: (event: Event, calendarID: string, api: ReturnType<typeof useApi>) => Promise<void>;
}

export const useEventsStore = create<EventsStore>((set, get) => ({
  events: [],
  addEvent: async (event, api) => {
    const result = await api.createEvent(event);
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id), result]
    }));
    cacheUpsertEvents([result]);
  },
  localAddEvent: (event: Event) => {
    if (get().events.some(e => e.id === event.id)) {
      return;
    }
    set((state) => ({
      events: [...state.events, event],
    }));
    cacheUpsertEvents([event]);
  },
  linkEvent: async (event, calendarID, api) => {
    const result = await api.linkEvent(event.id, calendarID);
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id), result],
    }));
    cacheUpsertEvents([result]);
  },
  forkEvent: async (event, calendarID, api) => {
    const result = await api.forkEvent(event.id, calendarID); // independent copy, new id
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id), result],
    }));
    cacheUpsertEvents([result]);
  },
  loadEvents: (events) => set(() => ({
    events: events,
  })),
  removeEvent: async (event, api, unlinkCalendarID) => {
    const result = await api.removeEvent(event, unlinkCalendarID);
    if (!result.removed) {
      // Still linked to calendars the user can't edit → keep it, just update links.
      const updated = { ...event, calendars: result.calendars };
      set((state) => ({ events: state.events.map(e => e.id === event.id ? updated : e) }));
      cacheUpsertEvents([updated]);
      return;
    }
    cancelEventNotification(event.id).catch(() => { });
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id)],
    }));
    cacheDeleteEvents([event.id]);
  },
  localRemoveEvent: (event) => {
    set((state) => ({
      events: [...state.events.filter(e => e.id !== event.id)],
    }));
    cacheDeleteEvents([event.id]);
    cancelEventNotification(event.id).catch(() => { });
  },
  updateEvent: async (event, api) => {
    const result = await api.updateEvent(event);
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id), result],
    }));
    cacheUpsertEvents([result]);
  },
  localUpdateEvent: (event) => {
    set((state) => ({
      events: [...state.events.filter(e => e.id !== event.id), event],
    }));
    cacheUpsertEvents([event]);
    syncEventNotification(event).catch(() => { }); // reschedule if a reminder exists
  },
  // Lost access to a calendar (kicked / calendar deleted): strip its link from
  // every event, drop events that lived only there — memory AND cache, so they
  // don't linger until sign-out.
  localRemoveCalendarEvents: (calendarID) => {
    const kept: Event[] = [], dropped: string[] = [], changed: Event[] = [];
    for (const e of get().events) {
      if (!e.calendars?.includes(calendarID)) { kept.push(e); continue; }
      const calendars = e.calendars.filter(c => c !== calendarID);
      if (calendars.length === 0) { dropped.push(e.id); continue; }
      const updated = { ...e, calendars };
      kept.push(updated); changed.push(updated);
    }
    set({ events: kept });
    cacheDeleteEvents(dropped);
    cacheUpsertEvents(changed);
    dropped.forEach(id => cancelEventNotification(id).catch(() => { }));
  },
}));
