import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const [{ TaskSchema }, { canonicalTaskProjection, diffTaskProjection, requireTaskEtag, assertTaskMutationResponse, ProviderTaskWriteError }, { toGoogleTask }, { patchTaskIcal, projectCaldavTask }] = await Promise.all([import("@musubi/types"), import("./task_write"), import("./adapters/google"), import("./adapters/caldav")]);
  const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: "home", title: "Updated", status: "in-process", due: "2026-10-01T14:45:00Z", priority: 2, recurrence: "RRULE:FREQ=DAILY" });
  assert.equal(canonicalTaskProjection(task).due, "2026-10-01T14:45:00.000Z");
  assert.deepEqual(toGoogleTask(task), { title: "Updated", notes: null, status: "needsAction", due: "2026-10-01T00:00:00.000Z" });
  assert.equal(task.status, "in-process");
  assert.equal(task.due!.toISOString(), "2026-10-01T14:45:00.000Z");
  assert.deepEqual(diffTaskProjection({ title: "Before", notes: "Native notes", due: null }, { title: "After", notes: "Native notes", due: null }), { title: "After" });
  assert.throws(() => requireTaskEtag('W/"weak"'), /task-version-unavailable/);
  assert.throws(() => requireTaskEtag(undefined), /task-version-unavailable/);
  assert.equal(requireTaskEtag('"opaque-version"'), '"opaque-version"');
  assert.throws(() => assertTaskMutationResponse(new Response(null, { status: 412 })), error => error instanceof ProviderTaskWriteError && error.code === "task-provider-conflict" && error.outcome === "not-written");
  assert.throws(() => assertTaskMutationResponse(new Response(null, { status: 503 })), error => error instanceof ProviderTaskWriteError && error.outcome === "unconfirmed");
  const completed = { ...task, status: "completed" as const, completedAt: new Date("2026-09-30T15:54:02.972Z") };
  assert.equal(projectCaldavTask(completed).completedAt, "2026-09-30T15:54:02.000Z", "The accepted projection uses the VTODO timestamp precision");
  assert.equal(completed.completedAt.toISOString(), "2026-09-30T15:54:02.972Z", "Provider precision cannot truncate the canonical completion time");

  const native = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:native", "DTSTAMP:20260901T000000Z", "SUMMARY:Before", "DTSTART:20261001T090000Z", "DUE:20261001T100000Z", "RRULE:FREQ=WEEKLY", "X-PRIVATE-VENDOR:retain", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:Native reminder", "END:VALARM", "END:VTODO", "BEGIN:VTODO", "UID:native", "RECURRENCE-ID:20261008T090000Z", "SUMMARY:Exception", "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
  const titleOnly = patchTaskIcal(native, task, "native", { title: "Updated" });
  assert.match(titleOnly, /SUMMARY:Updated/);
  assert.match(titleOnly, /RRULE:FREQ=WEEKLY/);
  assert.match(titleOnly, /RECURRENCE-ID:20261008T090000Z/);
  assert.match(titleOnly, /X-PRIVATE-VENDOR:retain/);
  assert.match(titleOnly, /DESCRIPTION:Native reminder/);
  assert.match(titleOnly, /DUE:20261001T100000Z/);
  assert.throws(() => patchTaskIcal(native, task, "native", { unrelated: true }), /task-projection-unavailable/);
  console.log("Task projections, conditional validators and native-field preservation self-check: OK");
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
