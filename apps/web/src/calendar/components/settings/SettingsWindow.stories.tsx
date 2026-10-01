import { SettingsSchema, type Calendar, type SettingsDocument } from "@musubi/types";
import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../../.storybook/modes";
import { SettingsWindow, type SettingsSectionId, type SettingsWindowProps } from "./SettingsWindow";

const INITIAL_SETTINGS: SettingsDocument = {
  revision: 1,
  updatedAt: new Date("2026-09-12T08:00:00.000Z"),
  value: SettingsSchema.parse({
    dateFormat: "dmy",
    defaultCalendarView: "week",
    defaultReminder: { allDay: { atMinute: 1080, daysBefore: 1 }, minutesBefore: 10 },
    notificationsOnByDefault: true,
    timeFormat: "24h",
    weekStartsOn: "monday",
  }),
};

const CALENDARS: Calendar[] = [
  { color: "#D4A574", creatorID: "user-1", id: "personal", isDefault: true, members: [], name: "Personal", role: "owner" },
  { color: "#A8B5A0", creatorID: "user-2", id: "family", members: [], name: "Family", role: "editor" },
  {
    accountId: "google-work",
    accountLabel: "work@example.com",
    color: "#7A8BA3",
    creatorID: "user-1",
    id: "studio",
    members: [],
    name: "Studio",
    provider: "google",
    role: "owner",
  },
  {
    accountId: "icloud-home",
    accountLabel: "haruki@icloud.com",
    color: "#B3A48A",
    creatorID: "user-1",
    id: "home",
    members: [],
    name: "Home",
    provider: "caldav",
    role: "owner",
    serverUrl: "https://caldav.icloud.com",
    syncStatus: "reconnect_required",
  },
];

type StoryArgs = { initial: SettingsSectionId; isAdmin?: boolean };

function SettingsStory({ initial, isAdmin }: StoryArgs) {
  const [section, setSection] = useState(initial);
  const [open, setOpen] = useState(true);
  const document = useRef(INITIAL_SETTINGS);
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const origin = getServerOrigin();
    queryClient.setQueryData(["server-capabilities", origin], {
      email: true,
      minClientVersion: "0.1.0",
      socials: ["google"],
      syncProviders: ["google", "microsoft", "caldav"],
    });
    queryClient.setQueryData(queryKeys.federated(origin, "user-1"), { servers: [] });
    return queryClient;
  });

  const props: SettingsWindowProps = {
    calendars: CALENDARS,
    isAdmin,
    onAdoptSettings: () => undefined,
    onCreateCalendar: async ({ color, name }) => ({ ...CALENDARS[0]!, color, id: "new", isDefault: false, name }),
    onDisconnectCalendar: async () => undefined,
    onExportCalendar: async () => "BEGIN:VCALENDAR\nEND:VCALENDAR",
    onImportCalendar: async ({ color, name }) => ({ ...CALENDARS[0]!, color, id: "imported", imported: 0, isDefault: false, name }),
    onLoadSettings: async () => document.current,
    onManageMembers: () => undefined,
    onNotice: () => undefined,
    onOpenChange: setOpen,
    onPatchSettings: async ({ patch }) => {
      document.current = {
        ...document.current,
        revision: document.current.revision + 1,
        value: { ...document.current.value, ...patch },
      };
      return document.current;
    },
    onRemoveCalendar: async (calendar) => calendar,
    onSectionChange: setSection,
    onUpdateCalendar: async (calendar) => calendar,
    open,
    section,
    userId: "user-1",
  };

  return (
    <QueryClientProvider client={client}>
      <SettingsWindow {...props} />
    </QueryClientProvider>
  );
}

const meta = {
  args: { initial: "general" },
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } }, layout: "fullscreen" },
  render: (args) => <SettingsStory {...args} />,
  title: "Calendar/Settings window",
} satisfies Meta<StoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

async function settingsWindow() {
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog).toBeVisible());
  await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished));
  return within(dialog);
}

