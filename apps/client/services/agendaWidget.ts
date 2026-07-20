import { expandRecurringEvents, eventDay } from "@musubi/calendar";
import { Calendar, Event } from "@musubi/types";
import { Platform } from "react-native";
import MusubiAgendaWidget from "@/modules/musubi-agenda-widget";
import { eventColor } from "@/lib/eventColor";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useSettingsStore } from "@/store/useSettingsStore";

const LOOKAHEAD_DAYS = 45;
const LOOKBACK_DAYS = 7;
const MAX_SNAPSHOT_EVENTS = 64;
const UPDATE_DEBOUNCE_MS = 120;

type AgendaWidgetEvent = {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  color: string;
  calendarName: string;
  location: string;
};

type CalendarWidgetDay = {
  date: string;
  colors: string[];
  // startKey/endKey are the event's full run (not clamped to the grid) so the
  // native widget can draw multi-day all-day events as one continuous bar with
  // stable lanes. id is stable across the run, unique per occurrence.
  events: { title: string; color: string; calendarIds: string[]; id: string; allDay: boolean; startKey: string; endKey: string }[];
  count: number;
};

let pendingUpdate: ReturnType<typeof setTimeout> | null = null;

function calendarForEvent(event: Event, calendarById: Map<string, Calendar>): Calendar | undefined {
  const originId = event.originCalendarID ?? event.calendars[0];
  return calendarById.get(originId ?? "") ?? calendarById.get(event.calendars[0] ?? "");
}

function buildSnapshot() {
  const now = new Date();
  const rangeStart = new Date(now);
  rangeStart.setDate(rangeStart.getDate() - LOOKBACK_DAYS);
  const rangeEnd = new Date(now);
  rangeEnd.setDate(rangeEnd.getDate() + LOOKAHEAD_DAYS);

  const { events } = useEventsStore.getState();
  const { calendars } = useCalendarsStore.getState();
  const { timeFormat, weekStartsOn, showKanji } = useSettingsStore.getState();
  const calendarById = new Map(calendars.map(calendar => [calendar.id, calendar]));

  const upcoming = expandRecurringEvents(events, rangeStart, rangeEnd)
    .filter(event => {
      if (event.isCanceled) return false;
      if (event.isAllDay) {
        return eventDay(event.end, true).isAfter(eventDay(now), "day");
      }
      return event.end >= now;
    })
    .sort((a, b) => {
      const aDay = eventDay(a.start, a.isAllDay).valueOf();
      const bDay = eventDay(b.start, b.isAllDay).valueOf();
      if (aDay !== bDay) return aDay - bDay;
      if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
      return a.start.getTime() - b.start.getTime();
    })
    .slice(0, MAX_SNAPSHOT_EVENTS)
    .map<AgendaWidgetEvent>(event => ({
      id: event.id,
      title: event.title,
      start: event.start.getTime(),
      end: event.end.getTime(),
      allDay: event.isAllDay,
      color: eventColor(event as Event, calendarById),
      calendarName: calendarForEvent(event as Event, calendarById)?.name ?? "",
      location: event.location ?? "",
    }));

  // Keep enough day summaries for the current month and the next year. This
  // lets the native widget cross a month boundary even if Musubi has not been
  // opened that morning, without storing every event payload twice.
  const calendarRangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const calendarRangeEnd = new Date(now.getFullYear(), now.getMonth() + 13, 1);
  const calendarDaysByDate = new Map<string, Omit<CalendarWidgetDay, "date">>();
  const calendarEvents = expandRecurringEvents(events, calendarRangeStart, calendarRangeEnd)
    .filter(event => !event.isCanceled)
    .sort((a, b) => {
      if (a.isAllDay !== b.isAllDay) return a.isAllDay ? -1 : 1;
      return a.start.getTime() - b.start.getTime();
    });

  for (const event of calendarEvents) {
    const startDay = eventDay(event.start, event.isAllDay).startOf("day");
    const endInstant = event.end.getTime() > event.start.getTime()
      ? new Date(event.end.getTime() - 1)
      : event.end;
    const endDay = eventDay(endInstant, event.isAllDay).startOf("day");
    const color = eventColor(event as Event, calendarById);
    const startKey = startDay.format("YYYY-MM-DD");
    const endKey = endDay.format("YYYY-MM-DD");
    // Anchor on the start day so recurring instances stay unique per occurrence
    // but consistent across all days they cover.
    const chipId = `${event.id ?? event.title}:${startKey}`;

    for (let day = startDay; !day.isAfter(endDay, "day"); day = day.add(1, "day")) {
      const key = day.format("YYYY-MM-DD");
      const summary = calendarDaysByDate.get(key) ?? { colors: [], events: [], count: 0 };
      if (!summary.colors.includes(color) && summary.colors.length < 3) summary.colors.push(color);
      summary.events.push({ title: event.title, color, calendarIds: event.calendars, id: chipId, allDay: event.isAllDay, startKey, endKey });
      summary.count += 1;
      calendarDaysByDate.set(key, summary);
    }
  }

  const calendarDays: CalendarWidgetDay[] = [...calendarDaysByDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, summary]) => ({ date, ...summary }));

  return JSON.stringify({
    version: 1,
    signedIn: true,
    generatedAt: now.getTime(),
    timeFormat,
    weekStartsOn,
    showKanji,
    events: upcoming,
    calendarDays,
  });
}

async function updateAgendaWidget() {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  await MusubiAgendaWidget.updateSnapshot(buildSnapshot());
}

function scheduleAgendaWidgetUpdate() {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  if (pendingUpdate) clearTimeout(pendingUpdate);
  pendingUpdate = setTimeout(() => {
    pendingUpdate = null;
    updateAgendaWidget().catch(error => console.warn("Agenda widget update failed:", error));
  }, UPDATE_DEBOUNCE_MS);
}

export function startAgendaWidgetSync() {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return () => {};

  const unsubscribers = [
    useEventsStore.subscribe(scheduleAgendaWidgetUpdate),
    useCalendarsStore.subscribe(scheduleAgendaWidgetUpdate),
    useSettingsStore.subscribe(scheduleAgendaWidgetUpdate),
  ];
  scheduleAgendaWidgetUpdate();

  return () => {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    if (pendingUpdate) {
      clearTimeout(pendingUpdate);
      pendingUpdate = null;
    }
  };
}

export async function clearAgendaWidget() {
  if (pendingUpdate) {
    clearTimeout(pendingUpdate);
    pendingUpdate = null;
  }
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  await MusubiAgendaWidget.clearSnapshot();
}

export async function getCalendarWidgetSelection(widgetId: number): Promise<string[] | null> {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return null;
  return MusubiAgendaWidget.getCalendarWidgetSelection(widgetId);
}

export async function setCalendarWidgetSelection(widgetId: number, calendarIds: string[]) {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  await MusubiAgendaWidget.setCalendarWidgetSelection(widgetId, calendarIds);
}
