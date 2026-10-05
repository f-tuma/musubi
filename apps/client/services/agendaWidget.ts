import { AppState, Platform } from "react-native";
import MusubiAgendaWidget from "@/modules/musubi-agenda-widget";
import { getEventLifecycle, useEventsStore } from "@/store/useEventsStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useTasksStore } from "@/store/useTasksStore";
import { resetWidgetData, useWidgetDataStore } from "@/store/useWidgetDataStore";
import { buildWidgetSnapshot, serializeWidgetSnapshot, type WidgetSnapshot } from "./widgetSnapshot";

const UPDATE_DEBOUNCE_MS = 120;
let writes: Promise<unknown> = Promise.resolve();
let active: { stop: () => void } | undefined;

// Bridge writes and clears share a queue. The native lifecycle/generation fence
// additionally rejects a late operation, including across a process restart.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation);
  writes = next.catch(() => undefined);
  return next;
}

export function startAgendaWidgetSync(scope: string) {
  active?.stop();
  if (Platform.OS !== "android" || !MusubiAgendaWidget || !scope) return () => {};
  const native = MusubiAgendaWidget;
  const eventLifecycle = getEventLifecycle();
  let disposed = false;
  let lifecycle: number | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFingerprint: string | undefined;
  let projectionInputs: readonly unknown[] | undefined;
  let projection: WidgetSnapshot | undefined;
  let clock = `${new Date().toDateString()}:${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  const isCurrent = () => !disposed && eventLifecycle === getEventLifecycle();

  function schedule() {
    if (!isCurrent()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void update().catch(error => console.warn("Widget update failed:", error));
    }, UPDATE_DEBOUNCE_MS);
  }
  async function update() {
    if (!isCurrent() || lifecycle === undefined) return;
    const data = useWidgetDataStore.getState();
    // Cache/network failures cannot publish an empty signed-in replacement.
    const tasks = useTasksStore.getState();
    const taskReady = tasks.scope === scope && tasks.ready;
    const taskState = tasks.scope !== scope ? "loading"
      : tasks.status === "unauthorized" ? "unavailable" : tasks.status === "error" ? "error" : !tasks.ready ? "loading" : "ready";
    // Unknown membership cannot turn a valid task cache into a successful empty
    // result. An authorization failure still publishes a private-data barrier.
    if (!data.calendarsReady && taskState !== "unavailable") return;
    if (!data.eventsReady && !taskReady && taskState !== "unavailable") return;
    const settings = useSettingsStore.getState();
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const events = useEventsStore.getState().events;
    const calendars = data.calendarsReady ? useCalendarsStore.getState().calendars : [];
    const inputs = [events, calendars, taskReady ? tasks.tasks : null, data.eventsReady, data.error,
      taskReady, taskState, now.toDateString(), timeZone];
    // A foreground redraw or a new sync timestamp need not re-expand the same
    // recurrence families. Midnight/zone changes still rebuild civil buckets.
    if (!projection || !projectionInputs?.every((value, index) => value === inputs[index])) {
      projection = buildWidgetSnapshot({
        scope, lifecycle, generation, now, timeZone, events, calendars,
        eventsReady: data.eventsReady, eventsError: data.error, eventsLastSyncAt: data.lastSyncAt,
        tasks: taskReady ? tasks.tasks : [], tasksReady: taskReady, tasksState: taskState,
        tasksLastSyncAt: tasks.scope === scope ? tasks.lastSyncedAt : null,
        timeFormat: settings.timeFormat, weekStartsOn: settings.weekStartsOn,
      });
      projectionInputs = inputs;
    }
    const snapshot: WidgetSnapshot = {
      ...projection, generation: ++generation, generatedAt: now.getTime(),
      timeFormat: settings.timeFormat, weekStartsOn: settings.weekStartsOn,
      eventsStatus: { ...projection.eventsStatus, lastSyncAt: data.lastSyncAt },
      tasksStatus: { ...projection.tasksStatus, lastSyncAt: tasks.scope === scope ? tasks.lastSyncedAt : null },
    };
    const serialized = serializeWidgetSnapshot(snapshot);
    // Serialization may trim to the byte budget; retain its completeness flags
    // along with the trimmed rows on later cache reuse.
    projection = snapshot;
    const fingerprint = JSON.stringify({ ...snapshot, generation: 0, generatedAt: 0 });
    if (lastFingerprint === fingerprint) return;
    const accepted = await enqueue(async () => isCurrent() ? native.updateSnapshot(serialized) : false);
    if (accepted && isCurrent()) lastFingerprint = fingerprint;
  }

  const unsubscribers = [
    useEventsStore.subscribe((state, previous) => { if (state.events !== previous.events) schedule(); }),
    useCalendarsStore.subscribe((state, previous) => { if (state.calendars !== previous.calendars) schedule(); }),
    useSettingsStore.subscribe((state, previous) => {
      if (state.timeFormat !== previous.timeFormat || state.weekStartsOn !== previous.weekStartsOn) schedule();
    }),
    useWidgetDataStore.subscribe(schedule),
    useTasksStore.subscribe((state, previous) => {
      if (state.tasks !== previous.tasks || state.status !== previous.status || state.ready !== previous.ready
        || state.lastSyncedAt !== previous.lastSyncedAt || state.scope !== previous.scope) schedule();
    }),
  ];
  const foreground = AppState.addEventListener("change", state => { if (state === "active") schedule(); });
  // While JS is active, rebucket at local midnight or a changed device zone.
  // A native redraw alone cannot expand floating recurrences in a new zone.
  const clockTimer = setInterval(() => {
    if (AppState.currentState !== "active") return;
    const next = `${new Date().toDateString()}:${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    if (next !== clock) { clock = next; schedule(); }
  }, 60_000);
  const owner = { stop: () => {
    if (disposed) return;
    disposed = true;
    unsubscribers.forEach(unsubscribe => unsubscribe());
    foreground.remove(); clearInterval(clockTimer);
    if (timer) clearTimeout(timer);
    if (active === owner) active = undefined;
  } };
  active = owner;
  void enqueue(async () => {
    if (!isCurrent()) return;
    lifecycle = await native.beginSession(scope);
    if (isCurrent()) schedule();
  }).catch(error => console.warn("Widget session could not start:", error));
  return owner.stop;
}

export async function clearAgendaWidget() {
  active?.stop();
  resetWidgetData();
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  const native = MusubiAgendaWidget;
  await enqueue(() => native.clearSnapshot());
}

export async function getCalendarWidgetSelection(widgetId: number): Promise<string[] | null> {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return null;
  const owner = active, native = MusubiAgendaWidget;
  return enqueue(() => active === owner && owner ? native.getCalendarWidgetSelection(widgetId) : Promise.resolve(null));
}

export async function setCalendarWidgetSelection(widgetId: number, calendarIds: string[]) {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  const owner = active, native = MusubiAgendaWidget;
  await enqueue(() => active === owner && owner ? native.setCalendarWidgetSelection(widgetId, calendarIds) : Promise.resolve());
}

export async function getTasksWidgetSelection(widgetId: number): Promise<string[] | null> {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return null;
  const owner = active, native = MusubiAgendaWidget;
  return enqueue(() => active === owner && owner ? native.getTasksWidgetSelection(widgetId) : Promise.resolve(null));
}

export async function setTasksWidgetSelection(widgetId: number, calendarIds: string[]) {
  if (Platform.OS !== "android" || !MusubiAgendaWidget) return;
  const owner = active, native = MusubiAgendaWidget;
  await enqueue(() => active === owner && owner ? native.setTasksWidgetSelection(widgetId, calendarIds) : Promise.resolve());
}
