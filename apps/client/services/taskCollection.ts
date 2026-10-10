import { taskCalendarIDs, taskHomeCalendarID, uniqueTasks } from "@musubi/calendar";
import type { Task } from "@musubi/types";
import type { useApi } from "@/services/api";
import { isAuthorizationError, userFacingError } from "@/lib/network";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { getEventLifecycle, useEventsStore } from "@/store/useEventsStore";
import { useTaskRefreshStore } from "@/store/useTaskRefreshStore";
import { emptyTaskCollection, useTasksStore } from "@/store/useTasksStore";
import { useWidgetDataStore } from "@/store/useWidgetDataStore";
import { cacheDeleteTasks, cacheGetTasks, cacheSetTasks } from "./tasksCache";

export type TaskCollectionApi = Pick<ReturnType<typeof useApi>, "getTasks" | "syncProviderCalendars">;
type Session = {
  scope: string;
  api: TaskCollectionApi;
  lifecycle: number;
  request: number;
  mutations: number;
  pendingRefresh: boolean;
  needsAuthoritativeRead: boolean;
  removedCalendarIds: Set<string>;
  removedTaskIds: Set<string>;
  consumers: Set<symbol>;
  unsubscribe: (() => void)[];
  inFlight: Promise<void> | null;
};
let active: Session | null = null;

export function taskCollectionScope(apiUrl: string, actorId: string | undefined): string | null {
  return actorId ? JSON.stringify([apiUrl, actorId]) : null;
}

const isCurrent = (session: Session) => active === session && session.lifecycle === getEventLifecycle();

function persist(session: Session) {
  if (!isCurrent(session) || session.needsAuthoritativeRead) return;
  const state = useTasksStore.getState();
  if (!state.ready) return;
  try { cacheSetTasks(session.scope, state.tasks, state.lastSyncedAt); }
  catch (error) { console.warn("Task cache write failed:", error); }
}

function stop(session: Session) {
  session.request++;
  session.unsubscribe.forEach(unsubscribe => unsubscribe());
  session.unsubscribe = [];
  if (active === session) {
    active = null;
    // The owner gate can unmount all consumers before its account reset runs.
    // Retain the scoped disk cache, but do not leave private renderable rows in
    // memory after the lifecycle observer has been detached.
    useTasksStore.setState({ ...emptyTaskCollection });
  }
}

/** Also called by tests; production account reset is observed through the event lifecycle. */
export function resetTaskCollection() {
  if (active) stop(active);
  useTasksStore.setState({ ...emptyTaskCollection });
}

function invalidate(session: Session) {
  if (!isCurrent(session)) return;
  if (session.mutations) { session.pendingRefresh = true; return; }
  void refreshTasks(session.scope, session.api).catch(() => {});
}

function reconcileMembership(session: Session, previousIDs: Set<string>, includeCachedMemberships = false) {
  if (!isCurrent(session)) return;
  const readable = new Set(useCalendarsStore.getState().calendars.map(calendar => calendar.id));
  for (const id of readable) session.removedCalendarIds.delete(id);
  const removed = new Set([...previousIDs].filter(id => !readable.has(id)));
  // A cold task cache can outlive failed/empty calendar hydration, leaving no
  // previous UI membership to diff. Only a successful current calendar read
  // authorizes checking that cached home/payload against the complete set.
  if (includeCachedMemberships) {
    for (const task of useTasksStore.getState().tasks) {
      const home = taskHomeCalendarID(task);
      if (home && !readable.has(home)) removed.add(home);
      for (const id of taskCalendarIDs(task)) if (!readable.has(id)) removed.add(id);
    }
  }
  if (!removed.size) return;
  for (const id of removed) session.removedCalendarIds.add(id);
  session.request++;
  session.inFlight = null;
  // A previously readable home disappearing needs a fresh, possibly redacted
  // server projection. Do not keep its opened private/provider payload as a mirror.
  const tasks = useTasksStore.getState().tasks.flatMap(task => {
    if (removed.has(taskHomeCalendarID(task) ?? "")) return [];
    const calendarIDs = taskCalendarIDs(task).filter(id => readable.has(id));
    if (!calendarIDs.length) return [];
    return [{ ...task, calendarIDs, capabilities: task.capabilities ? {
      ...task.capabilities,
      unlinkCalendarIDs: task.capabilities.unlinkCalendarIDs.filter(id => readable.has(id)),
    } : undefined }];
  });
  if (includeCachedMemberships) {
    // Pruning an uncertain home cannot certify a healthy empty collection.
    // Delete its disk projection until the complete Tasks endpoint recovers it.
    session.needsAuthoritativeRead = true;
    useTasksStore.setState({ tasks, status: "error", error: "Refresh tasks to load current access." });
    try { cacheDeleteTasks(session.scope); } catch (error) { console.warn("Task cache clear failed:", error); }
  } else {
    useTasksStore.setState({ tasks });
    persist(session);
  }
}

