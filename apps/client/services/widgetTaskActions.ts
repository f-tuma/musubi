import { taskCapabilities } from "@musubi/calendar";
import type { useApi } from "./api";
import { consumeWidgetTaskCompletion } from "./agendaWidget";
import { refreshTasks, runTaskMutation } from "./taskCollection";
import { useTasksStore } from "@/store/useTasksStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { getEventLifecycle } from "@/store/useEventsStore";
import { widgetCalendarsLoaded } from "@/store/useWidgetDataStore";

type Api = Pick<ReturnType<typeof useApi>, "getCalendars" | "getTasks" | "syncProviderCalendars" | "setTaskStatus">;

/** A widget click is a request, never an offline optimistic completion. The
 * native single-use ticket binds it to the rendered task and account; fresh
 * access and the conditional mutation protect against subsequent changes. */
export async function completeWidgetTask(scope: string, taskId: string, token: string, api: Api): Promise<boolean> {
  const lifecycle = getEventLifecycle();
  const current = () => lifecycle === getEventLifecycle() && useTasksStore.getState().scope === scope;
  const ticket = await consumeWidgetTaskCompletion(token, scope);
  if (!current()) return false;
  if (!ticket || ticket.taskId !== taskId || ticket.scope !== scope)
    throw new Error("Refresh the widget before completing this task.");
  const calendars = await api.getCalendars();
  if (!current()) return false;
  useCalendarsStore.getState().loadCalendars(calendars);
  widgetCalendarsLoaded(true);
  const before = useTasksStore.getState().tasks;
  await refreshTasks(scope, api);
  if (!current()) return false;
  const state = useTasksStore.getState();
  if (state.status !== "ready" || state.refreshing || state.tasks === before)
    throw new Error("Refresh tasks before completing this task.");
  const task = state.tasks.find(item => item.id === taskId);
  if (!task || task.revision !== ticket.revision || (task.providerReadRetiredGeneration ?? 0) !== ticket.providerReadRetiredGeneration || task.status === "completed" || task.status === "cancelled")
    throw new Error("This task has changed. Check its current details.");
  if (!taskCapabilities(task, calendars).edit)
    throw new Error("This task is read-only.");
  await runTaskMutation(scope, api, task.id, () => api.setTaskStatus(task, "completed"));
  return current();
}
