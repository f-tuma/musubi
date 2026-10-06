import {
  calendarTasks, civilToInstant, expandRecurringEvents, instantToCivil,
  taskCalendarIDs, taskDisplayCalendar, taskCapabilities, uniqueTasks,
  type ICalendarEventBase,
} from "@musubi/calendar";
import { occurrenceKey, type Calendar, type Event, type Task } from "@musubi/types";

export const WIDGET_BUDGET = {
  events: 4096, tasks: 2048, days: 450, references: 32768,
  bytes: 1024 * 1024, candidates: 50000, occurrences: 10000,
} as const;
const DAY = 86_400_000;
type SectionState = "ready" | "loading" | "unavailable" | "error";
type SectionStatus = {
  state: SectionState; lastSyncAt: number | null; complete: boolean; truncated: boolean;
  preservePrevious?: boolean;
};
export type WidgetEvent = {
  key: string; id: string; title: string; start: number; end: number;
  allDay: boolean; color: string; calendarName: string; calendarIds: string[];
  location: string; startKey: string; endKey: string; taskId?: string;
};
export type WidgetTask = {
  id: string; title: string; status: Task["status"]; priority: number;
  color: string; calendarName: string; calendarIds: string[];
  due: number | null; dueDateOnly: boolean;
  revision: number; providerReadRetiredGeneration: number; canComplete: boolean; shared: boolean;
};
export type WidgetSnapshot = {
  version: 2; scope: string; lifecycle: number; generation: number;
  signedIn: true; generatedAt: number; timeZone: string;
  readableCalendarIds: string[];
  calendars?: { id: string; name: string; color: string }[];
  timeFormat: "24h" | "12h"; weekStartsOn: "monday" | "sunday";
  eventsStatus: SectionStatus & { coverageStart: number; coverageEnd: number };
  tasksStatus: SectionStatus;
  events: WidgetEvent[]; calendarDays: { date: string; eventKeys: string[] }[];
  tasks: WidgetTask[];
};
type Input = {
  scope: string; lifecycle: number; generation: number; now: Date; timeZone: string;
  events: Event[]; calendars: Calendar[]; tasks: Task[];
  eventsReady: boolean; eventsError: boolean; eventsLastSyncAt: number | null;
  tasksReady: boolean; tasksState: SectionState; tasksLastSyncAt: number | null;
  timeFormat: "24h" | "12h"; weekStartsOn: "monday" | "sunday";
};

function section(state: SectionState, lastSyncAt: number | null): SectionStatus {
  return { state, lastSyncAt, complete: state === "ready", truncated: false };
}
function monthBoundary(year: number, month: number, zone: string) {
  const day = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return { day, instant: civilToInstant(`${day}T00:00:00.000`, zone, "explicit")! };
}
const keyDate = (date: Date, allDay: boolean, zone: string) =>
  allDay ? date.toISOString().slice(0, 10) : instantToCivil(date, zone).slice(0, 10);
const shorten = (value: string) => value.slice(0, 256);

/** One expansion, bounded civil-day iteration and display-only fields. A
 * synthetic occurrence/marker key never becomes a writable canonical ID. */
