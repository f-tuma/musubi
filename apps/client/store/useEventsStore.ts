import { Event } from "@musubi/types";
import { useApi } from "@/services/api";
import { create } from "zustand";
import dayjs from "dayjs";
import { cancelEventPushNotification, getEventsNotificationIdentifier, removeNotification } from "@/services/notifications";

// Window loaded around a center date: 1 month back … 2 months forward.
export function eventWindow(center: Date) {
  return {
    from: dayjs(center).subtract(1, "month").startOf("month").toDate(),
    to: dayjs(center).add(2, "month").endOf("month").toDate(),
  };
}

type EventsStore = {
  events: Event[],
  loadedFrom: Date | null,
  loadedTo: Date | null,
  addEvent: (event: Event, api: ReturnType<typeof useApi>) => Promise<void>;
  localAddEvent: (event: Event) => void;
  loadEvents: (events: Event[], from?: Date, to?: Date) => void;
  ensureWindow: (anchor: Date, api: ReturnType<typeof useApi>) => Promise<void>;
  removeEvent: (event: Event, api: ReturnType<typeof useApi>) => Promise<void>;
  localRemoveEvent: (event: Event) => void;
  updateEvent: (event: Event, api: ReturnType<typeof useApi>) => Promise<void>;
  localUpdateEvent: (event: Event) => void;
}

export const useEventsStore = create<EventsStore>((set, get) => ({
  events: [],
  loadedFrom: null,
  loadedTo: null,
  addEvent: async (event, api) => {
    const result = await api.createEvent(event);
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id), result]
    }));
  },
  localAddEvent: (event: Event) => {
    if (get().events.some(e => e.id === event.id)) {
      return;
    }
    set((state) => ({
      events: [...state.events, event],
    }));
  },
  loadEvents: (events, from, to) => set(() => ({
    events: events,
    loadedFrom: from ?? null,
    loadedTo: to ?? null,
  })),
  // Fetch + swap in the window around `anchor` when it falls outside what's loaded.
  ensureWindow: async (anchor, api) => {
    const { loadedFrom, loadedTo } = get();
    if (loadedFrom && loadedTo && anchor >= loadedFrom && anchor <= loadedTo) return;
    const { from, to } = eventWindow(anchor);
    const events = await api.getEvents(from, to);
    set({ events, loadedFrom: from, loadedTo: to });
  },
  removeEvent: async (event, api) => {
    const result = await api.removeEvent(event);
    const identifier = await getEventsNotificationIdentifier(event.id);
    if (identifier !== null) {
      cancelEventPushNotification(identifier);
      removeNotification(event.id);
      console.log("=== REMOVED NOTIFICATION ===");
      console.log(identifier);
      console.log(event.id);
      console.log("============================");
    }
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result)],
    }));
  },
  localRemoveEvent: (event) => {
    set((state) => ({
      events: [...state.events.filter(e => e.id !== event.id)],
    }));
  },
  updateEvent: async (event, api) => {
    const result = await api.updateEvent(event);
    set((state) => ({
      events: [...state.events.filter(e => e.id !== result.id), result],
    }));
  },
  localUpdateEvent: (event) => {
    set((state) => ({
      events: [...state.events.filter(e => e.id !== event.id), event],
    }));
  },
}));
