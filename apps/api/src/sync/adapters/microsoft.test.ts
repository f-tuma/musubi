// Runnable self-check (no framework): `npx tsx src/sync/adapters/microsoft.test.ts`
// from apps/api. Dummy env so @musubi/config (pulled in transitively) can load;
// set before the dynamic import (tsx emits CJS, so a static import would hoist).
import assert from "node:assert";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { parseGraphDate, toNormalized, toGraphEvent, parseCursor } = await import("./microsoft");

  // parseGraphDate: 7-digit fraction, no zone designator → UTC instant
  assert.equal(parseGraphDate("2026-07-18T20:30:00.0000000").toISOString(), "2026-07-18T20:30:00.000Z");
  assert.equal(parseGraphDate("2026-07-18T20:30:00").toISOString(), "2026-07-18T20:30:00.000Z");

  // toNormalized: @removed → cancelled tombstone
  assert.equal(toNormalized({ id: "x", "@removed": { reason: "deleted" } }).status, "cancelled");

  // toNormalized: timed event
  const timed = toNormalized({
    id: "e1",
    subject: "Standup",
    isAllDay: false,
    start: { dateTime: "2026-07-18T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-07-18T09:30:00.0000000", timeZone: "UTC" },
    body: { contentType: "text", content: "  \r\n" }, // whitespace-only → null
    organizer: { emailAddress: { address: "boss@example.com" } },
  });
  assert.equal(timed.title, "Standup");
  assert.equal(timed.description, null);
  assert.equal(timed.organizer, "boss@example.com");
  assert.equal(timed.recurrence, null);
  assert.equal(timed.end.toISOString(), "2026-07-18T09:30:00.000Z");

  // toNormalized: all-day — Graph end is exclusive → pull shifts it back one day
  const allDay = toNormalized({
    id: "e2",
    subject: "Holiday",
    isAllDay: true,
    start: { dateTime: "2026-07-18T00:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-07-19T00:00:00.0000000", timeZone: "UTC" },
  });
  assert.equal(allDay.start.toISOString(), "2026-07-18T00:00:00.000Z");
  assert.equal(allDay.end.toISOString(), "2026-07-18T00:00:00.000Z");

  // toGraphEvent: all-day round trip — push shifts the end forward one day
  const pushed = toGraphEvent({
    title: "Holiday",
    isAllDay: true,
    start: new Date("2026-07-18T00:00:00Z"),
    end: new Date("2026-07-18T00:00:00Z"),
    description: null,
    location: null,
    recurrence: null,
  } as any);
  assert.equal(pushed.start.dateTime, "2026-07-18T00:00:00");
  assert.equal(pushed.end.dateTime, "2026-07-19T00:00:00");
  assert.equal(pushed.isAllDay, true);

  // toGraphEvent: recurring events are rejected, not silently flattened
  assert.throws(() => toGraphEvent({ recurrence: "FREQ=DAILY", isAllDay: false, start: new Date(), end: new Date() } as any));

  // nearestMicrosoftCalendarColor: exact preset, nearby shade, garbage fallback
  const { nearestMicrosoftCalendarColor, MICROSOFT_CALENDAR_COLORS } = await import("@musubi/types");
  assert.equal(nearestMicrosoftCalendarColor("#6BB55C").name, "lightGreen");
  assert.equal(nearestMicrosoftCalendarColor("#e21d1d").name, "lightRed");
  assert.equal(nearestMicrosoftCalendarColor("not-a-color").name, MICROSOFT_CALENDAR_COLORS[0].name);

  // parseCursor: valid JSON cursor, garbage, and null
  assert.deepEqual(parseCursor(JSON.stringify({ link: "https://g/delta?x", windowEnd: 123 })), { link: "https://g/delta?x", windowEnd: 123 });
  assert.equal(parseCursor("https://plain-url-from-older-code"), null);
  assert.equal(parseCursor(null), null);

  console.log("microsoft adapter self-check: OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
