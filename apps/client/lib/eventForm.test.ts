// Runnable self-check (no framework): `npx tsx lib/eventForm.test.ts`.
import assert from "node:assert";
import { validateEventForm } from "./eventForm";

const base = { title: "Dinner", calendarCount: 1, start: new Date(2026, 6, 8, 10), end: new Date(2026, 6, 8, 11), url: "" };

// happy path
let r = validateEventForm(base);
assert.equal(r.ok, true);
assert.deepEqual(r.errors, { name: "", calendars: "", start: "", end: "", url: "" });

// empty title
r = validateEventForm({ ...base, title: "" });
assert.equal(r.ok, false);
assert.ok(r.errors.name.length > 0);

// no calendar
r = validateEventForm({ ...base, calendarCount: 0 });
assert.equal(r.ok, false);
assert.ok(r.errors.calendars.length > 0);

// start after end sets both
r = validateEventForm({ ...base, start: new Date(2026, 6, 8, 12), end: new Date(2026, 6, 8, 11) });
assert.equal(r.ok, false);
assert.ok(r.errors.start.length > 0 && r.errors.end.length > 0);

// url validation
assert.equal(validateEventForm({ ...base, url: "https://ok.dev" }).ok, true);
assert.equal(validateEventForm({ ...base, url: "ftp://nope" }).ok, false);
assert.equal(validateEventForm({ ...base, url: "not a url" }).ok, false);

console.log("eventForm.test.ts: all assertions passed");
