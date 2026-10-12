import assert from "node:assert/strict";
import ICAL from "ical.js";
import { EventSchema, TaskSchema } from "@musubi/types";
import {
  encodeEventV1, encodeTaskV1, applyCaldavEventPlanV1, applyCaldavTaskPlanV1,
  parseNativeWritePlanV1, matchesPinnedProjectionV1, restrictCaldavTaskPlanV1, restrictJsonBodyPlanV1,
  type CaldavPropertyPlanV1, type SyncCodecProvider,
} from "./index";

const operationId = "00000000-0000-4000-8000-000000000071";
const context = { action: "create" as const, operationId, acceptedAt: "2026-10-12T07:08:09.123Z" };
const event = EventSchema.parse({ id: "00000000-0000-4000-8000-000000000072", creatorID: "owner", organizer: "",
  title: "Accepted", color: "red", calendars: [], isCanceled: false, isAllDay: false,
  start: "2026-10-12T08:00:00.456Z", end: "2026-10-12T09:00:00.789Z", description: "  Notes  ", location: "  Room  " });
const task = TaskSchema.parse({ id: "00000000-0000-4000-8000-000000000073", creatorID: "owner", calendarID: "home",
  title: "Task", description: "Notes", due: "2026-10-12T14:30:00.789Z", start: "2026-10-11T10:00:00.123Z",
  completedAt: "2026-10-12T14:30:10.567Z", status: "completed", percentComplete: 100, priority: 1, sequence: 7 });
const providers: SyncCodecProvider[] = ["google", "microsoft", "caldav"];
const savedNow = Date.now;
Date.now = () => { throw new Error("Codec must not consult ambient clock"); };
try {
  for (const provider of providers) {
    const encoded = encodeEventV1(provider, event, undefined, context);
    assert.deepEqual(encodeEventV1(provider, event, undefined, context), encoded);
    assert.ok(parseNativeWritePlanV1(encoded.serializer, "create", "event", encoded.nativePlan.data));
    assert.equal(matchesPinnedProjectionV1(encoded.serializer,"create",encoded.admittedProjection.data,encoded.nativePlan.data),true);
    assert.equal(matchesPinnedProjectionV1(encoded.serializer,"create",{...encoded.admittedProjection.data,title:"Old remote title"},encoded.nativePlan.data),false);
    const encodedTask = encodeTaskV1(provider, task, undefined, context);
    assert.deepEqual(encodeTaskV1(provider, task, undefined, context), encodedTask);
    assert.ok(parseNativeWritePlanV1(encodedTask.serializer, "create", "task", encodedTask.nativePlan.data));
    assert.equal(matchesPinnedProjectionV1(encodedTask.serializer,"create",encodedTask.admittedProjection.data,encodedTask.nativePlan.data),true);
    assert.equal(matchesPinnedProjectionV1(encodedTask.serializer,"create",{},encodedTask.nativePlan.data),false);
    assert.equal(matchesPinnedProjectionV1(encodedTask.serializer,"create",{...encodedTask.admittedProjection.data,title:"Old remote task"},encodedTask.nativePlan.data),false);
  }
} finally { Date.now = savedNow; }
for (const provider of ["google", "microsoft"] as const) {
  const cancelledDelete=encodeEventV1(provider,{...event,isCanceled:true},undefined,{...context,action:"delete"});
  assert.deepEqual(cancelledDelete.nativePlan.data,{planKind:"json-body",body:null});
  assert.ok(parseNativeWritePlanV1(cancelledDelete.serializer,"delete","event",cancelledDelete.nativePlan.data));
}
assert.throws(()=>encodeEventV1("google",{...event,isCanceled:true},undefined,context));
const google = encodeEventV1("google", event, undefined, context);
if (google.nativePlan.data.planKind !== "json-body") throw new Error("Wrong Google plan");
assert.equal(google.nativePlan.data.body!.id, "musubi" + operationId.replace(/-/g, ""));
assert.deepEqual(google.nativePlan.data.body!.extendedProperties, { private: { musubiOperationID: operationId } });
const graph = encodeEventV1("microsoft", event, undefined, context);
if (graph.nativePlan.data.planKind !== "json-body") throw new Error("Wrong Graph plan");
assert.equal(graph.nativePlan.data.body!.transactionId, operationId);
assert.equal(graph.admittedProjection.data.description, "Notes");
assert.equal(graph.admittedProjection.data.location, "Room");
const updated = encodeEventV1("microsoft", { ...event, description: null }, { description: null }, { ...context, action: "update" });
if (updated.nativePlan.data.planKind !== "json-body") throw new Error("Wrong update plan");
assert.deepEqual(updated.nativePlan.data.body, { body: { contentType: "text", content: "" } });
assert.equal(matchesPinnedProjectionV1(updated.serializer,"update",updated.admittedProjection.data,updated.nativePlan.data),true);
assert.equal(matchesPinnedProjectionV1(updated.serializer,"update",{...updated.admittedProjection.data,description:"Not cleared"},updated.nativePlan.data),false);
assert.throws(() => encodeEventV1("microsoft", event, { start: event.start }, { ...context, action: "update" }));
assert.throws(() => encodeEventV1("google", { ...event, timeModel: { kind: "floating", startLocal: "2026-10-12T08:00:00.000", endLocal: "2026-10-12T09:00:00.000" } }, undefined, context));