/** Root layout retains a consumer so task invalidations work with Tasks unopened. */
export function startTaskCollectionSync(scope: string | null, api: TaskCollectionApi): () => void {
  if (!scope) { resetTaskCollection(); return () => {}; }
  let session = active;
  if (!session || session.scope !== scope || !isCurrent(session)) {
    if (session) stop(session);
    session = {
      scope, api, lifecycle: getEventLifecycle(), request: 0, mutations: 0,
      pendingRefresh: false, needsAuthoritativeRead: false, removedCalendarIds: new Set(), removedTaskIds: new Set(), consumers: new Set(), unsubscribe: [], inFlight: null,
    };
    active = session;
    useTasksStore.setState({ ...emptyTaskCollection, scope });
    try {
      const cached = cacheGetTasks(scope);
      if (cached && isCurrent(session)) useTasksStore.setState({
        tasks: uniqueTasks(cached.tasks), ready: true, status: "cached", lastSyncedAt: cached.lastSyncedAt,
      });
    } catch (error) {
      useTasksStore.setState({ status: "error", error: userFacingError(error, "Could not load saved tasks.") });
    }
    const current = session;
    if (useWidgetDataStore.getState().calendarsAuthoritative) reconcileMembership(current, new Set(), true);
    session.unsubscribe = [
      useTaskRefreshStore.subscribe(() => invalidate(current)),
      useEventsStore.subscribe((state, previous) => {
        if (current.lifecycle !== getEventLifecycle()) { resetTaskCollection(); return; }
        if (state.events !== previous.events) invalidate(current);
      }),
      useCalendarsStore.subscribe((state, previous) => {
        if (state.calendars === previous.calendars) return;
        reconcileMembership(current, new Set(previous.calendars.map(calendar => calendar.id)));
        invalidate(current);
      }),
      useWidgetDataStore.subscribe((state, previous) => {
        if (state.calendarsAuthoritative && !previous.calendarsAuthoritative) {
          reconcileMembership(current, new Set(), true);
          invalidate(current);
        }
      }),
    ];
    void refreshTasks(scope, api).catch(() => {});
  } else session.api = api;
  const current = session;
  const consumer = Symbol();
  current.consumers.add(consumer);
  return () => {
    current.consumers.delete(consumer);
    if (!current.consumers.size) stop(current);
  };
}

export function refreshTasks(
  scope: string | null, api: TaskCollectionApi, options: { providerSync?: boolean } = {},
): Promise<void> {
  const session = active;
  if (!scope || !session || session.scope !== scope || !isCurrent(session)) return Promise.resolve();
  session.api = api;
  if (session.mutations) { session.pendingRefresh = true; return Promise.resolve(); }
  if (session.inFlight && !options.providerSync) return session.inFlight;
  const request = ++session.request;
  useTasksStore.setState({ refreshing: true });
  const read = async () => {
    try {
      if (options.providerSync) await api.syncProviderCalendars();
      if (!isCurrent(session) || request !== session.request) return;
      const incoming = uniqueTasks(await api.getTasks());
      if (!isCurrent(session) || request !== session.request) return;
      const existing = new Map(useTasksStore.getState().tasks.map(task => [task.id, task]));
      const readableIds = new Set(incoming.map(task => task.id));
      // A full readable collection can revoke one row while calendar membership
      // stays unchanged. Its disappearance fences direct detail responses too.
      for (const id of existing.keys()) if (!readableIds.has(id)) session.removedTaskIds.add(id);
      for (const id of readableIds) session.removedTaskIds.delete(id);
      // Same-revision authoritative metadata may revoke capabilities/membership.
      // Only a proven newer revision/retirement generation wins over this read.
      const tasks = incoming.map(task => uniqueTasks([existing.get(task.id), task].filter((row): row is Task => !!row))[0]);
      session.needsAuthoritativeRead = false;
      useTasksStore.setState({ tasks, ready: true, status: "ready", error: null, lastSyncedAt: Date.now() });
      persist(session);
    } catch (error) {
      if (!isCurrent(session) || request !== session.request) return;
      if (isAuthorizationError(error)) {
        useTasksStore.setState({ tasks: [], ready: false, status: "unauthorized", lastSyncedAt: null });
        try { cacheDeleteTasks(scope); } catch (cacheError) { console.warn("Task cache clear failed:", cacheError); }
      } else useTasksStore.setState({ status: "error" });
      useTasksStore.setState({ error: userFacingError(error, "Could not load tasks.") });
      throw error;
    } finally {
      if (isCurrent(session) && request === session.request) {
        session.inFlight = null;
        useTasksStore.setState({ refreshing: false });
      }
    }
  };
  session.inFlight = read();
  return session.inFlight;
}

