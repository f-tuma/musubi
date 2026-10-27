import assert from "node:assert/strict";
import {
  OUTLOOK_MOVE_LIMIT,
  OutlookMoveOptionsSchema,
  OutlookMoveResultSchema,
} from "./outlook-move";
import { OrganizerDispatchSchema } from "./provider-organizer";
import {
  CaldavRsvpDeliverySchema,
  GoogleRsvpDeliverySchema,
  GraphRsvpDispatchSchema,
  googleRsvpDeliveryPolicy,
} from "./provider-rsvp";

const eventID = "00000000-0000-4000-8000-000000000001";
const stamp = "2026-10-27T09:30Z";
const end = "2026-10-27T10:30Z";
const occurrence = { eventID, start: stamp, end };
const options = {
  eventID, calendarID: eventID, version: "frozen-observation", title: "Move",
  meeting: false, timeZone: "UTC",
  preserved: { edited: 1, cancelled: 0, unavailable: 0 },
  occurrences: [occurrence],
};
const item = { ...occurrence, newStart: end, newEnd: "2026-10-27T11:30Z", status: "pending" };
const result = {
  operationID: eventID, eventID, title: "Move", meeting: false,
  timeZone: "UTC", status: "preview", expiresAt: end, offsetMinutes: 60,
  items: [item],
};

// Existing previews and saved move results use UTC strings without coercion.
// Every timestamp position must keep accepting the original minute precision.
assert.deepEqual(OutlookMoveOptionsSchema.parse(options), options);
assert.deepEqual(OutlookMoveResultSchema.parse(result), result);
assert.equal(OutlookMoveOptionsSchema.safeParse({ ...options, extra: true }).success, false);
assert.equal(OutlookMoveOptionsSchema.safeParse({
  ...options, occurrences: [{ ...occurrence, extra: true }],
}).success, false);
assert.equal(OutlookMoveOptionsSchema.safeParse({ ...options, timeZone: "+02:00" }).success, false);
assert.equal(OutlookMoveResultSchema.safeParse({ ...result, extra: true }).success, false);
assert.equal(OutlookMoveResultSchema.safeParse({ ...result, items: [] }).success, false);
assert.equal(OutlookMoveResultSchema.safeParse({
  ...result, items: Array.from({ length: OUTLOOK_MOVE_LIMIT + 1 }, () => item),
}).success, false);
assert.equal(OutlookMoveResultSchema.safeParse({
  ...result, items: [{ ...item, status: "unknown" }],
}).success, false);

const graph = { kind: "graph-rsvp-dispatch", version: 1, startedAt: stamp, acceptedAt: end };
const caldav = { kind: "caldav-rsvp-at-most-once", version: 1, startedAt: stamp };
const google = { kind: "google-rsvp-at-most-once", version: 1, startedAt: stamp };
const organizer = {
  kind: "google-organizer-dispatch", version: 1, startedAt: stamp, acceptedAt: end,
  cancellationTombstone: { revision: 1, deletedAt: end },
};
for (const [schema, value] of [
  [GraphRsvpDispatchSchema, graph],
  [CaldavRsvpDeliverySchema, caldav],
  [GoogleRsvpDeliverySchema, google],
  [OrganizerDispatchSchema, organizer],
] as const) {
  assert.deepEqual(schema.parse(value), value, `${value.kind} preserves saved minute timestamps`);
  assert.equal(schema.safeParse({ ...value, version: 2 }).success, false, value.kind);
  assert.equal(schema.safeParse({ ...value, extra: true }).success, false, value.kind);
  assert.equal(schema.safeParse({ ...value, startedAt: null }).success, false, value.kind);
}
assert.deepEqual(GraphRsvpDispatchSchema.parse({
  kind: graph.kind, version: 1, startedAt: stamp,
}), { kind: graph.kind, version: 1, startedAt: stamp });
assert.equal(GraphRsvpDispatchSchema.safeParse({ kind: graph.kind, version: 1 }).success, false);
for (const [schema, kind] of [
  [CaldavRsvpDeliverySchema, caldav.kind],
  [GoogleRsvpDeliverySchema, google.kind],
] as const) {
  assert.deepEqual(schema.parse({ kind, version: 1 }), { kind, version: 1 });
}
for (const kind of [
  "google-organizer-dispatch", "caldav-organizer-dispatch", "microsoft-organizer-dispatch",
]) {
  assert.deepEqual(OrganizerDispatchSchema.parse({ kind, version: 1, startedAt: stamp }), {
    kind, version: 1, startedAt: stamp,
  });
}
assert.equal(OrganizerDispatchSchema.safeParse({ kind: organizer.kind, version: 1 }).success, false);
for (const revision of [0, -1, 1.5]) {
  assert.equal(OrganizerDispatchSchema.safeParse({
    ...organizer, cancellationTombstone: { revision, deletedAt: end },
  }).success, false);
}
assert.equal(OrganizerDispatchSchema.safeParse({
  ...organizer, cancellationTombstone: { revision: 1, deletedAt: end, extra: true },
}).success, false);

// Minute precision must not turn a previously started delivery back into write
// permission. Invoke the production recovery policy as well as the schema.
assert.deepEqual(googleRsvpDeliveryPolicy({ googleDelivery: google }), {
  observeOnly: true, delivery: google,
});
assert.deepEqual(googleRsvpDeliveryPolicy({ googleDelivery: { kind: google.kind, version: 1 } }), {
  observeOnly: false, delivery: { kind: google.kind, version: 1 },
});
assert.deepEqual(googleRsvpDeliveryPolicy({}), { observeOnly: true });

for (const invalid of [
  "2026-10-27T09:30+02:00", "2026-10-27T09:30", "2026-10-27T09:30z",
  "2026-02-29T09:30Z", "2026-10-27T24:00Z", "2026-10-27T09:60Z",
  "2026-10-27T09:30:60Z", "2026-10-27T09:30Z trailing",
]) {
  for (const field of ["start", "end"]) {
    assert.equal(OutlookMoveOptionsSchema.safeParse({
      ...options, occurrences: [{ ...occurrence, [field]: invalid }],
    }).success, false, `${field}: ${invalid}`);
  }
  for (const field of ["start", "end", "newStart", "newEnd"]) {
    assert.equal(OutlookMoveResultSchema.safeParse({
      ...result, items: [{ ...item, [field]: invalid }],
    }).success, false, `${field}: ${invalid}`);
  }
  assert.equal(OutlookMoveResultSchema.safeParse({ ...result, expiresAt: invalid }).success, false, invalid);
  for (const [schema, value] of [
    [GraphRsvpDispatchSchema, graph],
    [CaldavRsvpDeliverySchema, caldav],
    [GoogleRsvpDeliverySchema, google],
    [OrganizerDispatchSchema, organizer],
  ] as const) {
    assert.equal(schema.safeParse({ ...value, startedAt: invalid }).success, false, invalid);
  }
  assert.equal(GraphRsvpDispatchSchema.safeParse({ ...graph, acceptedAt: invalid }).success, false, invalid);
  assert.equal(OrganizerDispatchSchema.safeParse({ ...organizer, acceptedAt: invalid }).success, false, invalid);
  assert.equal(OrganizerDispatchSchema.safeParse({
    ...organizer, cancellationTombstone: { revision: 1, deletedAt: invalid },
  }).success, false, invalid);
  assert.throws(() => googleRsvpDeliveryPolicy({ googleDelivery: { ...google, startedAt: invalid } }));
}

console.log("persisted sidecar and Outlook timestamp compatibility ok");
