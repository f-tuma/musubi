// Runnable self-check (no framework): `npx tsx lib/ics.test.ts`.
import assert from "node:assert";
import { parseICS } from "./ics";

// Folded line, escaped comma, UTC time, explicit end.
const timed = parseICS(
  "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Lunch\\, then walk\r\nDESCRIPTION:line one\r\n more\r\nLOCATION:Cafe\r\nDTSTART:20260708T120000Z\r\nDTEND:20260708T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"
)!;
assert.equal(timed.title, "Lunch, then walk");
assert.equal(timed.description, "line onemore");
assert.equal(timed.location, "Cafe");
assert.equal(timed.isAllDay, false);
assert.equal(timed.start.toISOString(), "2026-07-08T12:00:00.000Z");
assert.equal(timed.end.toISOString(), "2026-07-08T13:00:00.000Z");

// All-day (VALUE=DATE), missing DTEND → +1 day.
const allDay = parseICS("BEGIN:VEVENT\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20260708\nEND:VEVENT")!;
assert.equal(allDay.isAllDay, true);
assert.equal(allDay.end.getTime() - allDay.start.getTime(), 86400000);

// No DTSTART → unparseable.
assert.equal(parseICS("BEGIN:VEVENT\nSUMMARY:Nope\nEND:VEVENT"), null);

console.log("ics ok");
