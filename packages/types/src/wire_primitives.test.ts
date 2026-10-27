import assert from "node:assert/strict";
import { EventCreateRequestSchema, EventPatchRequestSchema } from "./event";
import { CivilDateTimeSchema, OccurrenceStartSchema } from "./event_time";
import { UserSchema } from "./user";

const event = {
  id: "00000000-0000-4000-8000-000000000001",
  creatorID: "owner",
  organizer: "owner",
  title: "Legacy timestamp",
  color: "red",
  calendars: [],
  isAllDay: false,
  isCanceled: false,
};

// Zod 4.4.3 accepted minute-only qualified timestamps. A dependency update
// cannot silently refuse requests from clients compiled against that contract.
for (const value of [
  "2026-10-27T09:30Z",
  "2026-10-27T09:30+02:00",
  "2026-10-27T09:30-05:30",
  "2026-10-27T09:30:59.123Z",
  "2028-02-29T00:00Z",
  "2000-02-29T23:59+00:00",
]) {
  const expected = new Date(value).toISOString();
  const created = EventCreateRequestSchema.parse({ ...event, start: value, end: value });
  assert.equal(created.start.toISOString(), expected, `create accepts ${value}`);
  const patched = EventPatchRequestSchema.parse({
    id: event.id, expectedRevision: 1, patch: { start: value, end: value },
  });
  assert.equal(patched.patch.end?.toISOString(), expected, `patch accepts ${value}`);
}

for (const value of [
  "2026-02-29T09:30Z", "1900-02-29T09:30Z", "2026-04-31T09:30Z",
  "2026-10-27T24:00Z", "2026-10-27T09:60Z", "2026-10-27T09:30:60Z",
  "2026-10-27T09:30+24:00", "2026-10-27T09:30+02:60",
  "2026-10-27T09:30", "2026-10-27T09:30z", "2026-10-27T09:30Z trailing",
]) {
  assert.equal(EventPatchRequestSchema.safeParse({
    id: event.id, expectedRevision: 1, patch: { start: value },
  }).success, false, `patch rejects ${value}`);
}

for (const value of ["2026-10-27T09:30Z", "2028-02-29T00:00Z"]) {
  assert.deepEqual(OccurrenceStartSchema.parse({ kind: "instant", value }), {
    kind: "instant", value: new Date(value).toISOString(),
  });
}
for (const value of [
  "2026-10-27T09:30+02:00", "2026-10-27T09:30:00.0001Z", "2026-02-29T09:30Z",
]) {
  assert.equal(OccurrenceStartSchema.safeParse({ kind: "instant", value }).success, false, value);
}
assert.equal(CivilDateTimeSchema.parse("2028-02-29T09:30:00.1"), "2028-02-29T09:30:00.100");
for (const value of [
  "2026-10-27T09:30", "2026-10-27T09:30Z", "2026-10-27T09:30:00Z",
  "2026-10-27T09:30:00+02:00", "2026-10-27T09:30:00.0001", "2026-02-29T09:30:00",
]) {
  assert.equal(CivilDateTimeSchema.safeParse(value).success, false, value);
}

for (const email of ["a@example.com", "a.b+tag@example-domain.co", "a'b_+c@example.com"]) {
  assert.equal(UserSchema.parse({ id: "user", name: "User", email }).email, email);
}
for (const email of [
  ".a@example.com", "a..b@example.com", "a.@example.com", "a'@example.com",
  "a@-example.com", "a@example.c", "a@example.123", "a b@example.com", "a@exämple.com",
]) {
  assert.equal(UserSchema.safeParse({ id: "user", name: "User", email }).success, false, email);
}

console.log("wire primitive runtime compatibility ok");