const allDay = { ...event, isAllDay: true, start: new Date("2028-02-28T00:00:00Z"), end: new Date("2028-02-29T00:00:00Z"),
  recurrence: "RRULE:FREQ=DAILY;COUNT=4\nEXDATE;VALUE=DATE:20280229\nRDATE;VALUE=DATE:20280304" };
for (const provider of ["google", "caldav"] as const) {
  const plan = encodeEventV1(provider, allDay, undefined, context);
  assert.equal(plan.admittedProjection.data.start, "2028-02-28T00:00:00.000Z");
  assert.equal(plan.admittedProjection.data.end, "2028-02-29T00:00:00.000Z");
  assert.ok(parseNativeWritePlanV1(plan.serializer, "create", "event", plan.nativePlan.data));
  assert.equal(matchesPinnedProjectionV1(plan.serializer,"create",plan.admittedProjection.data,plan.nativePlan.data),true);
  assert.equal(matchesPinnedProjectionV1(plan.serializer,"create",{...plan.admittedProjection.data,end:"2028-03-01T00:00:00.000Z"},plan.nativePlan.data),false);
}
assert.throws(() => encodeEventV1("microsoft", allDay, undefined, context));
// DATE and dateTime endpoint mode is part of the saved UPDATE target, even
// when just one endpoint changes. Content-only plans still validate its shape.
for (const patch of [{ start: allDay.start }, { end: allDay.end }, { start: allDay.start, end: allDay.end }]) {
  const dateUpdate = encodeEventV1("google", allDay, patch, { ...context, action: "update" });
  assert.equal(matchesPinnedProjectionV1(dateUpdate.serializer, "update", dateUpdate.admittedProjection.data, dateUpdate.nativePlan.data), true);
  assert.equal(matchesPinnedProjectionV1(dateUpdate.serializer, "update", { ...dateUpdate.admittedProjection.data, isAllDay: false }, dateUpdate.nativePlan.data), false,
    "a DATE update cannot claim a timed admitted target");
}
const timedUpdate = encodeEventV1("google", { ...event, start: allDay.start, end: allDay.end }, { start: allDay.start }, { ...context, action: "update" });
assert.equal(matchesPinnedProjectionV1(timedUpdate.serializer, "update", { ...timedUpdate.admittedProjection.data, isAllDay: true }, timedUpdate.nativePlan.data), false,
  "a dateTime update cannot claim an all-day admitted target");
