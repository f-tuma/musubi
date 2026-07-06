
import { CalendarView, Settings } from "@musubi/types";
import { timeLog } from "node:console";
import { create } from "zustand";


type SettingsStore = {
  loadSettings: (settings: Settings) => void,
  defaultCalendarView: CalendarView,
  setDefaultCalendarView: (view: CalendarView) => void,
  weekStartsOn: "monday" | "sunday",
  setWeekStartsOn: (start: "monday" | "sunday") => void,
  accentColor: string,
  setAccentColor: (color: string) => void,
  showKanji: boolean,
  setShowKanji: (value: boolean) => void,
  notificationsOnByDefault: boolean,
  setNotificationsOnByDefault: (value: boolean) => void,
  timeFormat: "12h" | "24h",
  setTimeFormat: (value: "12h" | "24h") => void,
  dateFormat: "dmy" | "mdy" | "ymd",
  setDateFormat: (value: "dmy" | "mdy" | "ymd") => void,
  theme: "system" | "dark" | "light",
  setTheme: (value: "system" | "dark" | "light") => void,
  onboarded: boolean,
  setOnboarded: (value: boolean) => void,
  calendarOrder: string[],
  setCalendarOrder: (ids: string[]) => void,
}


export const useSettingsStore = create<SettingsStore>((set) => ({
  loadSettings: (settings: Settings) => set(() => (settings)),
  defaultCalendarView: "month",
  setDefaultCalendarView: (view) => set(() => ({
    defaultCalendarView: view,
  })),
  weekStartsOn: "monday",
  setWeekStartsOn: (start) => set(() => ({
    weekStartsOn: start,
  })),
  accentColor: "#c8553d",
  setAccentColor: (color) => set(() => ({
    accentColor: color,
  })),
  showKanji: true,
  setShowKanji: (value) => set(() => ({
    showKanji: value,
  })),
  notificationsOnByDefault: true,
  setNotificationsOnByDefault: (value: boolean) => set(() => ({
    notificationsOnByDefault: value,
  })),
  timeFormat: "24h",
  setTimeFormat: (value) => set(() => ({
    timeFormat: value,
  })),
  dateFormat: "dmy",
  setDateFormat: (value) => set(() => ({
    dateFormat: value,
  })),
  theme: "system",
  setTheme: (value) => set(() => ({
    theme: value,
  })),
  // default true so existing sessions never flash the onboarding screen —
  // the server's value arrives via loadSettings and wins
  onboarded: true,
  calendarOrder: [],
  setCalendarOrder: (ids) => set(() => ({ calendarOrder: ids })),
  setOnboarded: (value) => set(() => ({
    onboarded: value,
  })),
}));
