import assert from "node:assert/strict";
import type { ProviderEventState } from "@musubi/types";
import { ownMirrorMetadataMismatch } from "./event-outbox-projection";

// Pure guard table for a metadata-only refresh of a copy Musubi wrote.
const canonical = { title: "Personal copy", start: new Date("2026-03-01T10:00:00Z"), end: new Date("2026-03-01T10:05:00Z"), isAllDay: false, description: null, location: null, recurrence: null, organizer: "owner@example.test", url: null, seriesID: null, originalStart: null, isCanceled: false, hasAttendees: false, deletedAt: null };
const states: Record<string, ProviderEventState> = {
  microsoft: { provider: "microsoft", organizer: { address: "owner@outlook.example", name: "Owner", self: null }, isOrganizer: true, attendees: [], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "singleInstance", conferenceURLs: [] },
  caldav: { provider: "caldav", organizer: null, isOrganizer: null, attendees: [], attendeesComplete: true, ownResponse: null, reminders: { provider: "caldav", alarms: [] }, availability: null, privacy: null, status: null, eventType: null, conferenceURLs: [] },
  google: { provider: "google", organizer: { address: "owner@gmail.example", name: null, self: true }, isOrganizer: true, attendees: [], attendeesComplete: true, ownResponse: null, reminders: { provider: "google", useDefault: true, overrides: [] }, availability: null, privacy: null, status: "confirmed", eventType: "default", conferenceURLs: [] },
};
const organizers: Record<string, string> = { microsoft: "owner@outlook.example", caldav: "", google: "owner@gmail.example" };
const check = (provider: string, change: { values?: object; state?: Partial<ProviderEventState>; canonical?: object; baseline?: ProviderEventState | null } = {}) =>
  ownMirrorMetadataMismatch({
    provider, canonical: { ...canonical, ...change.canonical },
    values: { ...canonical, organizer: organizers[provider]!, ...change.values },
    state: { ...states[provider]!, ...change.state } as ProviderEventState, baseline: change.baseline ?? null,
  });

for (const provider of ["microsoft", "caldav", "google"]) {
  assert.equal(check(provider), null, `${provider}: provider-proven self organizer and equal content are accepted`);
  assert.equal(check(provider, { baseline: states[provider] }), null, `${provider}: an equal baseline is accepted`);
}
assert.equal(check("microsoft", { values: { organizer: canonical.organizer } , state: { isOrganizer: null } }), null, "an equal organizer needs no proof");
const rows: [string, Parameters<typeof check>[1], string, string[]?][] = [
  ["microsoft", { values: { title: "Edited" } }, "content"],
  ["caldav", { values: { start: new Date("2026-03-01T11:00:00Z") } }, "content"],
  ["microsoft", { values: { url: "https://meet.example/x" } }, "url"],
  ["microsoft", { canonical: { hasAttendees: true } }, "shape"],
  ["google", { values: { recurrence: "RRULE:FREQ=DAILY" }, canonical: { recurrence: "RRULE:FREQ=DAILY" } }, "shape"],
  ["microsoft", { state: { attendees: [{ address: "guest@example.test", name: null, self: null, role: "required", response: null }] } }, "state"],
  ["microsoft", { state: { conferenceURLs: ["https://meet.example/x"] } }, "state"],
  ["microsoft", { state: { status: "cancelled" } }, "state"],
  ["microsoft", { state: { eventType: "occurrence" } }, "state"],
  ["microsoft", { state: { attendeesComplete: false } }, "state"],
  ["microsoft", { state: { isOrganizer: false } }, "organizer"],
  ["microsoft", { state: { isOrganizer: null } }, "organizer"],
  ["google", { state: { isOrganizer: false } }, "organizer"],
  ["caldav", { state: { organizer: { address: "mailto:host@example.test", name: null, self: null } } }, "organizer"],
  ["caldav", { values: { organizer: "host@example.test" } }, "organizer"],
  ["microsoft", { state: { privacy: "private" } }, "baseline", ["privacy"]],
  ["caldav", { state: { privacy: "CONFIDENTIAL" } }, "baseline", ["privacy"]],
  ["microsoft", { baseline: { ...states.microsoft!, reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 30 }, availability: "free" } }, "baseline", ["availability", "reminders"]],
  ["unknown", {}, "provider"],
];
for (const [provider, change, guard, stateFields] of rows)
  assert.deepEqual(check(provider, change), { guard, ...(stateFields ? { stateFields } : {}) }, `${provider} ${JSON.stringify(change)} -> ${guard}`);
console.log("own mirror metadata predicate: OK");