for (const action of ["update", "delete"] as const) {
  const dateTarget = encodeEventV1("google", allDay, action === "update" ? {} : undefined, { ...context, action });
  assert.equal(matchesPinnedProjectionV1(dateTarget.serializer, action, dateTarget.admittedProjection.data, dateTarget.nativePlan.data), true);
  for (const key of ["start", "end"]) {
    assert.equal(matchesPinnedProjectionV1(dateTarget.serializer, action,
      { ...dateTarget.admittedProjection.data, [key]: "2028-02-28T01:00:00.000Z" }, dateTarget.nativePlan.data), false,
      "all-day saved targets must use UTC midnight");
  }
}

const dav = encodeEventV1("caldav", event, undefined, context);
assert.equal(dav.admittedProjection.data.start, "2026-10-12T08:00:00.000Z");
const todo = encodeTaskV1("caldav", task, undefined, context);
if (todo.nativePlan.data.planKind !== "caldav-properties") throw new Error("Wrong TODO plan");
assert.match(todo.nativePlan.data.createResource, /DTSTAMP:20261012T070809Z/);
assert.equal(todo.admittedProjection.data.due, "2026-10-12T14:30:00.000Z");
assert.equal(encodeTaskV1("google", task, undefined, context).admittedProjection.data.due, "2026-10-12T00:00:00.000Z");

