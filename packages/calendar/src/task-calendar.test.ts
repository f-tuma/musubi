import assert from "node:assert/strict";
import { TaskForkAttempts } from "./task-fork-attempts";
import { CalendarSchema, TaskSchema } from "@musubi/types";
import { calendarTasks, isCalendarTask } from "./task-calendar";
import { taskCalendarIDs, taskCapabilities, taskHomeCalendarID, uniqueTasks } from "./task-sharing";
const calendar = CalendarSchema.parse({ id: "cal", creatorID: "owner", name: "Tasks", color: "#123456", role: "owner", members: [], isDefault: false });
const task = TaskSchema.parse({ id: "one", creatorID: "owner", calendarID: "cal", title: "Deadline", start: "2026-09-10T09:00:00Z", due: "2026-09-15T14:00:00Z" });
const projected = calendarTasks([task], [calendar])[0];
assert.ok(isCalendarTask(projected));
assert.equal(projected.start.toISOString(), "2026-09-10T09:00:00.000Z");
assert.equal(projected.end.getTime() - projected.start.getTime(), 1800000);
assert.equal(projected.calendarTask, task);
assert.equal(calendarTasks([{ ...task, due: null }], [calendar])[0].start.getTime(), task.start!.getTime());
assert.equal(calendarTasks([{ ...task, due: null, start: null }], [calendar]).length, 0);
assert.equal(calendarTasks([task], []).length, 0);
assert.equal(calendarTasks([{ ...task, status: "cancelled" }], [calendar]).length, 0);
assert.equal(calendarTasks([{ ...task, status: "completed" }], [calendar]).length, 2);
const allDay = calendarTasks([{ ...task, start: null, isAllDay: true }], [calendar])[0];
assert.equal(allDay.start.toISOString(), "2026-09-15T00:00:00.000Z");
assert.equal(allDay.end.toISOString(), "2026-09-15T00:00:00.000Z");
assert.equal(task.due!.toISOString(), "2026-09-15T14:00:00.000Z");


assert.equal(calendarTasks([{ ...task, isAllDay: true, start: task.due }], [calendar]).length, 1);

const previousZone = process.env.TZ;
for (const zone of ["Europe/Prague", "America/Los_Angeles", "Pacific/Auckland"]) {
  process.env.TZ = zone;
  const date = new Date("2026-09-15T00:30:00Z");
  const deadline = calendarTasks([{ ...task, start: null, due: date }], [calendar])[0];
  assert.equal(deadline.start.getUTCDate(), date.getDate());
  const lateStart = new Date(2026, 8, 15, 23, 50);
  const late = calendarTasks([{ ...task, start: lateStart, due: null }], [calendar])[0];
  assert.equal(late.end.getTime() - late.start.getTime(), 10 * 60000);
}
if (previousZone === undefined) delete process.env.TZ;
else process.env.TZ = previousZone;
console.log("Task calendar projection passed");

const mirror = CalendarSchema.parse({ ...calendar, id: "mirror", role: "editor", name: "Shared" });
const shared = TaskSchema.parse({ ...task, revision: 2, calendarIDs: [calendar.id, mirror.id], originCalendarID: calendar.id });
assert.deepEqual(taskCalendarIDs(shared), [calendar.id, mirror.id]);
assert.equal(calendarTasks([shared, shared], [calendar, mirror]).length, 2);
assert.deepEqual(calendarTasks([shared], [calendar, mirror])[0].calendars, [calendar.id, mirror.id]);
assert.equal(uniqueTasks([shared, shared]).length, 1);
assert.equal(taskCapabilities(shared, [mirror]).edit, false);
assert.equal(taskCapabilities(shared, [calendar, mirror]).edit, true);
assert.equal(taskCapabilities(task, [calendar]).edit, false);
const readableMirror = TaskSchema.parse({ ...shared, calendarIDs: [mirror.id], capabilities: { edit: false, delete: false, link: false, fork: true, unlinkCalendarIDs: [mirror.id] } });
assert.equal(calendarTasks([readableMirror], [mirror]).length, 2);
assert.equal(calendarTasks([readableMirror], [mirror])[0].originCalendarID, calendar.id);
assert.equal(taskHomeCalendarID({ ...readableMirror, originCalendarID: null }), undefined);
assert.equal(taskCapabilities(readableMirror, [mirror]).edit, false);


// A lost fork response retries the same attempt; only an acknowledgement starts a new copy.
let attemptSequence = 0;
const attempts = new TaskForkAttempts(() => `attempt-${++attemptSequence}`);
const source = { ...task, revision: 4 };
const first = attempts.get("server/actor-a", source, "destination");
assert.equal(attempts.get("server/actor-a", source, "destination"), first);
assert.notEqual(attempts.get("server/actor-a", source, "other"), first);
assert.notEqual(attempts.get("server/actor-a", { ...source, revision: 5 }, "destination"), first);
assert.notEqual(attempts.get("server/actor-a", { ...source, providerReadRetiredGeneration: 1 }, "destination"), first);
attempts.acknowledge(first);
assert.notEqual(attempts.get("server/actor-a", source, "destination"), first);
const anotherActor = attempts.get("server/actor-b", source, "destination");
assert.notEqual(attempts.get("server/actor-a", source, "destination"), anotherActor);

assert.equal(uniqueTasks([{ ...task, revision: 5 }, { ...task, revision: 3 }])[0].revision, 5);
assert.equal(uniqueTasks([{ ...task, revision: 5, providerReadRetiredGeneration: 1 }, { ...task, revision: 5 }])[0].providerReadRetiredGeneration, 1);
