import { calendarTasks, isCalendarTask, taskCapabilities, taskDisplayCalendar } from "@musubi/calendar";
import { useTaskRefreshStore } from "@/store/useTaskRefreshStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { type Task, type TaskStatus } from "@musubi/types";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { showToast } from "@/components/ui/Toast";
import { isAuthorizationError, userFacingError } from "@/lib/network";

const EMPTY_TASKS: Task[] = [];

export function useCalendarTasks() {
  const api = useApi(), apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const { apiUrl, authClient } = useServer();
  const actor = authClient.useSession().data?.user.id;
  const scope = JSON.stringify([apiUrl, actor]);
  const calendars = useCalendarsStore(s => s.calendars);
  const focused = useRef(false);
  const [snapshot, setSnapshot] = useState<{ scope: string; tasks: Task[] }>({ scope, tasks: [] });
  const tasks = snapshot.scope === scope ? snapshot.tasks : EMPTY_TASKS;
  const [selected, select] = useState<string>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const pendingRefresh = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (saving.current) { pendingRefresh.current = true; return; }
    pendingRefresh.current = false;
    const generation = ++request.current;
    try {
      const tasks = await apiRef.current.getTasks();
      if (generation === request.current) setSnapshot({ scope, tasks });
    } catch (error) {
      if (generation === request.current) {
        if (isAuthorizationError(error)) setSnapshot({ scope, tasks: [] });
        showToast({ message: userFacingError(error, "Could not load calendar tasks."), actionLabel: "Retry", onAction: () => { void refresh(); } });
      }
    }
  }, [scope]);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    void refresh();
    return () => { focused.current = false; request.current++; };
  }, [refresh]));
  // Provider/SSE refreshes replace the event snapshot. Refresh tasks alongside it,
  // without subscribing the whole calendar screen to a second task store.
  useEffect(() => useEventsStore.subscribe((state, previous) => {
    if (focused.current && state.events !== previous.events) void refresh();
  }), [refresh]);
  useEffect(() => useTaskRefreshStore.subscribe(() => { if (focused.current) void refresh(); }), [refresh]);
  const detail = tasks.find(task => task.id === selected);
  const calendar = detail ? taskDisplayCalendar(detail, calendars) : undefined;
  const editable = !!detail && taskCapabilities(detail, calendars).edit;
  async function change(change: { status: TaskStatus } | { priority: number }) {
    if (!detail || !editable || saving.current) return;
    saving.current = true;
    setBusy(true);
    const generation = ++request.current;
    let failed = false;
    try {
      const saved = "status" in change
        ? await apiRef.current.setTaskStatus(detail, change.status)
        : await apiRef.current.setTaskPriority(detail, change.priority);
      if (generation === request.current) setSnapshot(previous => ({
        scope, tasks: saved ? previous.tasks.map(task => task.id === saved.id ? saved : task) : previous.tasks.filter(task => task.id !== detail.id),
      }));
    } catch (error) {
      failed = true;
      showToast({ message: userFacingError(error, "Could not update task.") });
    } finally {
      saving.current = false; setBusy(false);
      if ((failed || pendingRefresh.current) && focused.current) void refreshRef.current();
    }
  }
  return {
    items: useMemo(() => calendarTasks(tasks, calendars), [tasks, calendars]),
    refresh,
    open: useCallback((event: import("@musubi/types").Event) => {
      if (!isCalendarTask(event)) return false;
      select(event.calendarTask.id);
      return true;
    }, []),
    detail: detail ? <TaskDetailModal key={scope + detail.id} task={detail} relatedTask={tasks.find(item => item.id === detail.relatedTo)} onOpenRelated={select} calendar={calendar} calendars={calendars}
      editable={editable} busy={busy} onSaved={saved => {
        request.current++;
        setSnapshot(previous => ({ scope, tasks: saved ? previous.tasks.map(item => item.id === saved.id ? saved : item) : previous.tasks.filter(item => item.id !== detail.id) }));
        if (!saved) select(undefined);
      }} onClose={() => select(undefined)}
      onStatus={status => { void change({ status }); }} onPriority={priority => { void change({ priority }); }} /> : null,
  };
}
