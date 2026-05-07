import { Calendar } from "@/constants/types";
import { useApi } from "@/services/api";
import { create } from "zustand";


type CalendarStore = {
  calendars: Calendar[],
  activeCals: Set<string>;
  toggleCal: (id: string) => void;
  syncActiveCals: (calendars: Calendar[]) => void;
  addCalendar: (calendar: Calendar, api: ReturnType<typeof useApi>) => Promise<void>;
  loadCalendars: (calendars: Calendar[]) => void;
  removeCalendar: (calendar: Calendar, api: ReturnType<typeof useApi>) => Promise<void>;
  localRemoveCalendar: (calendar: Calendar) => void;
  updateCalendar: (calendar: Calendar, api: ReturnType<typeof useApi>) => Promise<Calendar>;
  localUpdateCalendar: (calendar: Calendar) => Calendar;
}


export const useCalendarsStore = create<CalendarStore>((set, get) => ({
  calendars: [],
  activeCals: new Set(),
  toggleCal: (id) => {
    const next = new Set(get().activeCals);
    next.has(id) ? next.delete(id) : next.add(id);
    set(() => ({
      activeCals: next,
    }));
  },
  syncActiveCals: (calendars) => {
    const now = new Set(get().activeCals);
    calendars.forEach(c => !now.has(c.id) && now.add(c.id));
    set(() => ({
      activeCals: now,
    }))
  },
  addCalendar: async (calendar, api) => {
    const result = await api.createCalendar(calendar);
    set((state) => ({
      calendars: [...state.calendars, result],
    }));
  },
  loadCalendars: (calendars: Calendar[]) => set(() => ({
    calendars: calendars,
  })),
  removeCalendar: async (calendar, api) => {
    const result = await api.removeCalendar(calendar);
    set((state) => {
      const next = new Set(state.activeCals);
      next.delete(calendar.id);
      return {
        calendars: [...state.calendars.filter(c => c.id !== result)],
        activeCals: next,
      }
    });
  },
  localRemoveCalendar: (calendar) => {
    set((state) => {
      const next = new Set(state.activeCals);
      next.delete(calendar.id);
      return {
        calendars: state.calendars.filter(c => c.id !== calendar.id),
        activeCals: next,
      }
    });
  },
  updateCalendar: async (calendar, api) => {
    const result = await api.updateCalendar(calendar);
    set((state) => ({
      calendars: [...state.calendars.filter(c => c.id !== result.id), result],
    }));
    return result;
  },
  localUpdateCalendar: (calendar) => {
    set((state) => ({
      calendars: [...state.calendars.filter(c => c.id !== calendar.id), calendar],
    }));
    return calendar;
  },
}));
