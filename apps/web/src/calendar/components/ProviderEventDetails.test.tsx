import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderEventDetails } from "./ProviderEventDetails";
import { providerEventDetails } from "@musubi/calendar";
import { EventSchema, type ProviderEventState } from "@musubi/types";
const fetchState = vi.hoisted(() => vi.fn());
const bulkRead = vi.hoisted(() => vi.fn());
vi.mock("~/api/outlook-moves", () => ({ getLatestOutlookMove: bulkRead, getOutlookMove: bulkRead }));
vi.mock("~/api/resources", () => ({ getProviderEventState: fetchState }));
const state: ProviderEventState = { provider: "microsoft", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [], attendeesComplete: false, ownResponse: "notResponded", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 0 }, availability: "workingElsewhere", privacy: "confidential", status: null, eventType: "singleInstance", conferenceURLs: [] };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("shows native values and distinguishes independent reminders", async () => {
  fetchState.mockResolvedValue({ state });
  render(<ProviderEventDetails eventId="event" userId="owner" />);
  expect(await screen.findByText("Outlook details")).toBeTruthy();
  expect(screen.getByText("workingElsewhere")).toBeTruthy();
  expect(screen.getByText("0 minutes before start")).toBeTruthy();
  expect(screen.queryByText(/Both apps may notify/)).toBeNull();
  await act(async () => screen.getByRole("button", { name: "About Outlook settings" }).click());
  expect(within(screen.getByRole("tooltip")).getByText(/Both apps may notify/)).toBeTruthy();
});
it("never displays a previous account's late result", async () => {
  let resolve!: (value: { state: ProviderEventState }) => void;
  fetchState.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce({ state: null });
  const view = render(<ProviderEventDetails eventId="event" userId="old" connectionId="one" />);
  view.rerender(<ProviderEventDetails eventId="event" userId="new" connectionId="two" />);
  await act(async () => { resolve({ state }); });
  expect(screen.queryByText(/host@example/)).toBeNull();
  expect(screen.queryByText("Outlook details")).toBeNull();
  expect(fetchState.mock.calls[1]?.[2]).toBe("two");
});
it("reports unavailable data without presenting RSVP controls", async () => {
  fetchState.mockRejectedValue(new Error("offline"));
  render(<ProviderEventDetails eventId="event" userId="owner" />);
  expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
it("preserves unknown alarm semantics and negative offsets as raw CalDAV values", () => {
  const details = providerEventDetails({ ...state, provider: "caldav", reminders: { provider: "caldav", alarms: [{ action: "X-CUSTOM", trigger: "PT15M", related: "END", repeat: "3", duration: "PT2M" }] } });
  expect(details.rows.find(row => row.label === "Provider alarms")?.value).toBe("X-CUSTOM · PT15M · END · repeat 3 · PT2M");
});

it("offers the editor only from the server contract and clears it on account change", async () => {
  const google = { ...state, provider: "google", reminders: { provider: "google", useDefault: true, overrides: [] } };
  fetchState.mockResolvedValueOnce({ state: google, version: "a".repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 } }).mockResolvedValueOnce({ state: google, version: "b".repeat(64), reminderEdit: { provider: "google", expectedRevision: 8 } }).mockResolvedValueOnce({ state: null });
  const view = render(<ProviderEventDetails eventId="event" userId="owner" connectionId="one" />);
  const edit = await screen.findByRole("button", { name: "Edit Google reminders" });
  await act(async () => edit.click());
  expect(await screen.findByRole("dialog", { name: "Google reminders" })).toBeTruthy();
  view.rerender(<ProviderEventDetails eventId="event" userId="other" connectionId="two" />);
  expect(screen.queryByRole("dialog", { name: "Google reminders" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit Google reminders" })).toBeNull();
});

it("refreshes RSVP capability before handoff and refuses a revoked capability", async () => {
  const google = { ...state, provider: "google", reminders: { provider: "google", useDefault: true, overrides: [] } };
  const initial = { state: google, version: "a".repeat(64), rsvpEdit: { provider: "google", expectedRevision: 7 } };
  const fresh = { ...initial, version: "b".repeat(64), rsvpEdit: { provider: "google", expectedRevision: 8 } };
  fetchState.mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh).mockResolvedValueOnce({ state: google, version: "c".repeat(64) });
  const onRespond = vi.fn();
  render(<ProviderEventDetails eventId="event" userId="owner" connectionId="remote" onRespond={onRespond} />);
  const respond = await screen.findByRole("button", { name: "Respond in Google" });
  await act(async () => respond.click());
  expect(onRespond).toHaveBeenCalledWith(fresh);
  await act(async () => screen.getByRole("button", { name: "Respond in Google" }).click());
  expect(await screen.findByText(/unavailable in the refreshed state/)).toBeTruthy();
  expect(onRespond).toHaveBeenCalledTimes(1);
});

it("opens a clearly scoped instance response and discards it when scope changes", async () => {
  const google = { ...state, provider: "google", reminders: { provider: "google", useDefault: true, overrides: [] } };
  fetchState.mockResolvedValue({ state: google, version: "a".repeat(64), rsvpEdit: { provider: "google", expectedRevision: 7 } });
  const view = render(<ProviderEventDetails eventId="child" userId="owner" occurrence />);
  const respond = await screen.findByRole("button", { name: "Respond to this occurrence" });
  await act(async () => respond.click());
  expect(await screen.findByRole("dialog", { name: "Respond to this occurrence" })).toBeTruthy();
  expect(screen.getByText(/This Google response applies only to this occurrence/)).toBeTruthy();
  view.rerender(<ProviderEventDetails eventId="child" userId="owner" series />);
  expect(screen.queryByRole("dialog", { name: "Respond to this occurrence" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Respond to this occurrence" })).toBeNull();
});

it("opens reminders for the bound occurrence and clears the editor on scope change", async () => {
  const google = { ...state, provider: "google", reminders: { provider: "google", useDefault: true, overrides: [] } };
  fetchState.mockResolvedValue({ state: google, version: "a".repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 } });
  const view = render(<ProviderEventDetails eventId="child" userId="owner" occurrence />);
  const action = await screen.findByRole("button", { name: "Edit reminders for this occurrence" });
  await act(async () => action.click());
  expect(await screen.findByRole("dialog", { name: "Google reminders for this occurrence" })).toBeTruthy();
  expect(screen.getByText("These Google reminders apply only to this occurrence.")).toBeTruthy();
  expect(fetchState.mock.calls[1][0]).toBe("child");
  view.rerender(<ProviderEventDetails eventId="child" userId="owner" series />);
  expect(screen.queryByRole("dialog", { name: "Google reminders for this occurrence" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit reminders for this occurrence" })).toBeNull();
});

it("retires private details and an open editor when the event revision changes", async () => {
  const google = { ...state, provider: "google", reminders: { provider: "google", useDefault: true, overrides: [] } };
  fetchState.mockResolvedValueOnce({ state: google, version: "a".repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 } }).mockResolvedValueOnce({ state: google, version: "a".repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 } });
  let complete!: (value: { state: null }) => void;
  fetchState.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<ProviderEventDetails eventId="event" userId="owner" revision={7} />);
  const action = await screen.findByRole("button", { name: "Edit Google reminders" });
  await act(async () => action.click());
  expect(await screen.findByRole("dialog", { name: "Google reminders" })).toBeTruthy();
  view.rerender(<ProviderEventDetails eventId="event" userId="owner" revision={8} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText(/host@example/)).toBeNull();
  expect(screen.queryByText("Google details")).toBeNull();
  await act(async () => complete({ state: null }));
  expect(screen.queryByText("Provider details")).toBeNull();
});

it.each(["default", "panel"] as const)("opens only explicit series alarm settings from a stored master and refuses a stale refresh (%s)", async (presentation) => {
  const master = EventSchema.parse({ id: "00000000-0000-4000-8000-000000000301", revision: 7, isCanceled: false, title: "Series", creatorID: "owner", organizer: "", color: "red", calendars: [], start: new Date("2026-03-28T00:00:00Z"), end: new Date("2026-03-28T00:00:00Z"), isAllDay: true, timeModel: { kind: "all-day" }, recurrence: "RRULE:FREQ=DAILY;COUNT=4" });
  const observation = { state: { ...state, provider: "caldav", reminders: { provider: "caldav", alarms: [] } }, version: "a".repeat(64), reminderEdit: { provider: "caldav", scope: "series", expectedRevision: 7, minutesBeforeStart: 15 } };
  fetchState.mockResolvedValue(observation);
  const view = render(<ProviderEventDetails presentation={presentation} eventId={master.id} userId="owner" series />);
  await screen.findByText("CalDAV details");
  expect(screen.queryByRole("button", { name: "Edit CalDAV event alarms" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Series alarm settings" })).toBeNull();
  view.rerender(<ProviderEventDetails presentation={presentation} eventId={master.id} userId="owner" series seriesMaster={master} />);
  const action = await screen.findByRole("button", { name: "Series alarm settings" });
  await act(async () => action.click());
  expect(await screen.findByRole("dialog", { name: "CalDAV series alarm" })).toBeTruthy();
  expect(screen.getByText(/Applies to every occurrence in this series/)).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: "Close CalDAV series alarm" }).click());
  fetchState.mockResolvedValue({ ...observation, reminderEdit: { ...observation.reminderEdit, expectedRevision: 8 } });
  await act(async () => action.click());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByText(/Could not refresh provider details/)).toBeTruthy();
});
it.each(["default", "panel"] as const)("refuses stale organizer occurrence observations before opening the editor (%s)", async (presentation) => {
  const child = EventSchema.parse({ id: "00000000-0000-4000-8000-000000000001", revision: 7, title: "Child", start: new Date("2026-10-25T09:00:00Z"), end: new Date("2026-10-25T10:00:00Z"), creatorID: "owner", organizer: "owner", color: "red", calendars: ["source"], originCalendarID: "source", isAllDay: false, isCanceled: false, seriesID: "00000000-0000-4000-8000-000000000002", originalStart: { kind: "instant", value: "2026-10-24T08:00:00.000Z" } });
  const edit = { provider: "google", calendarID: "source", expectedRevision: 7, scope: "occurrence", instanceVersion: "b".repeat(64) };
  fetchState.mockResolvedValueOnce({ state, version: "a".repeat(64), organizerEdit: edit }).mockResolvedValueOnce({ state, version: "a".repeat(64), organizerEdit: { ...edit, expectedRevision: 8 } });
  render(<ProviderEventDetails presentation={presentation} event={child} eventId={child.id} userId="owner" occurrence />);
  const action = await screen.findByRole("button", { name: "Manage this occurrence" });
  await act(async () => action.click());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByText(/Could not refresh provider details/)).toBeTruthy();
});


it("folds panel metadata without hiding provider actions or refresh errors", async () => {
  const google = { ...state, provider: "google", ownResponse: "needsAction", reminders: { provider: "google", useDefault: true, overrides: [] } };
  fetchState.mockResolvedValueOnce({ state: google, version: "a".repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 }, rsvpEdit: { provider: "google", expectedRevision: 7 } }).mockRejectedValueOnce(new Error("offline"));
  const view = render(<ProviderEventDetails presentation="panel" eventId="event" userId="owner" />);
  const label = await screen.findByText("Google Calendar details");
  const disclosure = label.closest("details");
  expect(disclosure).not.toBeNull();
  expect(disclosure?.open).toBe(false);
  expect(disclosure?.querySelector('[data-provider="google"]')).not.toBeNull();
  expect(screen.getByText("Awaiting response").closest("details")).toBe(disclosure);
  const reminders = screen.getByRole("button", { name: "Edit Google reminders" });
  expect(reminders.closest("details")).toBeNull();
  expect(screen.getByRole("button", { name: "Respond in Google" }).closest("details")).toBeNull();
  await act(async () => reminders.click());
  expect(screen.getByText(/Could not refresh provider details/).closest("details")).toBeNull();
  expect(disclosure?.open).toBe(false);
  expect(fetchState).toHaveBeenCalledTimes(2);
  view.rerender(<ProviderEventDetails eventId="event" userId="owner" />);
  expect(view.container.querySelector("details")).toBeNull();
  expect(screen.getByText("needsAction")).toBeTruthy();
  expect(fetchState).toHaveBeenCalledTimes(2);
});

it("keeps panel loading and unavailable states outside a disclosure", async () => {
  let reject!: (reason: Error) => void;
  fetchState.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const view = render(<ProviderEventDetails presentation="panel" eventId="event" userId="owner" />);
  expect(screen.getByRole("status").textContent).toContain("Loading provider details");
  expect(view.container.querySelector("details")).toBeNull();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("status").textContent).toContain("could not be loaded");
  expect(view.container.querySelector("details")).toBeNull();
});


it.each([false, true])("shows provider participants with explicit completeness and retires their private data (%s)", async attendeesComplete => {
  const observed: ProviderEventState = { ...state, attendeesComplete, attendees: [
    { name: "Alex", address: "alex@example.test", self: false, role: "required", response: "needsAction" },
    { name: null, address: "room@example.test", self: false, role: "X-CUSTOM-ROLE", response: "X-CUSTOM-RESPONSE" },
  ] };
  fetchState.mockResolvedValueOnce({ state: observed });
  const view = render(<ProviderEventDetails presentation="panel" eventId="event" userId="owner" revision={1} />);
  const summary = (await screen.findByText("Outlook participants")).closest("summary")!;
  expect(summary.querySelector("button")).toBeNull();
  await act(async () => summary.click());
  const list = screen.getByRole("list", { name: "Outlook participants" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("Alex")).toBeTruthy();
  expect(within(list).getByText("alex@example.test · Required · Awaiting response")).toBeTruthy();
  expect(within(list).getByText("X-CUSTOM-ROLE · X-CUSTOM-RESPONSE")).toBeTruthy();
  expect(screen.queryByText("Participant list may be incomplete.") !== null).toBe(!attendeesComplete);
  expect(screen.getAllByText(/alex@example.test/)).toHaveLength(1);
  expect(screen.getByText("Organizer")).toBeTruthy();
  let finish!: (value: { state: null }) => void;
  fetchState.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  view.rerender(<ProviderEventDetails presentation="panel" eventId="event" userId="owner" revision={2} />);
  expect(screen.queryByText("Outlook participants")).toBeNull();
  expect(screen.queryByText(/alex@example.test/)).toBeNull();
  expect(screen.queryByText("Alex")).toBeNull();
  await act(async () => finish({ state: null }));
  expect(screen.queryByText("Provider details")).toBeNull();
});


it.each([
  { provider: "caldav", flavor: "apple", title: "Apple Calendar details", mark: "apple" },
  { provider: "caldav", flavor: undefined, title: "CalDAV details", mark: "caldav" },
  { provider: "microsoft", flavor: "apple", title: "Outlook details", mark: "microsoft" },
] as const)("brands $provider as $title only from matching known account identity", async ({ provider, flavor, title, mark }) => {
  fetchState.mockResolvedValue({ state: { ...state, provider } });
  const view = render(<ProviderEventDetails presentation="panel" providerFlavor={flavor} eventId="event" userId="owner" />);
  const label = await screen.findByText(title);
  expect(label.closest("summary")?.querySelector(`[data-provider="${mark}"]`)).not.toBeNull();
  if (provider === "caldav") {
    await act(async () => label.closest("summary")!.click());
    await act(async () => screen.getByRole("button", { name: flavor === "apple" ? "About Apple Calendar settings" : "About CalDAV settings" }).click());
    expect(within(screen.getByRole("tooltip")).getByText(flavor === "apple" ? /Change these in Apple Calendar/ : /Change these in CalDAV/)).toBeTruthy();
  }
  view.rerender(<ProviderEventDetails providerFlavor={flavor} eventId="event" userId="owner" />);
  expect(screen.getByText(provider === "caldav" ? "CalDAV details" : "Outlook details")).toBeTruthy();
  expect(fetchState).toHaveBeenCalledTimes(1);
});


it.each([
  ["accepted", "Accepted"], ["declined", "Declined"], ["tentative", "Tentative"],
  ["ACCEPTED", "Accepted"], ["DECLINED", "Declined"], ["TENTATIVE", "Tentative"], ["NEEDS-ACTION", "Awaiting response"],
  ["needsAction", "Awaiting response"], ["notResponded", "Awaiting response"],
  ["tentativelyAccepted", "Tentative"], ["none", "Not reported"], ["X-CUSTOM-RESPONSE", "X-CUSTOM-RESPONSE"],
])("labels read-only response %s as %s and preserves the default raw observation", async (response, label) => {
  fetchState.mockResolvedValue({ state: { ...state, ownResponse: response, attendees: [{ name: "Guest", address: null, self: false, role: null, response }] } });
  const view = render(<ProviderEventDetails presentation="panel" eventId="event" userId="owner" />);
  await screen.findByText("Outlook participants");
  expect(screen.getAllByText(label, { exact: true })).toHaveLength(2);
  view.rerender(<ProviderEventDetails eventId="event" userId="owner" />);
  expect(screen.getByText(response, { exact: true })).toBeTruthy();
});


it("presents native CalDAV roles and mail addresses without changing provider observations", async () => {
  const observed = { ...state, provider: "caldav", ownResponse: "ACCEPTED", organizer: { name: "mailto:host@example.test", address: "mailto:host@example.test", self: false }, attendees: [
    { name: "Alex", address: "MAILTO:alex@example.test", self: false, role: "REQ-PARTICIPANT", response: "NEEDS-ACTION" },
    { name: "mailto:sam@example.test", address: "mailto:sam@example.test", self: false, role: "OPT-PARTICIPANT", response: "ACCEPTED" },
    { name: null, address: "mailto:chair@example.test", self: false, role: "CHAIR", response: "TENTATIVE" },
  ] };
  const original = structuredClone(observed);
  fetchState.mockResolvedValue({ state: observed });
  const view = render(<ProviderEventDetails presentation="panel" providerFlavor="apple" eventId="event" userId="owner" />);
  await screen.findByText("Apple Calendar participants");
  expect(screen.getByText("alex@example.test · Required · Awaiting response")).toBeTruthy();
  expect(screen.getByText("Optional · Accepted")).toBeTruthy();
  expect(screen.getByText("Chair · Tentative")).toBeTruthy();
  expect(screen.getAllByText("sam@example.test")).toHaveLength(1);
  expect(screen.getByText("host@example.test")).toBeTruthy();
  expect(screen.queryByText(/mailto:/i)).toBeNull();
  await act(async () => screen.getByText("Apple Calendar details").closest("summary")!.click());
  await act(async () => screen.getByRole("button", { name: "About Apple Calendar settings" }).click());
  expect(within(screen.getByRole("tooltip")).getByText(/Change these in Apple Calendar/)).toBeTruthy();
  expect(observed).toEqual(original);
  view.rerender(<ProviderEventDetails providerFlavor="apple" eventId="event" userId="owner" />);
  expect(screen.getByText(/MAILTO:alex@example.test/)).toBeTruthy();
  await act(async () => screen.getByRole("button", { name: "About CalDAV settings" }).click());
  expect(within(screen.getByRole("tooltip")).getByText(/Change these in CalDAV/)).toBeTruthy();
});


it("labels only known panel metadata enums and leaves unknown values verbatim", async () => {
  fetchState.mockResolvedValue({ state: { ...state, availability: "OPAQUE", privacy: "PRIVATE", status: "CONFIRMED", eventType: "singleInstance" } });
  const view = render(<ProviderEventDetails presentation="panel" eventId="event" userId="owner" />);
  await screen.findByText("Outlook details");
  for (const label of ["Busy", "Private", "Confirmed", "Single event"]) expect(screen.getByText(label, { exact: true })).toBeTruthy();
  fetchState.mockResolvedValue({ state: { ...state, availability: "X-CUSTOM-AVAILABILITY", privacy: "X-CUSTOM-PRIVACY", status: "X-CUSTOM-STATUS", eventType: "X-CUSTOM-TYPE" } });
  view.rerender(<ProviderEventDetails presentation="panel" eventId="other" userId="owner" />);
  await screen.findByText("X-CUSTOM-AVAILABILITY");
  for (const value of ["X-CUSTOM-PRIVACY", "X-CUSTOM-STATUS", "X-CUSTOM-TYPE"]) expect(screen.getByText(value)).toBeTruthy();
});

it("refreshes the series proof before editing and refuses a revoked capability", async () => {
  const calendarID = "00000000-0000-4000-8000-000000000004";
  const stored = EventSchema.parse({ id: "00000000-0000-4000-8000-000000000001", revision: 7, title: "Individual title", isCanceled: false, start: new Date("2026-09-10T09:00:00Z"), end: new Date("2026-09-10T10:00:00Z"), isAllDay: false, creatorID: "owner", organizer: "owner", color: "red", calendars: [calendarID], originCalendarID: calendarID });
  fetchState.mockResolvedValueOnce({ state, version: "a".repeat(64), outlookSeriesContent: { calendarID, expectedRevision: 7, seriesVersion: "b".repeat(64), content: { title: "Series title", description: null, location: null } } }).mockResolvedValueOnce({ state, version: "c".repeat(64) });
  render(<ProviderEventDetails event={stored} eventId={stored.id} userId="owner" />);
  const trigger = await screen.findByRole("button", { name: "Edit series" });
  await act(async () => trigger.click());
  expect(await screen.findByText(/Could not refresh provider details/)).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Edit series" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit series" })).toBeNull();
  expect(fetchState).toHaveBeenCalledTimes(2);
});