export function buildWidgetSnapshot(input: Input): WidgetSnapshot {
  const today = instantToCivil(input.now, input.timeZone).slice(0, 10);
  const [year, month] = today.split("-").map(Number);
  const start = monthBoundary(year, month - 2, input.timeZone);
  const end = monthBoundary(year, month + 12, input.timeZone);
  const byCalendar = new Map(input.calendars.map(calendar => [calendar.id, calendar]));
  const snapshot: WidgetSnapshot = {
    version: 2, scope: input.scope, lifecycle: input.lifecycle, generation: input.generation,
    signedIn: true, generatedAt: input.now.getTime(), timeZone: input.timeZone,
    readableCalendarIds: [...byCalendar.keys()],
    calendars: input.calendars.map(({ id, name, color }) => ({ id, name: shorten(name), color })),
    timeFormat: input.timeFormat, weekStartsOn: input.weekStartsOn,
    eventsStatus: { ...section(input.eventsError ? "error" : input.eventsReady ? "ready" : "loading", input.eventsLastSyncAt), preservePrevious: !input.eventsReady,
      coverageStart: start.instant.getTime(), coverageEnd: end.instant.getTime() },
    tasksStatus: { ...section(input.tasksState, input.tasksLastSyncAt),
      preservePrevious: !input.tasksReady && input.tasksState !== "unavailable" },
    events: [], calendarDays: [], tasks: [],
  };
  let taskRows = input.tasksReady ? uniqueTasks(input.tasks) : [];
  if (taskRows.some(task => [task.start, task.due].some(date => date != null && !Number.isFinite(date.getTime())))) {
    snapshot.tasksStatus.state = "error"; snapshot.tasksStatus.complete = false;
    snapshot.tasksStatus.preservePrevious = true;
    taskRows = [];
  }
  if (input.tasksReady) {
    snapshot.tasks = taskRows.filter(task =>
      ["needs-action", "in-process"].includes(task.status) && taskCalendarIDs(task).some(id => byCalendar.has(id)) && taskDisplayCalendar(task, input.calendars),
    ).sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity)
      || (a.priority || 10) - (b.priority || 10) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
      .map(task => {
        const calendar = taskDisplayCalendar(task, input.calendars)!;
        return { id: task.id, title: shorten(task.title), status: task.status, priority: task.priority,
          color: calendar.color, calendarName: shorten(calendar.name),
          calendarIds: taskCalendarIDs(task).filter(id => byCalendar.has(id)),
          due: task.due?.getTime() ?? null, dueDateOnly: task.isAllDay,
          revision: task.revision ?? 0, providerReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0, canComplete: taskCapabilities(task, input.calendars).edit,
          shared: taskCalendarIDs(task).length > 1 };
      });
    if (snapshot.tasks.length > WIDGET_BUDGET.tasks) {
      snapshot.tasks.length = WIDGET_BUDGET.tasks;
      snapshot.tasksStatus.complete = false;
      snapshot.tasksStatus.truncated = true;
    }
  }
  if (!input.eventsReady) return snapshot;
  try {
    const readableTasks = taskRows.filter(task => taskCalendarIDs(task).some(id => byCalendar.has(id)));
    const markers = input.tasksReady ? calendarTasks(readableTasks, input.calendars, { consumerTimeZone: input.timeZone }) : [];
    // Exceptions (including cancellation or a move to an unreadable calendar)
    // must participate in substitution before visibility is filtered. Removing
    // them first would resurrect the master's original occurrence.
    const allDefinitions = [...input.events, ...markers];
    const readableFamilies = new Set(allDefinitions.filter(event => event.calendars.some(id => byCalendar.has(id)))
      .map(event => event.seriesID ?? event.id));
    const definitions: (Event & ICalendarEventBase & { widgetSourceId: string; calendarTask?: Task })[] = allDefinitions
      .filter(event => readableFamilies.has(event.seriesID ?? event.id))
      .map(event => ({ ...event, widgetSourceId: event.id }));
    if (definitions.some(event => !Number.isFinite(event.start.getTime())
      || !Number.isFinite(event.end.getTime()) || event.end < event.start))
      throw new Error("Invalid widget event time");
    const occurrences = expandRecurringEvents(definitions, start.instant,
      new Date(end.instant.getTime() - 1), { consumerTimeZone: input.timeZone,
        strict: true, maxCandidates: WIDGET_BUDGET.candidates, maxOccurrences: WIDGET_BUDGET.occurrences })
      .filter(event => !event.isCanceled && event.calendars.some(id => byCalendar.has(id)));
    // Under a budget, retain current/future rows before old occurrences. Native
    // views sort their own visible range; incompleteness is always explicit.
    occurrences.sort((a, b) => {
      const distance = (event: Event) => event.end.getTime() >= input.now.getTime()
        ? Math.max(0, event.start.getTime() - input.now.getTime())
        : DAY * 400 + input.now.getTime() - event.end.getTime();
      return distance(a) - distance(b) || a.id.localeCompare(b.id);
    });
    const days = new Map<string, string[]>();
    const seen = new Set<string>();
    let references = 0;
    for (const event of occurrences) {
      const endInstant = !event.isAllDay && event.end > event.start
        ? new Date(event.end.getTime() - 1) : event.end;
      const startKey = keyDate(event.start, event.isAllDay, input.timeZone);
      const endKey = keyDate(endInstant, event.isAllDay, input.timeZone);
      const key = event.occurrenceIdentity ? occurrenceKey(event.occurrenceIdentity)
        : `${event.id}:${event.start.getTime()}`;
      if (seen.has(key)) continue;
      const from = startKey < start.day ? start.day : startKey;
      const to = endKey >= end.day ? new Date(Date.parse(`${end.day}T00:00:00Z`) - DAY).toISOString().slice(0, 10) : endKey;
      const span = Math.max(0, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1);
      if (!span) continue;
      if (snapshot.events.length >= WIDGET_BUDGET.events || references + span > WIDGET_BUDGET.references) {
        snapshot.eventsStatus.complete = false; snapshot.eventsStatus.truncated = true; continue;
      }
      const calendar = byCalendar.get(event.originCalendarID ?? "")
        ?? event.calendars.map(id => byCalendar.get(id)).find(Boolean);
      const taskId = "calendarTask" in event ? (event.calendarTask as Task).id : undefined;
      snapshot.events.push({ key, id: taskId ?? event.widgetSourceId, title: shorten(event.title),
        start: event.start.getTime(), end: event.end.getTime(), allDay: event.isAllDay,
        color: calendar?.color ?? "", calendarName: shorten(calendar?.name ?? ""),
        calendarIds: event.calendars.filter(id => byCalendar.has(id)), location: shorten(event.location ?? ""),
        startKey, endKey, ...(taskId ? { taskId } : {}) });
      seen.add(key); references += span;
      // Iterate only the covered civil dates. UTC arithmetic here advances date
      // keys, not timed instants; DST cannot add or drop a day.
      for (let day = Date.parse(`${from}T00:00:00Z`), last = Date.parse(`${to}T00:00:00Z`); day <= last; day += DAY) {
        const date = new Date(day).toISOString().slice(0, 10);
        const keys = days.get(date) ?? []; keys.push(key); days.set(date, keys);
      }
    }
    snapshot.calendarDays = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, eventKeys]) => ({ date, eventKeys }));
  } catch {
    // Native keeps the prior same-scope section, rather than treating failed
    // expansion as an authoritative empty calendar.
    snapshot.eventsStatus.state = "error";
    snapshot.eventsStatus.complete = false;
    snapshot.eventsStatus.truncated = true;
    snapshot.eventsStatus.preservePrevious = true;
    snapshot.events = [];
    snapshot.calendarDays = [];
  }
  return snapshot;
}

/** Hermes-safe UTF-8 byte count; JS string length undercounts non-ASCII titles. */
export function widgetUtf8Bytes(text: string) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

export function serializeWidgetSnapshot(snapshot: WidgetSnapshot) {
  let serialized = JSON.stringify(snapshot);
  while (widgetUtf8Bytes(serialized) > WIDGET_BUDGET.bytes) {
    if (snapshot.events.length) {
      snapshot.events.length = Math.floor(snapshot.events.length * 0.75);
      const kept = new Set(snapshot.events.map(event => event.key));
      snapshot.calendarDays = snapshot.calendarDays.map(day => ({ ...day, eventKeys: day.eventKeys.filter(key => kept.has(key)) }))
        .filter(day => day.eventKeys.length);
      snapshot.eventsStatus.complete = false; snapshot.eventsStatus.truncated = true;
    } else if (snapshot.tasks.length) {
      snapshot.tasks.length = Math.floor(snapshot.tasks.length * 0.75);
      snapshot.tasksStatus.complete = false; snapshot.tasksStatus.truncated = true;
    } else throw new Error("Widget metadata exceeds its storage budget");
    serialized = JSON.stringify(snapshot);
  }
  return serialized;
}