/** Accept only a confirmed API receipt; null means no readable row remains. */
export function acceptTaskMutation(scope: string | null, previousTaskId: string, saved: Task | null): boolean {
  const session = active;
  if (!scope || !session || session.scope !== scope || !isCurrent(session)) return false;
  const current = useTasksStore.getState();
  // Detail actions can deliver a receipt after the collection's authorized read
  // or membership removal has already revoked access in this same account.
  // A new authorized read may recover it; the delayed receipt cannot do so.
  if (current.status === "unauthorized") return false;
  if (saved && session.removedTaskIds.has(saved.id)) return false;
  if (saved && session.removedCalendarIds.has(taskHomeCalendarID(saved) ?? "")) {
    invalidate(session);
    return false;
  }
  if (saved && taskCalendarIDs(saved).some(id => session.removedCalendarIds.has(id))) {
    const calendarIDs = taskCalendarIDs(saved).filter(id => !session.removedCalendarIds.has(id));
    saved = calendarIDs.length ? { ...saved, calendarIDs, capabilities: saved.capabilities ? {
      ...saved.capabilities,
      unlinkCalendarIDs: saved.capabilities.unlinkCalendarIDs.filter(id => !session.removedCalendarIds.has(id)),
    } : undefined } : null;
  }
  const savedId = saved?.id;
  const known = savedId ? current.tasks.find(task => task.id === savedId) : undefined;
  // A successful read can revoke same-revision permissions after a mutation
  // response was prepared. Retain that authoritative projection on a repeated
  // receipt; a newer content or retirement revision can still replace it.
  if (saved && known && current.status === "ready" && known.revision === saved.revision
    && (known.providerReadRetiredGeneration ?? 0) >= (saved.providerReadRetiredGeneration ?? 0)) saved = known;
  session.request++;
  session.inFlight = null;
  if (!saved) session.removedTaskIds.add(previousTaskId);
  const tasks = saved ? uniqueTasks([...current.tasks, saved]) : current.tasks.filter(task => task.id !== previousTaskId);
  useTasksStore.setState({ tasks, ready: true, refreshing: false,
    error: session.needsAuthoritativeRead ? "Refresh tasks to load current access." : null,
    status: session.needsAuthoritativeRead ? "error" : current.lastSyncedAt === null ? "cached" : "ready" });
  persist(session);
  return true;
}

export async function runTaskMutation(
  scope: string | null, api: TaskCollectionApi, previousTaskId: string,
  mutate: () => Promise<Task | null>,
): Promise<Task | null> {
  const session = active;
  if (!scope || !session || session.scope !== scope || !isCurrent(session))
    throw new Error("Refresh tasks before saving; the account has changed.");
  session.mutations++;
  if (session.inFlight) session.pendingRefresh = true;
  session.request++;
  session.inFlight = null;
  useTasksStore.setState({ refreshing: false });
  let failed = false;
  try {
    const saved = await mutate();
    if (!isCurrent(session)) return null;
    return acceptTaskMutation(scope, previousTaskId, saved) ? saved : null;
  } catch (error) { failed = true; throw error; }
  finally {
    session.mutations--;
    if (isCurrent(session) && !session.mutations && (failed || session.pendingRefresh)) {
      session.pendingRefresh = false;
      void refreshTasks(scope, api).catch(() => {});
    }
  }
}