it("keeps the bulk progress window through a revision refresh and closes it on account change", async () => {
  const calendarID = "00000000-0000-4000-8000-000000000004";
  const stored = EventSchema.parse({ id: "00000000-0000-4000-8000-000000000001", revision: 7, title: "Title", isCanceled: false, start: new Date("2026-09-10T09:00:00Z"), end: new Date("2026-09-10T10:00:00Z"), isAllDay: false, creatorID: "owner", organizer: "owner", color: "red", calendars: [calendarID], originCalendarID: calendarID });
  fetchState.mockResolvedValue({ state, outlookOccurrenceMove: { calendarID } });
  bulkRead.mockResolvedValue({ operationID: calendarID, eventID: stored.id, title: "Series", meeting: false, status: "running", items: [] });
  const view = render(<ProviderEventDetails event={stored} eventId={stored.id} userId="owner" revision={7} />);
  const move = await screen.findByRole("button", { name: "Move selected occurrences" });
  await act(async () => move.click());
  await screen.findByText(/changes will continue/);
  view.rerender(<ProviderEventDetails event={stored} eventId={stored.id} userId="owner" revision={8} />);
  expect(screen.getByRole("dialog", { name: "Move selected occurrences" })).toBeTruthy();
  await screen.findByText(/changes will continue/);
  expect(bulkRead).toHaveBeenCalledTimes(2);
  view.rerender(<ProviderEventDetails event={stored} eventId={stored.id} userId="another" revision={8} />);
  expect(screen.queryByRole("dialog", { name: "Move selected occurrences" })).toBeNull();
});
