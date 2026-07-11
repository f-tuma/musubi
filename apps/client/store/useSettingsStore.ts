
import { CalendarView, Settings } from "@musubi/types";
import { cacheGetSettingsSync, cacheSetSettings } from "@/services/eventsCache";
import { create } from "zustand";

// Seed the initial state from the local snapshot SYNCHRONOUSLY — the theme has
// to be correct on the very first frame (an async hydrate flashes the system
// theme or a blank window first). Null on a fresh install → plain defaults.
const persisted = cacheGetSettingsSync();


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
  // last-known values win over the defaults above (theme included)
  ...persisted,
}));

// Write-through persistence: every change lands in the local SQLite blob, so
// the next cold start hydrates (theme included) before the first themed render
// — no flash of the system theme while waiting for the server.
useSettingsStore.subscribe((s) => {
  const { showKanji, notificationsOnByDefault, defaultCalendarView, weekStartsOn,
    timeFormat, dateFormat, theme, onboarded, calendarOrder } = s;
  cacheSetSettings({
    showKanji, notificationsOnByDefault, defaultCalendarView, weekStartsOn,
    timeFormat, dateFormat, theme, onboarded, calendarOrder,
  }).catch(() => { }); // fresh install: the table appears once migrations run
});
