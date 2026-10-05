import { calendarTasks, isCalendarTask, taskCapabilities, taskDisplayCalendar } from "@musubi/calendar";
import { useCallback, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { TaskStatus } from "@musubi/types";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { acceptTaskMutation, runTaskMutation } from "@/services/taskCollection";
import { useTaskCollection } from "@/hooks/useTaskCollection";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { showToast } from "@/components/ui/Toast";
import { userFacingError } from "@/lib/network";

export function useCalendarTasks() {
  const { tasks, scope, apiRef, refresh } = useTaskCollection();
  const calendars = useCalendarsStore(s => s.calendars);
  const [selected, select] = useState<{ scope: string | null; id: string }>();
  const [busyScope, setBusyScope] = useState<string | null>();
  const saving = useRef<string | null>(null);
  useFocusEffect(useCallback(() => {
    void refresh().catch(error => showToast({ message: userFacingError(error, "Could not load calendar tasks.") }));
  }, [refresh]));
  const detail = selected?.scope === scope ? tasks.find(task => task.id === selected?.id) : undefined;
  const calendar = detail ? taskDisplayCalendar(detail, calendars) : undefined;
  const editable = !!detail && taskCapabilities(detail, calendars).edit;
  const busy = busyScope === scope && busyScope !== undefined;
  async function change(change: { status: TaskStatus } | { priority: number }) {
    if (!detail || !editable || saving.current === scope) return;
    saving.current = scope;
    setBusyScope(scope);
    const api = apiRef.current;
    try {
      await runTaskMutation(scope, api, detail.id, () => "status" in change
        ? api.setTaskStatus(detail, change.status)
        : api.setTaskPriority(detail, change.priority));
    } catch (error) {
      showToast({ message: userFacingError(error, "Could not update task.") });
    } finally {
      if (saving.current === scope) saving.current = null;
      setBusyScope(current => current === scope ? undefined : current);
    }
  }
  const openRelated = (id: string) => select({ scope, id });
  return {
    items: useMemo(() => calendarTasks(tasks, calendars), [tasks, calendars]),
    refresh,
    open: useCallback((event: import("@musubi/types").Event) => {
      if (!isCalendarTask(event)) return false;
      select({ scope, id: event.calendarTask.id });
      return true;
    }, [scope]),
    detail: detail ? <TaskDetailModal key={scope + detail.id} task={detail} relatedTask={tasks.find(item => item.id === detail.relatedTo)} onOpenRelated={openRelated} calendar={calendar} calendars={calendars}
      editable={editable} busy={busy} onSaved={saved => {
        if (acceptTaskMutation(scope, detail.id, saved) && !saved) select(undefined);
      }} onClose={() => select(undefined)}
      onStatus={status => { void change({ status }); }} onPriority={priority => { void change({ priority }); }} /> : null,
  };
}
