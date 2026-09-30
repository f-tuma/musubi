import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderRsvpEditor } from "./ProviderRsvpEditor";
import type { ProviderEventStateResponse } from "@musubi/types";
const save = vi.hoisted(() => vi.fn());
vi.mock("~/api/resources", () => ({ editProviderRsvp: save }));
const observation: ProviderEventStateResponse = {
  version: "a".repeat(64), rsvpEdit: { provider: "google", expectedRevision: 7 },
  state: { provider: "google", organizer: null, isOrganizer: false, attendees: [], attendeesComplete: true, ownResponse: null, reminders: { provider: "google", useDefault: false, overrides: [{ method: "email", minutes: 30 }] }, availability: null, privacy: null, status: null, eventType: null, conferenceURLs: [] },
};
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("requires an explicit choice and preserves the frozen response when retrying offline", async () => {
  save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderRsvpEditor eventId="event" observation={observation} connectionId="remote" returnFocus={document.body} onClose={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Send response" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("combobox", { name: "Your Google response" }));
  fireEvent.click(await screen.findByRole("option", { name: "Tentative" }));
  fireEvent.click(screen.getByRole("button", { name: "Send response" }));
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
  fireEvent.click(screen.getByRole("button", { name: "Send response" }));
  await screen.findByText(/Google confirmation is still pending/);
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[0]).toMatchObject(["event", { expectedRevision: 7, expectedStateVersion: "a".repeat(64), response: "tentative", sendUpdates: "all" }, "remote"]);
});
it("does not send on cancel or bubble portal interactions to the calendar", async () => {
  const close = vi.fn(), parent = vi.fn();
  render(<div onClick={parent} onKeyDown={parent} onPointerDown={parent}><ProviderRsvpEditor eventId="event" observation={observation} returnFocus={document.body} onClose={close} /></div>);
  const cancel = screen.getByRole("button", { name: "Cancel" });
  fireEvent.pointerDown(cancel); fireEvent.keyDown(cancel, { key: "Enter" }); fireEvent.click(cancel);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(parent).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
it("sends CalDAV's explicit server reply policy and keeps an offline retry immutable", async () => {
  const caldav = { ...observation, rsvpEdit: { provider: "caldav" as const, expectedRevision: 7 }, state: { ...observation.state!, provider: "caldav" as const, reminders: { provider: "caldav" as const, alarms: [] } } };
  save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "completed" });
  render(<ProviderRsvpEditor eventId="event" observation={caldav} returnFocus={document.body} onClose={vi.fn()} />);
  fireEvent.focus(screen.getByRole("button", { name: "About responses" }));
  expect((await screen.findByRole("tooltip")).textContent).toMatch(/Organizer delivery cannot be verified/);
  fireEvent.click(screen.getByRole("combobox", { name: "Your response" }));
  fireEvent.click(await screen.findByRole("option", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Send response to organizer" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Send response to organizer" }));
  await screen.findByText(/Your response is saved on the calendar server/);
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[0][1]).toMatchObject({ provider: "caldav", response: "accepted", notificationPolicy: "server-reply" });
  expect(save.mock.calls[0][1]).not.toHaveProperty("sendUpdates");
});

it.each([undefined, "occurrence"] as const)("sends an Outlook %s response with immutable retry", async scope => {
  const graph = { ...observation, rsvpEdit: { provider: "microsoft" as const, expectedRevision: 7, ...(scope ? { scope } : {}) }, state: { ...observation.state!, provider: "microsoft" as const, reminders: { provider: "microsoft" as const, isOn: true, minutesBeforeStart: 15 } } };
  save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "completed" });
  render(<ProviderRsvpEditor eventId="event" observation={graph} returnFocus={document.body} onClose={vi.fn()} />);
  if (scope) expect(screen.getByRole("dialog", { name: "Respond to this occurrence" })).toBeTruthy();
  fireEvent.focus(screen.getByRole("button", { name: "About responses" }));
  expect((await screen.findByRole("tooltip")).textContent).toMatch(/Organizer delivery cannot be verified/);
  fireEvent.click(screen.getByRole("combobox", { name: "Your response" }));
  fireEvent.click(await screen.findByRole("option", { name: "Accept" }));
  fireEvent.click(screen.getByRole("button", { name: "Send response to organizer" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Send response to organizer" }));
  await screen.findByText(/Your response is observed in Outlook/);
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[0][1]).toMatchObject({ provider: "microsoft", response: "accepted", notificationPolicy: "send-response", ...(scope ? { scope } : {}) });
  expect(save.mock.calls[0][1]).not.toHaveProperty("sendUpdates");
});

it.each(["occurrence", "series"] as const)("offers only verified scopes from %s and freezes a whole-series retry", async scope => {
  const graph: ProviderEventStateResponse = { ...observation, rsvpEdit: { provider: "microsoft", expectedRevision: 7, scope, series: { version: "c".repeat(64), ownResponse: "notResponded" } }, state: { ...observation.state!, provider: "microsoft", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 } } };
  save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderRsvpEditor eventId="event" observation={graph} onClose={vi.fn()} />);
  if (scope === "occurrence") {
    fireEvent.click(screen.getByRole("combobox", { name: "Response applies to" }));
    fireEvent.click(await screen.findByRole("option", { name: "Entire series" }));
  } else {
    expect(screen.queryByRole("combobox", { name: "Response applies to" })).toBeNull();
    expect(screen.getByText("Response applies to: Entire series")).toBeTruthy();
  }
  expect(screen.getByText(/Existing exceptions keep their own response/)).toBeTruthy();
  fireEvent.click(screen.getByRole("combobox", { name: "Your response" }));
  fireEvent.click(await screen.findByRole("option", { name: "Decline" }));
  expect(screen.getByText(/including exceptions/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send response to organizer" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Send response to organizer" }));
  await screen.findByText(/Response request saved/);
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[0][1]).toMatchObject({ scope: "series", expectedSeriesVersion: "c".repeat(64), response: "declined" });
});
