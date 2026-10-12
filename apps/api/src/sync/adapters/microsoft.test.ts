// Runnable self-check (no framework): `npx tsx src/sync/adapters/microsoft.test.ts`
// from apps/api. Dummy env so @musubi/config (pulled in transitively) can load;
// set before the dynamic import (tsx emits CJS, so a static import would hoist).
import assert from "node:assert";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { fetchMicrosoftTaskChanges, microsoftAdapter, microsoftEventPath, parseGraphDate, toExternalCalendar, toNormalized, toGraphEvent, toGraphEventPatch, parseCursor } = await import("./microsoft");

  // Unsupported delta falls back to a complete paginated snapshot, never a
  // partial delta. Other failures remain failures and cannot trigger a sweep.
  const graphBase = "https://graph.microsoft.com/v1.0";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const unsupported = () => json({ error: { message: "Invalid request. Delta query is not supported by this resource." } }, 400);
  const requests: string[] = [];
  const snapshot = await fetchMicrosoftTaskChanges("fixture", "list/id", null, {
    graphBase,
    fetchImpl: (async (input) => {
      const url = String(input); requests.push(url);
      if (url.includes("/delta")) return unsupported();
      if (url.includes("page=2")) return json({ value: [{ id: "two", title: "Second" }] });
      return json({ value: [{ id: "one", title: "First" }], "@odata.nextLink": `${graphBase}/me/todo/lists/list%2Fid/tasks?page=2` });
    }) as typeof fetch,
  });
  assert.equal(requests.length, 3);
  assert.ok(requests[1].includes("/list%2Fid/tasks?"));
  assert.equal(snapshot.reset, true);
  assert.equal(snapshot.nextCursor, null);
  assert.deepEqual(snapshot.changes.map(c => c.kind === "task" && c.data.externalId), ["one", "two"]);
  for (const failure of ["second-page", "malformed", "other-400"]) {
    await assert.rejects(fetchMicrosoftTaskChanges("fixture", "list", null, {
      graphBase,
      fetchImpl: (async (input) => {
        const url = String(input);
        if (failure === "other-400") return json({ error: { message: "Invalid request" } }, 400);
        if (url.includes("/delta")) return unsupported();
        if (failure === "malformed") return json({});
        if (url.includes("page=2")) return json({ error: { message: "Unavailable" } }, 500);
        return json({ value: [{ id: "one" }], "@odata.nextLink": `${graphBase}/me/todo/lists/list/tasks?page=2` });
      }) as typeof fetch,
    }));
  }

  assert.equal(toExternalCalendar({ id: "default", name: "Calendar", canEdit: true, isDefaultCalendar: true }).providerDefaultCalendar, true);
  assert.equal(toExternalCalendar({ id: "ordinary", name: "Calendar", canEdit: true, isDefaultCalendar: false }).providerDefaultCalendar, false);
  assert.equal(toExternalCalendar({ id: "unknown", name: "Calendar", canEdit: true }).providerDefaultCalendar, null);
  assert.equal(toExternalCalendar({ id: "default", name: "Calendar", canEdit: true, isDefaultCalendar: true }).readOnly, false, "Metadata lock must not remove event write access");

  // Writes stay scoped to their source, including non-default work calendars.
  assert.equal(
    microsoftEventPath("work/team", "event #1"),
    "/me/calendars/work%2Fteam/events/event%20%231",
  );

  // Calendar writes fail closed: Graph must explicitly grant write access.
  assert.equal(toExternalCalendar({ id: "w", name: "Writable", canEdit: true }).readOnly, false);
  assert.equal(toExternalCalendar({ id: "r", name: "Read only", canEdit: false }).readOnly, true);
  assert.equal(toExternalCalendar({ id: "u", name: "Unknown" }).readOnly, true);

  // parseGraphDate: 7-digit fraction, no zone designator → UTC instant
  assert.equal(parseGraphDate("2026-07-18T20:30:00.0000000").toISOString(), "2026-07-18T20:30:00.000Z");
  assert.equal(parseGraphDate("2026-07-18T20:30:00").toISOString(), "2026-07-18T20:30:00.000Z");

  // A calendarView removal cannot pass through the generic deletion mapper.
  assert.throws(() => toNormalized({ id: "x", "@removed": { reason: "deleted" } }), /not a deletion proof/);

  // toNormalized: timed event
  const timed = toNormalized({
    id: "e1",
    "@odata.etag": 'W/"actual-provider-version"',
    changeKey: "not-an-etag-guarantee",
    subject: "Standup",
    isAllDay: false,
    start: { dateTime: "2026-07-18T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-07-18T09:30:00.0000000", timeZone: "UTC" },
    body: { contentType: "text", content: "  \r\n" }, // whitespace-only → null
    organizer: { emailAddress: { address: "boss@example.com" } },
  });
  assert.equal(timed.title, "Standup");
  assert.equal(timed.etag, 'W/"actual-provider-version"');
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

  // Omitted Graph properties preserve their rich provider shape. This proves
  // payload shape only. The enabled personal-content path has separate live
  // conditional evidence; it never converts changeKey to If-Match.
  const rich = {
    subject: "Before", body: { contentType: "HTML", content: "<b>Keep meeting blob</b>" },
    location: { displayName: "Office", address: { city: "Prague" }, coordinates: { latitude: 50 } },
    locations: [{ displayName: "Office", uniqueId: "room-identity" }],
    recurrence: { pattern: { type: "weekly" } },
    start: { dateTime: "2026-07-18T09:00:00", timeZone: "Europe/Prague" },
  };
  const titleOnly = toGraphEventPatch({ ...timed, title: "After" } as any, { title: "After" });
  assert.deepEqual(titleOnly, { subject: "After" });
  assert.deepEqual({ ...rich, ...titleOnly }, { ...rich, subject: "After" });
  assert.deepEqual(toGraphEventPatch(timed as any, {}), {});
  assert.deepEqual(toGraphEventPatch({ ...timed, description: null } as any, { description: null }),
    { body: { contentType: "text", content: "" } });
  const realFetch = globalThis.fetch;
  let remoteCalls = 0;
  globalThis.fetch = (async () => { remoteCalls++; throw new Error("Unexpected remote request"); }) as typeof fetch;
  try {
    await assert.rejects(() => microsoftAdapter.pushUpdate("user", "account", "calendar", "event", timed as any),
      /event-diff-unavailable/);
    await assert.rejects(() => microsoftAdapter.pushDelete("user", "account", "calendar", "event"),
      /provider-version-unavailable/);
    assert.equal(remoteCalls, 0, "direct adapter paths cannot bypass missing-diff and delete guards");
  } finally { globalThis.fetch = realFetch; }

  // nearestMicrosoftCalendarColor: exact preset, nearby shade, garbage fallback
  const { nearestMicrosoftCalendarColor, MICROSOFT_CALENDAR_COLORS } = await import("@musubi/types");
  assert.equal(nearestMicrosoftCalendarColor("#6BB55C").name, "lightGreen");
  assert.equal(nearestMicrosoftCalendarColor("#e21d1d").name, "lightRed");
  assert.equal(nearestMicrosoftCalendarColor("not-a-color").name, MICROSOFT_CALENDAR_COLORS[0].name);

  // A cursor must preserve both exact window bounds and its collection scope.
  const windowCursor = { version: 2, calendarId: "calendar", link: "https://graph.microsoft.com/v1.0/me/calendars/calendar/calendarView/delta?token=x", windowStart: 1, windowEnd: 123 };
  assert.deepEqual(parseCursor(JSON.stringify(windowCursor)), windowCursor);
  assert.equal(parseCursor(JSON.stringify({ link: "https://g/delta?x", windowEnd: 123 })), null);
  assert.equal(parseCursor("https://plain-url-from-older-code"), null);
  assert.equal(parseCursor(null), null);

  console.log("microsoft adapter self-check: OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
