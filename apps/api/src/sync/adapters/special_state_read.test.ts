import assert from "node:assert/strict";
import { fetchMicrosoftChanges, microsoftAdapter } from "./microsoft";

async function main() {
  const graphBase = "https://graph.fixture.invalid/v1.0";
  let title = "Before native title change";
  const requests: string[] = [];
  const rich = {
    id: "special", type: "singleInstance", "@odata.etag": '"native"', isAllDay: false,
    start: { dateTime: "2026-09-10T09:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-09-10T10:00:00", timeZone: "UTC" },
    showAs: "workingElsewhere", sensitivity: "confidential", isReminderOn: true, reminderMinutesBeforeStart: 23,
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/fixture" },
    organizer: { emailAddress: { name: "Owner", address: "owner@example.test" } },
    isOrganizer: true, attendees: [], responseStatus: { response: "organizer" },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, new URL(graphBase).origin);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
    requests.push(String(input));
    return new Response(JSON.stringify({ value: [{ ...rich, subject: title }], "@odata.deltaLink": graphBase + "/me/calendars/calendar/calendarView/delta?token=fixture" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const options = { graphBase, fetchImpl, now: Date.parse("2026-09-01T00:00Z") };
  const first = await fetchMicrosoftChanges("fixture", "calendar", null, options);
  const before = first.changes.find(change => change.kind === "event");
  assert.ok(before?.kind === "event");
  assert.equal(before.data.providerState?.availability, "workingElsewhere");
  assert.equal(before.data.providerState?.privacy, "confidential");
  assert.deepEqual(before.data.providerState?.reminders, { provider: "microsoft", isOn: true, minutesBeforeStart: 23 });
  assert.deepEqual(before.data.providerState?.conferenceURLs, [rich.onlineMeeting.joinUrl]);
  // This change is supplied by the native fixture, not a Musubi Graph writer.
  title = "Changed at the provider";
  const second = await fetchMicrosoftChanges("fixture", "calendar", first.nextCursor, options);
  const after = second.changes.find(change => change.kind === "event");
  assert.ok(after?.kind === "event");
  assert.equal(after.data.title, title);
  assert.deepEqual(after.data.providerState, before.data.providerState);
  const count = requests.length;
  await assert.rejects(microsoftAdapter.pushUpdate!("owner", "account", "calendar", "special", {} as never), /event-diff-unavailable/);
  assert.equal(requests.length, count, "Graph mutation without a server-computed diff remains refused");
  console.log("Graph richer-state HTTP read/re-read preserves availability, privacy, reminders and Teams; a write without a diff remains refused: OK");
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