// Apply uses only pinned component+field plan, retaining unrelated bytes and parameters.
const original = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:upstream\r\nX-CALENDAR:keep\r\nBEGIN:VTIMEZONE\r\nTZID:UTC\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:native-uid\r\nDTSTART;TZID=UTC:20261012T080000\r\nDTEND;TZID=UTC:20261012T090000\r\nSUMMARY;LANGUAGE=cs:Old\r\nDESCRIPTION:Rich provider note\r\nX-EXTRA:keep\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:keep alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
const davUpdate = encodeEventV1("caldav", { ...event, title: "Changed" }, { title: "Changed" }, { ...context, action: "update", uid: "native-uid" });
if (davUpdate.nativePlan.data.planKind !== "caldav-properties") throw new Error("Wrong DAV plan");
assert.equal(matchesPinnedProjectionV1(davUpdate.serializer,"update",davUpdate.admittedProjection.data,davUpdate.nativePlan.data),true);
assert.equal(matchesPinnedProjectionV1(davUpdate.serializer,"update",{...davUpdate.admittedProjection.data,title:"Old remote title"},davUpdate.nativePlan.data),false);
const changed = applyCaldavEventPlanV1(original, davUpdate.nativePlan.data);
assert.equal(changed, original.replace("SUMMARY;LANGUAGE=cs:Old", "SUMMARY;LANGUAGE=cs:Changed"));
const clears = encodeEventV1("caldav", { ...event, description: null }, { description: null }, { ...context, action: "update", uid: "native-uid" });
assert.equal(applyCaldavEventPlanV1(original, clears.nativePlan.data as CaldavPropertyPlanV1), original.replace("DESCRIPTION:Rich provider note\r\n", ""));
const timeUpdate = encodeEventV1("caldav", { ...event, start: new Date("2026-10-12T08:30:00Z") }, { start: new Date("2026-10-12T08:30:00Z") }, { ...context, action: "update", uid: "native-uid" });
assert.match(applyCaldavEventPlanV1(original, timeUpdate.nativePlan.data as CaldavPropertyPlanV1), /DTSTART;TZID=UTC:20261012T083000/);
assert.throws(() => applyCaldavEventPlanV1(original.replace("UID:native-uid", "UID:other"), davUpdate.nativePlan.data as CaldavPropertyPlanV1));
assert.throws(() => applyCaldavEventPlanV1(original.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:native-uid\r\nEND:VEVENT\r\nEND:VCALENDAR"), davUpdate.nativePlan.data as CaldavPropertyPlanV1));
const todoOriginal = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-uid\r\nSUMMARY:Old task\r\nDUE;TZID=UTC:20261012T143000\r\nX-PROVIDER:keep\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
const todoUpdate = encodeTaskV1("caldav", task, undefined, { ...context, action: "update", uid: "todo-uid" });
assert.equal(matchesPinnedProjectionV1(todoUpdate.serializer,"update",{},todoUpdate.nativePlan.data),false);
assert.equal(matchesPinnedProjectionV1(todoUpdate.serializer,"update",todoUpdate.admittedProjection.data,todoUpdate.nativePlan.data),true);
assert.equal(matchesPinnedProjectionV1(todoUpdate.serializer,"update",{...todoUpdate.admittedProjection.data,due:"2026-10-12T14:30:00.789Z"},todoUpdate.nativePlan.data),false);
const todoPlan = restrictCaldavTaskPlanV1(todoUpdate.nativePlan.data as CaldavPropertyPlanV1, ["title"]);
assert.equal(applyCaldavTaskPlanV1(todoOriginal, todoPlan), todoOriginal.replace("SUMMARY:Old task", "SUMMARY:Task"));
if (google.nativePlan.data.planKind === "json-body") assert.deepEqual(restrictJsonBodyPlanV1(google.nativePlan.data, ["summary"]).body, { summary: "Accepted" });

// Strict semantic decoder rejects transport escape hatches and wrong provider/action/family.
for (const value of [{ planKind: "http", body: {} }, { planKind: "json-body", body: { headers: { Authorization: "secret" } } },
  { planKind: "json-body", body: { summary: "Changed", start: { dateTime: "invalid" } } }]) {
  assert.equal(parseNativeWritePlanV1({ id: "google-personal-event", version: 1 }, "update", "event", value), undefined);
}
assert.equal(parseNativeWritePlanV1({ id: "google-personal-event", version: 2 }, "create", "event", google.nativePlan.data), undefined);
assert.equal(parseNativeWritePlanV1({ id: "google-task", version: 1 }, "create", "event", google.nativePlan.data), undefined);
assert.equal(parseNativeWritePlanV1({ id: "microsoft-personal-event", version: 1 }, "update", "event", { planKind: "json-body", body: { start: { dateTime: "2026-10-12T08:00:00Z", timeZone: "UTC" } } }), undefined);
assert.equal(parseNativeWritePlanV1(davUpdate.serializer, "update", "event", { ...davUpdate.nativePlan.data, replacementComponent: davUpdate.nativePlan.data.replacementComponent.replace("END:VEVENT", "ATTENDEE:mailto:someone@example.test\r\nEND:VEVENT") }), undefined);

// Test-only legacy adapters provide independent parity evidence; runtime package imports none.
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";
const [{ googleAdapter }, { microsoftAdapter }, { caldavAdapter, patchEventIcal, patchTaskIcal }] = await Promise.all([
  import("../../../apps/api/src/sync/adapters/google"),
  import("../../../apps/api/src/sync/adapters/microsoft"),
  import("../../../apps/api/src/sync/adapters/caldav"),
]);
for (const [provider, adapter] of [["google", googleAdapter], ["microsoft", microsoftAdapter], ["caldav", caldavAdapter]] as const) {
  const plan = encodeEventV1(provider, event, undefined, context);
  const oldProjection = adapter.projectEvent!(event);
  const fields = Object.fromEntries(["title", "start", "end", "isAllDay", "description", "location", "recurrence"].map(key => [key, oldProjection[key as keyof typeof oldProjection]]));
  assert.deepEqual(plan.admittedProjection.data, JSON.parse(JSON.stringify(fields)));
  assert.deepEqual(encodeTaskV1(provider, task, undefined, context).admittedProjection.data, JSON.parse(JSON.stringify(adapter.projectTask!(task))));
}
assert.equal(changed, patchEventIcal(original, { ...event, title: "Changed" }, "native-uid", { title: "Changed" }));
const taskReference = patchTaskIcal(todoOriginal, task, "todo-uid", { title: task.title });
assert.equal(new ICAL.Component(ICAL.parse(applyCaldavTaskPlanV1(todoOriginal, todoPlan))).getFirstSubcomponent("vtodo")!.getFirstPropertyValue("summary"),
  new ICAL.Component(ICAL.parse(taskReference)).getFirstSubcomponent("vtodo")!.getFirstPropertyValue("summary"));
console.log("Pinned sync codec v1: pure fixed clock, wire parity, DATE/task precision, nullable clears, strict plan decoding and preserving DAV merges OK");
