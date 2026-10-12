import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { reconcileExternalChanges } = await import("./engine");
  const { activeEvent, cancelledEvent, deletedTask, task } = fixtures();
  const calls: string[] = [];

  const changed = await reconcileExternalChanges(
    [
      { kind: "event", data: activeEvent },
      { kind: "event", data: cancelledEvent },
      { kind: "task", data: task },
      { kind: "task", data: deletedTask },
    ],
    true,
    {
      async deleteEvent(id) {
        calls.push(`delete:${id}`);
        return true;
      },
      async deleteTask(id) {
        calls.push(`delete-task:${id}`);
        return true;
      },
      async upsertEvent(event) {
        calls.push(`event:${event.externalId}`);
        return true;
      },
      async upsertTask(importedTask) {
        calls.push(`task:${importedTask.externalId}`);
        return true;
      },
      async sweepEvents(seen) {
        calls.push(`sweep-events:${seen.join(",")}`);
        return 1;
      },
      async sweepTasks(seen) {
        calls.push(`sweep-tasks:${seen.join(",")}`);
        return 1;
      },
    },
  );

  assert.equal(changed, 6);
  assert.deepEqual(calls, [
    "event:event-1",
    "delete:event-cancelled",
    "task:task-1",
    "delete-task:task-deleted",
    "sweep-events:event-1",
    "sweep-tasks:task-1",
  ]);

  // An ETag-aware upsert reports false; a delta must stay quiet and never sweep.
  const noResetCalls: string[] = [];
  assert.equal(
    await reconcileExternalChanges([{ kind: "task", data: task }], false, {
      async deleteEvent() {
        throw new Error("unexpected event deletion");
      },
      async deleteTask() {
        throw new Error("unexpected task deletion");
      },
      async upsertEvent() {
        throw new Error("unexpected event upsert");
      },
      async upsertTask(importedTask) {
        noResetCalls.push(importedTask.externalId);
        return false;
      },
      async sweepEvents() {
        throw new Error("delta sync must not sweep events");
      },
      async sweepTasks() {
        throw new Error("delta sync must not sweep tasks");
      },
    }),
    0,
  );
  assert.deepEqual(noResetCalls, ["task-1"]);

  // Even a native absence assertion grants no authority to the generic
  // reconciler. Its source/checkpoint-fenced host path must interpret it.
  const unexpected = async (): Promise<never> => { throw new Error("Absence mutated through the generic writer"); };
  assert.equal(await reconcileExternalChanges([
    { kind: "event-absence", externalId: "outside-window", reason: "window-removal" },
    { kind: "event-absence", externalId: "native-404", reason: "window-removal", deletionEvidence: {
      kind: "scoped-native-absence", responseStatus: 404, readAuthorityVerified: true,
      nativeReadProfile: "graph-event-double-404-calendar-v1",
    } },
  ], false, {
    deleteEvent: unexpected, deleteTask: unexpected, upsertEvent: unexpected,
    upsertTask: unexpected, sweepEvents: unexpected, sweepTasks: unexpected,
  }), 0);

  console.log("mixed event/task reconciliation self-check: OK");
}

function fixtures() {
  const activeEvent = {
    description: null,
    end: new Date("2026-02-01T11:00:00Z"),
    externalId: "event-1",
    isAllDay: false,
    location: null,
    organizer: null,
    recurrence: null,
    start: new Date("2026-02-01T10:00:00Z"),
    status: "active" as const,
    title: "Event",
    url: null,
  };
  const cancelledEvent = {
    ...activeEvent,
    externalId: "event-cancelled",
    status: "cancelled" as const,
  };
  const task = {
    completedAt: null,
    description: null,
    due: null,
    externalId: "task-1",
    isAllDay: false,
    percentComplete: 0,
    priority: 0,
    recurrence: null,
    relatedTo: null,
    sequence: 0,
    start: null,
    status: "needs-action" as const,
    title: "Task",
    url: null,
  };
  const deletedTask = { ...task, deleted: true, externalId: "task-deleted" };
  return { activeEvent, cancelledEvent, deletedTask, task };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
