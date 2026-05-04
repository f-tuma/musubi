
import { Settings } from "@/constants/types";
import { Mode } from "react-native-big-calendar";
import { create } from "zustand";


type SettingsStore = {
  loadSettings: (settings: Settings) => void,
  defaultCalendarView: Mode,
  setDefaultCalendarView: (view: Mode) => void,
  weekStartsOn: string,
  setWeekStartsOn: (start: string) => void,
  accentColor: string,
  setAccentColor: (color: string) => void,
  showKanji: boolean,
  setShowKanji: (show: boolean) => void,
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
  setShowKanji: (show) => set(() => ({
    showKanji: show,
  })),
}));
