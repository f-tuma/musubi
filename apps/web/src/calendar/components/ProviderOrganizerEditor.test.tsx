import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ProviderOrganizerEditor,
  ProviderOrganizerCreateAction,
} from "./ProviderOrganizerEditor";
import type { Event, ProviderEventStateResponse } from "@musubi/types";
const api = vi.hoisted(() => ({ save: vi.fn(), observe: vi.fn() }));
vi.mock("~/api/resources", () => ({
  editProviderOrganizer: api.save,
  getOrganizerCalendar: api.observe,
}));
const calendarID = "00000000-0000-4000-8000-000000000001";
const event: Event = {
  id: "00000000-0000-4000-8000-000000000002",
  revision: 4,
  title: "Original",
  description: "Notes",
  location: "Room",
  start: new Date("2026-10-24T08:00:00Z"),
  end: new Date("2026-10-24T09:00:00Z"),
  timeModel: {
    kind: "zoned",
    timeZone: "Europe/Prague",
    startLocal: "2026-10-24T10:00:00.000",
    endLocal: "2026-10-24T11:00:00.000",
  },
  calendars: [calendarID],
  originCalendarID: calendarID,
  color: "red",
  creatorID: "owner",
  organizer: "owner",
  isAllDay: false,
  isCanceled: false,
  hasAttendees: false,
};
const observation: ProviderEventStateResponse = {
  state: null,
  version: "a".repeat(64),
  organizerEdit: { provider: "google", calendarID, expectedRevision: 4 },
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("keeps meeting information behind the header control and cancellation consequences visible", async () => {
  render(<ProviderOrganizerEditor event={event} observation={observation} calendarID={calendarID} color="red" onClose={vi.fn()} />);
  expect(screen.queryByText(/Google will be asked to notify all guests/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Meeting invitation information" }));
  const information = await screen.findByRole("region", { name: "Meeting invitation information" });
  expect(within(information).getByText(/Google will be asked to notify all guests/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Meeting invitation information" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel meeting and notify guests" }));
  const confirmation = await screen.findByRole("dialog", { name: "Cancel Google meeting" });
  expect(within(confirmation).getByText(/Google will be asked to cancel this meeting and notify every guest/)).toBeTruthy();
  expect(api.save).not.toHaveBeenCalled();
});
it("creates with explicit external guests and freezes every field through an uncertain admission retry", async () => {
  api.save
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ status: "pending" });
  render(
    <ProviderOrganizerEditor
      calendarID={calendarID}
      color="red"
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Planning" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Guest email addresses" }),
    { target: { value: "guest@example.test" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Create and send invitations" }),
  );
  await screen.findByText("offline");
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saved meeting action" }),
  );
  await screen.findByRole("status");
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
  expect(api.save.mock.calls[0][0]).toMatchObject({
    action: "create",
    sendUpdates: "all",
    guests: [{ email: "guest@example.test", optional: false }],
  });
});
it("updates only explicitly touched fields, including a cleared note", async () => {
  api.save.mockResolvedValue({ status: "pending" });
  render(
    <ProviderOrganizerEditor
      event={event}
      observation={observation}
      calendarID={calendarID}
      color="red"
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
    target: { value: "" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save and notify guests" }),
  );
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0].patch).toEqual({ description: null });
  expect(api.save.mock.calls[0][0]).not.toHaveProperty("guests");
});
it("requires cancellation confirmation and retains its action on offline retry", async () => {
  api.save
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ status: "pending" });
  render(
    <ProviderOrganizerEditor
      event={event}
      observation={observation}
      calendarID={calendarID}
      color="red"
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel meeting and notify guests" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Cancel Google meeting",
  });
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Cancel meeting and notify guests",
    }),
  );
  await screen.findByText("offline");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Cancel meeting and notify guests",
    }),
  );
  await screen.findByRole("status");
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
  expect(api.save.mock.calls[0][0].action).toBe("delete");
});
it("does not offer organizer creation without a verified primary calendar", async () => {
  api.observe.mockRejectedValue(new Error("disabled"));
  render(<ProviderOrganizerCreateAction calendarID={calendarID} color="red" />);
  await Promise.resolve();
  expect(
    screen.queryByRole("button", { name: "Create Google meeting" }),
  ).toBeNull();
});

