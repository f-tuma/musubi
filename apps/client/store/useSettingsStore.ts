
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
  timeLocale: "en-UK" | "cs-CZ",
  setTimeLocale: (value: "en-UK" | "cs-CZ") => void,
}


export const useSettingsStore = create<SettingsStore>((set) => ({
  loadSettings: (settings: Settings) => set(() => (settings)),
  defaultCalendarView: "week",
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
  timeLocale: "en-UK",
  setTimeLocale: (value: "en-UK" | "cs-CZ") => set(() => ({
    timeLocale: value,
  })),
}));
