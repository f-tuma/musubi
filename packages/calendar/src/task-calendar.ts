import type { Calendar, Event, Task } from "@musubi/types";
import { taskCalendarIDs, taskDisplayCalendar, taskHomeCalendarID, uniqueTasks } from "./task-sharing";
import { civilToInstant, instantToCivil } from "./time-zone";

/** Render-only calendar item. Never send this projection to an event endpoint. */
export type CalendarTask = Event & { calendarTask: Task };
export function isCalendarTask(event: Event): event is CalendarTask {
  return "calendarTask" in event;
}

/**
 * Scheduled starts live in the time grid; deadlines in the all-day rail.
 * Render-only 30-minute footprints never become a stored task duration.
 * Musubi all-day ends are inclusive. Both markers open the same task.
 */
export function calendarTasks(tasks: readonly Task[], calendars: readonly Calendar[], options?: { consumerTimeZone: string }): CalendarTask[] {
  return uniqueTasks(tasks).flatMap(task => {
    const calendar = taskDisplayCalendar(task, calendars);
    if (!calendar || task.status === "cancelled") return [];
    const result: CalendarTask[] = [];
    for (const kind of ["start", "due"] as const) {
      const value = task[kind];
      if (!value || !Number.isFinite(value.getTime())) continue;
      const allDay = task.isAllDay || kind === "due";
      const start = allDay
        ? task.isAllDay
          ? new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
          : options?.consumerTimeZone
            ? new Date(`${instantToCivil(value, options.consumerTimeZone).slice(0, 10)}T00:00:00Z`)
            : new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
        : new Date(value);
      if (allDay && result.some(item => item.isAllDay && item.start.getTime() === start.getTime())) continue;
      const nextDay = new Date(start);
      nextDay.setHours(24, 0, 0, 0);
      if (options?.consumerTimeZone && !allDay) {
        const day = instantToCivil(start, options.consumerTimeZone).slice(0, 10);
        const tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        nextDay.setTime(civilToInstant(`${tomorrow}T00:00:00.000`, options.consumerTimeZone, "explicit")!.getTime());
      }
      result.push({
        id: `calendar-task:${task.id}:${kind}`, calendarTask: task,
        creatorID: task.creatorID, organizer: task.creatorID,
        title: task.title, color: calendar.color, start,
        end: new Date(allDay ? start.getTime() : Math.min(start.getTime() + 30 * 60000, nextDay.getTime())),
        calendars: taskCalendarIDs(task), originCalendarID: taskHomeCalendarID(task),
        isCanceled: false, isAllDay: allDay, hasAttendees: false,
        timeModel: allDay ? { kind: "all-day" } : undefined,
      });
    }
    return result;
  });
}
