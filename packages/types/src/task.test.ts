import assert from "node:assert/strict";
import {
  TaskContentPatchSchema, TaskCreateSchema, TaskDeleteRequestSchema,
  TaskPatchRequestSchema, TaskSchema, requireTaskRevision,
} from "./task";

assert.deepEqual(TaskContentPatchSchema.parse({ title: "Changed" }), { title: "Changed" });
assert.deepEqual(TaskContentPatchSchema.parse({ description: null, due: null }), { description: null, due: null });
for (const field of ["calendarID", "calendarIDs", "originCalendarID", "creatorID", "revision", "sequence", "capabilities"])
  assert.equal(TaskContentPatchSchema.safeParse({ [field]: "injected" }).success, false);
for (const expectedRevision of [undefined, 0, -1, 1.5]) {
  assert.equal(TaskPatchRequestSchema.safeParse({ patch: { status: "completed" }, expectedRevision }).success, false);
  assert.equal(TaskDeleteRequestSchema.safeParse({ expectedRevision }).success, false);
}
assert.equal(TaskPatchRequestSchema.parse({ patch: { status: "completed" }, expectedRevision: 2 }).expectedRevision, 2);
assert.throws(() => requireTaskRevision({}));
assert.equal(requireTaskRevision({ revision: 3 }), 3);
const created = TaskCreateSchema.parse({ id: "task", calendarID: "home", title: "Task", revision: 90, calendarIDs: ["other"], capabilities: { edit: true } });
assert.equal("revision" in created, false);
assert.equal("calendarIDs" in created, false);
assert.equal("capabilities" in created, false);
const legacy = TaskSchema.parse({ ...created, creatorID: "owner" });
assert.equal(legacy.revision, undefined);
console.log("task revision and patch contracts ok");
