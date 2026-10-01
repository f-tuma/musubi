import { SettingsSchema, type SettingsDocument } from "@musubi/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureCalendars } from "../../fixtures";
import { SettingsWindow, type SettingsSectionId, type SettingsWindowProps } from "./SettingsWindow";

vi.mock("~/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { name: "Aki", email: "aki@example.com", image: null } }, refetch: vi.fn() }) },
}));

const DOCUMENT: SettingsDocument = {
  revision: 1,
  updatedAt: new Date("2026-09-12T08:00:00.000Z"),
  value: SettingsSchema.parse({ dateFormat: "dmy", defaultCalendarView: "week", notificationsOnByDefault: true, timeFormat: "24h", weekStartsOn: "monday" }),
};

afterEach(cleanup);

function Harness({ initial, ...props }: Partial<SettingsWindowProps> & { initial: SettingsSectionId }) {
  const [section, setSection] = useState(initial);
  return (
    <SettingsWindow
      calendars={fixtureCalendars}
      onAdoptSettings={vi.fn()}
      onCreateCalendar={vi.fn()}
      onDisconnectCalendar={vi.fn()}
      onExportCalendar={vi.fn()}
      onImportCalendar={vi.fn()}
      onLoadSettings={async () => DOCUMENT}
      onManageMembers={vi.fn()}
      onNotice={vi.fn()}
      onOpenChange={vi.fn()}
      onPatchSettings={async () => DOCUMENT}
      onRemoveCalendar={vi.fn()}
      onSectionChange={setSection}
      onUpdateCalendar={vi.fn()}
      open
      section={section}
      userId="owner"
      {...props}
    />
  );
}

it("lists the sections in order, with Announcements only for admins", () => {
  const { rerender } = render(<Harness initial="general" />);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("tablist", { name: "Settings sections" });
  expect(within(nav).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "General",
    "Calendars",
    "Connections",
    "Account",
    "About",
  ]);
  rerender(<Harness initial="general" isAdmin />);
  expect(within(nav).getAllByRole("tab").map((tab) => tab.textContent)).toContain("Announcements");
});

it("opens at the requested section and switches without leaving the window", async () => {
  const user = userEvent.setup();
  render(<Harness initial="calendars" />);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("tab", { name: "Calendars" }).getAttribute("aria-selected")).toBe("true");
  expect(within(dialog).getByRole("heading", { level: 2, name: "Calendars" })).toBeTruthy();
  await user.click(within(dialog).getByRole("tab", { name: "General" }));
  expect(await within(dialog).findByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  expect(within(dialog).getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
});

it("falls back to General when the admin section is not available", () => {
  render(<Harness initial="admin" />);
  expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
});

it("shows a load failure in General with a retry", async () => {
  const user = userEvent.setup();
  const onLoadSettings = vi.fn().mockRejectedValueOnce(new Error("Not Found")).mockResolvedValue(DOCUMENT);
  render(<Harness initial="general" onLoadSettings={onLoadSettings} />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Settings could not be loaded.");
  expect(alert.textContent).not.toContain("Not Found");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("radiogroup", { name: "Theme" })).toBeTruthy();
});
