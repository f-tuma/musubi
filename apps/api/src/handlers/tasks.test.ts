import assert from "node:assert/strict";
import { can, TaskSchema, TaskStatusSchema } from "@musubi/types";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { parseTaskCreateBody, parseTaskUpdateBody, parseTaskPatchBody, normalizeTaskPatch } = await import("./tasks");

  const created = parseTaskCreateBody({
    id: "00000000-0000-4000-8000-000000000001",
    calendarID: "00000000-0000-4000-8000-000000000002",
    title: "Complete VTODO support",
    status: "completed",
    percentComplete: 20,
  });
  assert.equal(created.percentComplete, 100);
  assert.ok(created.completedAt instanceof Date);

  // Saving another task must not depend on a completion-only representation:
  // all native statuses and recurrence survive the same JSON request/response
  // boundaries used by create, update, and a subsequent list refresh.
  for (const status of TaskStatusSchema.options) {
    const input = {
      id: "00000000-0000-4000-8000-000000000003",
      calendarID: created.calendarID,
      title: `Persist ${status}`,
      status,
      percentComplete: status === "in-process" ? 40 : 0,
      isAllDay: true,
      due: "2026-09-12T00:00:00.000Z",
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=SA",
    };
    const parsed = parseTaskCreateBody(JSON.parse(JSON.stringify(input)));
    const saved = TaskSchema.parse(JSON.parse(JSON.stringify({ ...parsed, creatorID: "owner" })));
    const update = parseTaskUpdateBody(JSON.parse(JSON.stringify(saved)));
    assert.equal(saved.status, status);
    assert.equal(update.status, status);
    assert.equal(saved.percentComplete, status === "completed" ? 100 : input.percentComplete);
    assert.equal(update.recurrence, input.recurrence);
    assert.equal(update.isAllDay, true);
    assert.equal(update.due?.toISOString(), input.due);
  }

  const updated = parseTaskUpdateBody({
    calendarID: "00000000-0000-4000-8000-000000000002",
    title: "Reopened task",
  });
  const protectedUpdate = parseTaskUpdateBody({ ...updated, providerReadRetiredGeneration: 42, expectedProviderReadRetiredGeneration: 7 });
  assert.equal("providerReadRetiredGeneration" in protectedUpdate, false);
  assert.equal(protectedUpdate.expectedProviderReadRetiredGeneration, 7);
  assert.equal("providerReadRetiredGeneration" in parseTaskCreateBody({ ...created, providerReadRetiredGeneration: 42 }), false);
  assert.throws(() => parseTaskUpdateBody({ ...updated, expectedProviderReadRetiredGeneration: -1 }));
  assert.equal(updated.status, "needs-action");
  assert.equal(updated.percentComplete, 0);

  assert.throws(
    () =>
      parseTaskCreateBody({
        id: "not-a-uuid",
        calendarID: "00000000-0000-4000-8000-000000000002",
        title: "Invalid",
      }),
    /task\.id/,
  );
  assert.equal(can("editor", "editTasks"), true);
  assert.equal(can("viewer", "editTasks"), false);

  const partial = parseTaskPatchBody({ expectedRevision: 2, patch: { title: "Only title" } });
  assert.deepEqual(partial.patch, { title: "Only title" });
  assert.throws(() => parseTaskPatchBody({ patch: { title: "Missing CAS" } }));
  assert.throws(() => parseTaskPatchBody({ expectedRevision: 1, patch: { calendarIDs: [created.calendarID] } }));
  assert.throws(() => parseTaskPatchBody({ expectedRevision: 1, patch: { creatorID: "another" } }));
  const completed = TaskSchema.parse({ ...created, creatorID: "owner" });
  assert.deepEqual(normalizeTaskPatch(completed, { status: "needs-action" }), { status: "needs-action", completedAt: null, percentComplete: 0 });
  assert.equal(normalizeTaskPatch(completed, { title: "Keep completion" }).percentComplete, 100);
  assert.equal(normalizeTaskPatch({ ...completed, status: "needs-action", completedAt: null }, { status: "completed" }).percentComplete, 100);

  console.log("task handler contract ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