export const General: Story = {
  play: async () => {
    const dialog = await settingsWindow();
    await dialog.findByRole("radiogroup", { name: "Theme" });
    expect(dialog.getByRole("heading", { name: "Date & time" })).toBeVisible();
    const theme = dialog.getByRole("radiogroup", { name: "Theme" });
    const panel = theme.closest<HTMLElement>("[data-settings-panel]")!;
    const body = panel.parentElement!;
    const bounds = body.getBoundingClientRect();
    const insets = getComputedStyle(body);
    expect(panel.getBoundingClientRect().right).toBeCloseTo(bounds.right - parseFloat(insets.paddingRight), 0);
    expect(panel.getBoundingClientRect().left).toBeCloseTo(bounds.left + parseFloat(insets.paddingLeft), 0);
  },
};

export const Calendars: Story = {
  args: { initial: "calendars" },
  play: async () => {
    const dialog = await settingsWindow();
    expect(dialog.getByRole("region", { name: "work@example.com" })).toBeVisible();
    expect(dialog.getByRole("button", { name: "Settings for Studio" })).toBeVisible();
    const firstCalendar = dialog.getByRole("button", { name: "Settings for Personal" });
    for (const name of ["New calendar", "Import .ics", "Export .ics"]) {
      expect(dialog.getByRole("button", { name }).getBoundingClientRect().bottom)
        .toBeLessThan(firstCalendar.getBoundingClientRect().top);
    }
    // Taking a calendar away lives in its own settings, not loose in the list.
    expect(dialog.queryByRole("button", { name: "Stop syncing Studio" })).toBeNull();
  },
};

export const CalendarSettings: Story = {
  args: { initial: "calendars" },
  play: async () => {
    const dialog = await settingsWindow();
    await userEvent.click(dialog.getByRole("button", { name: "Settings for Studio" }));
    const edit = await screen.findByRole("dialog", { name: "Calendar settings" });
    await waitFor(() => expect(edit).toBeVisible());
    expect(within(edit).getByRole("button", { name: "Stop syncing" })).toBeVisible();
  },
};

export const NewCalendar: Story = {
  args: { initial: "calendars" },
  play: async () => {
    const dialog = await settingsWindow();
    await userEvent.click(dialog.getByRole("button", { name: "New calendar" }));
    const create = await screen.findByRole("dialog", { name: "New calendar" });
    await waitFor(() => expect(create).toBeVisible());
    await Promise.all(create.getAnimations({ subtree: true }).map(animation => animation.finished));
    await userEvent.click(within(create).getByRole("combobox", { name: "Account" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /work@example\.com/ })).toBeVisible());
    await userEvent.click(screen.getByRole("option", { name: /work@example\.com/ }));
    await waitFor(() => expect(within(create).getByRole("combobox", { name: "Account" })).toHaveFocus());
    expect(within(create).getByRole("combobox", { name: "Account" })).toHaveTextContent("work@example.com");
  },
};

export const Connections: Story = {
  args: { initial: "connections" },
  play: async () => {
    const dialog = await settingsWindow();
    expect(dialog.getByRole("button", { name: "Google Calendar" })).toBeVisible();
    expect(dialog.getByRole("textbox", { name: "Invite link" })).toBeVisible();
    expect(dialog.getByText("Needs attention")).toBeVisible();
    expect(dialog.queryByRole("checkbox", { name: "Include Tasks" })).toBeNull();
  },
};

export const Account: Story = {
  args: { initial: "account" },
  play: async () => {
    const dialog = await settingsWindow();
    expect(dialog.getByRole("heading", { level: 2, name: "Account" })).toBeVisible();
  },
};

export const About: Story = {
  args: { initial: "about", isAdmin: true },
  play: async () => {
    const dialog = await settingsWindow();
    expect(dialog.getByRole("button", { name: /Version/ })).toBeVisible();
  },
};

export const MobileList: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  parameters: { chromatic: { modes: MOBILE_MODES } },
  play: async () => {
    const dialog = await settingsWindow();
    await userEvent.click(dialog.getByRole("button", { name: "Settings" }));
    await userEvent.click(dialog.getByRole("button", { name: "Connections" }));
    expect(dialog.getByRole("heading", { level: 2, name: "Connections" })).toBeVisible();
  },
};
