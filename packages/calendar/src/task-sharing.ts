import { can, type Calendar, type Task } from "@musubi/types";

/** Membership is distinct from ownership. A readable mirror never becomes home. */
export function taskCalendarIDs(task: Task): string[] {
  return [...new Set(task.calendarIDs ?? [task.calendarID])];
}

export function taskHomeCalendarID(task: Task): string | undefined {
  return task.calendarIDs ? task.originCalendarID ?? undefined : task.calendarID;
}

export function taskHasRevision(task: Task): boolean {
  const revision = task.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0;
}

export function taskCanEdit(task: Task, editableCalendarIDs: ReadonlySet<string>): boolean {
  if (!taskHasRevision(task)) return false;
  if (task.capabilities) return task.capabilities.edit;
  const home = taskHomeCalendarID(task);
  return !!home && editableCalendarIDs.has(home);
}

export function taskCapabilities(task: Task, calendars: readonly Calendar[]) {
  if (!taskHasRevision(task)) return { edit: false, delete: false, link: false, fork: false, unlinkCalendarIDs: [] as string[] };
  if (task.capabilities) return task.capabilities;
  const editable = new Set(calendars.filter(calendar => can(calendar.role, "editTasks") && calendar.supportsTasks !== false).map(calendar => calendar.id));
  const home = taskHomeCalendarID(task);
  const edit = !!home && editable.has(home);
  return { edit, delete: edit, link: false, fork: false, unlinkCalendarIDs: [] as string[] };
}

/** Use home pigment when readable, otherwise a readable membership's pigment. */
export function taskDisplayCalendar(task: Task, calendars: readonly Calendar[]): Calendar | undefined {
  const home = taskHomeCalendarID(task);
  return calendars.find(calendar => calendar.id === home) ?? calendars.find(calendar => taskCalendarIDs(task).includes(calendar.id));
}

export function uniqueTasks(tasks: readonly Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    const previous = byId.get(task.id);
    if (previous && ((previous.revision ?? 0) > (task.revision ?? 0) || (previous.revision === task.revision && (previous.providerReadRetiredGeneration ?? 0) > (task.providerReadRetiredGeneration ?? 0)))) continue;
    byId.set(task.id, task);
  }
  return [...byId.values()];
}