it("allows correcting a guest after explicit pre-admission rejection", async () => {
  api.save
    .mockRejectedValueOnce(
      Object.assign(new Error("Choose external guests"), {
        organizerAdmissionRejected: true,
      }),
    )
    .mockResolvedValue({ status: "pending" });
  render(
    <ProviderOrganizerEditor
      calendarID={calendarID}
      color="red"
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Planning" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Guest email addresses" }),
    { target: { value: "owner@example.test" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Create and send invitations" }),
  );
  await screen.findByText("Choose external guests");
  expect(
    (
      screen.getByRole("textbox", {
        name: "Guest email addresses",
      }) as HTMLTextAreaElement
    ).disabled,
  ).toBe(false);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Guest email addresses" }),
    { target: { value: "guest@example.test" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Create and send invitations" }),
  );
  await screen.findByText(/Meeting change saved/);
  expect(api.save.mock.calls[1][0].guests[0].email).toBe("guest@example.test");
  expect(api.save.mock.calls[1][0].operationID).not.toBe(
    api.save.mock.calls[0][0].operationID,
  );
});

it("can correct a DST-invalid time after the server rejects admission", async () => {
  api.save
    .mockRejectedValueOnce(
      Object.assign(new Error("Check meeting time"), {
        organizerAdmissionRejected: true,
      }),
    )
    .mockResolvedValue({ status: "pending" });
  render(
    <ProviderOrganizerEditor
      calendarID={calendarID}
      color="red"
      event={event}
      observation={observation}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Start"), {
    target: { value: "2026-03-29T02:45" },
  });
  fireEvent.change(screen.getByLabelText("End"), {
    target: { value: "2026-03-29T03:15" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save and notify guests" }),
  );
  await screen.findByText("Check meeting time");
  expect((screen.getByLabelText("Start") as HTMLInputElement).disabled).toBe(
    false,
  );
  fireEvent.change(screen.getByLabelText("Start"), {
    target: { value: "2026-03-29T03:00" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save and notify guests" }),
  );
  await screen.findByText(/Meeting change saved/);
  expect(api.save.mock.calls[1][0].patch.time.startLocal).toBe(
    "2026-03-29T03:00:00.000",
  );
  expect(api.save.mock.calls[1][0].operationID).not.toBe(
    api.save.mock.calls[0][0].operationID,
  );
});
it("edits CalDAV content without rebasing native time and explicitly requests server invitations", async () => {
  api.save.mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "caldav", actions: ["update", "delete"] } }} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Manage CalDAV meeting" })).toBeTruthy();
  expect(screen.queryByLabelText("Start")).toBeNull();
  expect(screen.queryByLabelText("Event time zone")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "caldav", notificationPolicy: "server-invite", expectedRevision: 4, patch: { description: null } });
  expect(api.save.mock.calls[0][0]).not.toHaveProperty("sendUpdates");
});
it("opens verified CalDAV creation in explicit UTC", async () => {
  api.observe.mockResolvedValue({ provider: "caldav", calendarID, notificationPolicy: "server-invite", createTime: "utc-or-all-day" });
  api.save.mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerCreateAction calendarID={calendarID} color="red" />);
  fireEvent.click(await screen.findByRole("button", { name: "Create CalDAV meeting" }));
  expect((screen.getByRole("combobox", { name: "Event time zone" }) as HTMLInputElement).value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect((screen.getByRole("combobox", { name: "Event time zone" }) as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Meeting" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Guest email addresses" }), { target: { value: "guest@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and send invitations" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "caldav", notificationPolicy: "server-invite", time: { kind: "zoned", timeZone: "UTC" } });
});
for (const action of ["update", "delete"] as const) it(`offers only the proven CalDAV ${action} action`, async () => {
  api.save.mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "caldav", actions: [action] } }} onClose={vi.fn()} />);
  expect(!!screen.queryByRole("button", { name: "Save and notify guests" })).toBe(action === "update");
  expect(!!screen.queryByRole("button", { name: "Cancel meeting and notify guests" })).toBe(action === "delete");
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).disabled).toBe(action === "delete");
  if (action === "delete") {
    fireEvent.click(screen.getByRole("button", { name: "Cancel meeting and notify guests" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel CalDAV meeting" })).getByRole("button", { name: "Cancel meeting and notify guests" }));
    await screen.findByRole("status"); expect(api.save.mock.calls[0][0].action).toBe("delete");
  }
});
it("retries the exact cancellation-only request after dismissing its failed confirmation", async () => {
  api.save.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "caldav", actions: ["delete"] } }} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel meeting and notify guests" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel CalDAV meeting" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel meeting and notify guests" }));
  await within(confirmation).findByText("Response lost");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Keep meeting" }));
  expect(screen.queryByRole("dialog", { name: "Cancel CalDAV meeting" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save and notify guests" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save).toHaveBeenCalledTimes(2);
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
  expect(api.save.mock.calls[1][0]).toMatchObject({ action: "delete", provider: "caldav", notificationPolicy: "server-invite" });
});

it("edits a bound occurrence with its exact parent observation and hides time and guest editing", async () => {
  api.save.mockResolvedValue({ status: "pending" });
  const child = { ...event, seriesID: "00000000-0000-4000-8000-000000000003", originalStart: { kind: "instant" as const, value: "2026-10-23T08:00:00.000Z" } };
  const observed = { ...observation, organizerEdit: { ...observation.organizerEdit!, scope: "occurrence" as const, instanceVersion: "b".repeat(64) } };
  render(<ProviderOrganizerEditor event={child} observation={observed} calendarID={calendarID} color="red" onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Manage this occurrence" })).toBeTruthy();
  expect(screen.queryByLabelText("Start")).toBeNull();
  expect(screen.queryByLabelText("All day")).toBeNull();
  expect(screen.queryByLabelText("Guest email addresses")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Changed occurrence" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ eventID: child.id, expectedRevision: 4, scope: "occurrence", expectedInstanceVersion: "b".repeat(64), patch: { title: "Changed occurrence" } });
  expect(api.save.mock.calls[0][0].patch).not.toHaveProperty("time");
});
it("requires explicit cancellation of only the bound occurrence", async () => {
  api.save.mockResolvedValue({ status: "pending" });
  const observed = { ...observation, organizerEdit: { ...observation.organizerEdit!, scope: "occurrence" as const, instanceVersion: "b".repeat(64) } };
  render(<ProviderOrganizerEditor event={event} observation={observed} calendarID={calendarID} color="red" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel this occurrence and notify guests" }));
  expect(api.save).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", { name: "Cancel this occurrence" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel this occurrence and notify guests" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ action: "delete", scope: "occurrence", expectedInstanceVersion: "b".repeat(64) });
});
it("reschedules in the proven native zone and preserves the frozen retry", async () => {
  api.save.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "caldav", actions: ["update"], timeEdit: true } }} onClose={vi.fn()} />);
  const zone = screen.getByRole("combobox", { name: "Event time zone" }) as HTMLInputElement;
  expect(zone.value).toBe("Europe/Prague"); expect(zone.disabled).toBe(true);
  expect((screen.getByRole("checkbox", { name: "All day" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Start", { exact: true }), { target: { value: "2026-10-25T10:00" } });
  fireEvent.change(screen.getByLabelText("End", { exact: true }), { target: { value: "2026-10-25T11:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("Response lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" })); await screen.findByRole("status");
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
  expect(api.save.mock.calls[0][0].patch).toEqual({ time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-10-25T10:00:00.000", endLocal: "2026-10-25T11:00:00.000" } });
});

it("opens verified Outlook creation in explicit UTC", async () => {
  api.observe.mockResolvedValue({ provider: "microsoft", calendarID, notificationPolicy: "server-invite", createTime: "utc-or-all-day" });
  api.save.mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerCreateAction calendarID={calendarID} color="red" />);
  fireEvent.click(await screen.findByRole("button", { name: "Create Outlook meeting" }));
  expect((screen.getByRole("combobox", { name: "Event time zone" }) as HTMLInputElement).value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect((screen.getByRole("combobox", { name: "Event time zone" }) as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Meeting" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Guest email addresses" }), { target: { value: "guest@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and send invitations" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "microsoft", notificationPolicy: "server-invite", time: { kind: "zoned", timeZone: "UTC" } });
});

it("delegates the verified calendar action to shared creation with its focus target", async () => {
  api.observe.mockResolvedValue({ provider: "google", calendarID, sendUpdates: "all" });
  const onCreate = vi.fn();
  render(<ProviderOrganizerCreateAction calendarID={calendarID} color="red" onCreate={onCreate} />);
  const trigger = await screen.findByRole("button", { name: "Create Google meeting" });
  fireEvent.click(trigger);
  expect(onCreate).toHaveBeenCalledExactlyOnceWith(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.save).not.toHaveBeenCalled();
});

it("passes discovered alias choices to the per-calendar editor", async () => {
  api.observe.mockResolvedValue({ provider: "caldav", calendarID, organizerAddresses: ["mailto:first@example.test", "mailto:second@example.test"] });
  api.save.mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerCreateAction calendarID={calendarID} color="red" />);
  fireEvent.click(await screen.findByRole("button", { name: "Create CalDAV meeting" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Planning" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Guest email addresses" }), { target: { value: "guest@example.test" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Organizer address" }));
  fireEvent.click(await screen.findByRole("option", { name: "second@example.test" }));
  fireEvent.click(screen.getByRole("button", { name: "Create and send invitations" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "caldav", organizerAddress: "mailto:second@example.test" });
});

it("offers the proven Outlook cancellation with Outlook wording and frozen request identity", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", actions: ["delete"] } }} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Save and notify guests" })).toBeNull();
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel meeting and notify guests" }));
  const dialog = await screen.findByRole("dialog", { name: "Cancel Outlook meeting" });
  expect(within(dialog).getByText(/Outlook will be asked to cancel/)).toBeTruthy();
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel meeting and notify guests" }));
  await screen.findByText("offline");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel meeting and notify guests" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "microsoft", action: "delete", notificationPolicy: "server-invite", expectedRevision: 4 });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});

it("edits Outlook content without exposing time or guests and preserves a lost request", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", actions: ["update", "delete"] } }} onClose={vi.fn()} />);
  expect(screen.queryByRole("textbox", { name: "Guest email addresses" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start time" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "New Outlook title" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("offline");
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Cancel meeting and notify guests" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4, patch: { title: "New Outlook title", description: null } });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
  expect(api.save.mock.calls[0][0].patch).not.toHaveProperty("time");
});

it("binds an Outlook occurrence to its family observation without series or time controls", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"] } }} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Manage this occurrence" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Cancel.*notify/ })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Event time zone" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Location" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "microsoft", action: "update", scope: "occurrence", expectedSeriesVersion: "c".repeat(64), patch: { location: null } });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});

it("edits the series content rather than overwriting it with a selected exception", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={{ ...event, title: "Individual title" }} observation={{ ...observation,
    outlookSeriesContent: { calendarID, expectedRevision: 4, seriesVersion: "d".repeat(64), content: { title: "Series title", description: "Series notes", location: "Series room" } },
    organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", scope: "series", seriesVersion: "d".repeat(64), actions: ["update"] },
  }} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Edit series" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Series title");
  expect(screen.getByText(/Individual occurrence changes are preserved/)).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Event time zone" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Cancel.*notify/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ provider: "microsoft", action: "update", scope: "series", expectedSeriesVersion: "d".repeat(64), patch: { description: null } });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});

it("reschedules a proven Outlook occurrence in the verified Prague zone and freezes the complete time on retry", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={{ ...event, timeModel: { kind: "legacy-unknown" } }} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"], timeEdit: true, timeZone: "Europe/Prague" } }} onClose={vi.fn()} />);
  expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("2026-10-24T10:00");
  expect((screen.getByRole("checkbox", { name: "All day" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-10T13:00" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-10T14:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("offline");
  expect((screen.getByLabelText("Start") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ scope: "occurrence", expectedSeriesVersion: "c".repeat(64), patch: { time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-09-10T13:00:00.000", endLocal: "2026-09-10T14:00:00.000" } } });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});

it("edits inclusive all-day dates without time controls and preserves the saved retry", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={{ ...event, isAllDay: true, start: new Date("2026-10-24T00:00:00Z"), end: new Date("2026-10-25T00:00:00Z"), timeModel: { kind: "all-day" } }} observation={{ ...observation, organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"], timeEdit: true, timeKind: "all-day" } }} onClose={vi.fn()} />);
  expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("2026-10-24");
  expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe("2026-10-25");
  expect((screen.getByRole("checkbox", { name: "All day" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("combobox", { name: "Event time zone" })).toBeNull();
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-10-24" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("offline");
  expect((screen.getByLabelText("End") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ scope: "occurrence", patch: { time: { kind: "all-day", startDate: "2026-10-24", endDate: "2026-10-24" } } });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});

it("changes only the clock time of the whole series using its first date and freezes retries", async () => {
  api.save.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ status: "pending" });
  render(<ProviderOrganizerEditor calendarID={calendarID} color="red" event={event} observation={{ ...observation,
    outlookSeriesContent: { calendarID, expectedRevision: 4, seriesVersion: "d".repeat(64), content: { title: "Series title", description: null, location: null }, time: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-20T09:00:00", endLocal: "2026-10-20T10:00:00" } },
    organizerEdit: { ...observation.organizerEdit!, provider: "microsoft", scope: "series", seriesVersion: "d".repeat(64), actions: ["update"], timeEdit: true, timeZone: "UTC" },
  }} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "Edit series" })).toBeTruthy();
  expect(screen.getByText(/Dates stay the same/)).toBeTruthy();
  expect((screen.getByLabelText("Start") as HTMLInputElement).type).toBe("time");
  expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("09:00:00");
  expect((screen.getByRole("checkbox", { name: "All day" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "13:00" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "14:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and notify guests" }));
  await screen.findByText("offline");
  expect((screen.getByLabelText("Start") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved meeting action" }));
  await screen.findByRole("status");
  expect(api.save.mock.calls[0][0]).toMatchObject({ scope: "series", expectedSeriesVersion: "d".repeat(64), patch: { time: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-20T13:00:00.000", endLocal: "2026-10-20T14:30:00.000" } } });
  expect(api.save.mock.calls[1]).toEqual(api.save.mock.calls[0]);
});
