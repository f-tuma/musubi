import type { Calendar, PageDocument } from "@musubi/types";
import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import {
  PageSettingsDialog,
  type PageSettingsDialogProps,
} from "./PageSettingsDialog";

const WORK_PAGE: PageDocument = {
  id: "d54f2172-f46b-4718-a21b-27c09e710e55",
  config: {
    calendarVisibility: {
      calendarIds: ["work", "focus"],
      mode: "include",
    },
    filters: [],
    icon: "briefcase",
    schemaVersion: 1,
    view: {
      configVersion: 1,
      density: "comfortable",
      id: "week",
      weekend: true,
    },
  },
  createdAt: new Date("2026-07-20T08:00:00.000Z"),
  isDefault: false,
  name: "Work",
  position: 1,
  revision: 4,
  updatedAt: new Date("2026-07-31T18:00:00.000Z"),
};

const CALENDARS: Calendar[] = [
  {
    color: "#7A8BA3",
    creatorID: "user-1",
    id: "work",
    isDefault: true,
    members: [],
    name: "Work",
    role: "owner",
  },
  {
    color: "#D4A574",
    creatorID: "user-1",
    id: "focus",
    members: [],
    name: "Focus time",
    role: "owner",
  },
  {
    color: "#A8B5A0",
    creatorID: "user-2",
    id: "family",
    members: [],
    name: "Family",
    role: "editor",
  },
];

function PageSettingsExample(props: PageSettingsDialogProps) {
  const [open, setOpen] = useState(true);

  return open ? (
    <PageSettingsDialog
      {...props}
      onOpenChange={(nextOpen) => {
        props.onOpenChange(nextOpen);
        setOpen(nextOpen);
      }}
    />
  ) : (
    <Button variant="secondary" onClick={() => setOpen(true)}>
      Reopen Page settings
    </Button>
  );
}

const meta = {
  args: {
    calendars: CALENDARS,
    canDelete: true,
    onCreatePage: async (request) => ({
      ...WORK_PAGE,
      config: request.config,
      id: "386990e9-6960-497e-b255-cb80012ad86e",
      name: request.name,
    }),
    onDeletePage: async () => undefined,
    onNotice: () => undefined,
    onOpenChange: () => undefined,
    onOpenPage: () => undefined,
    onSavePage: async (input) => ({
      page: {
        ...WORK_PAGE,
        config: input.config,
        name: input.name,
        revision: WORK_PAGE.revision + 1,
      },
      status: "saved",
    }),
    onSetDefaultPage: async () => undefined,
    page: WORK_PAGE,
  },
  component: PageSettingsDialog,
  parameters: {
    layout: "fullscreen",
  },
  title: "Calendar/Page settings",
} satisfies Meta<typeof PageSettingsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const expectPageSettings: NonNullable<Story["play"]> = async () => {
  const dialog = await screen.findByRole("dialog", { name: "Page settings" });
  await waitFor(() => expect(dialog).toBeVisible());
  const pageName = within(dialog).getByLabelText("Page name");
  const firstIcon = within(dialog)
    .getByRole("radio", { name: "House" })
    .closest("label");
  const lastIcon = within(dialog)
    .getByRole("radio", { name: "Briefcase" })
    .closest("label");
  const general = within(dialog).getByRole("heading", { name: "General" });
  const deletePage = within(dialog).getByRole("button", {
    name: "Delete page",
  });
  expect(deletePage.closest("[data-slot=dialog-footer]")).not.toBeNull();
  expect(firstIcon).not.toBeNull();
  expect(lastIcon).not.toBeNull();
  expect(
    Math.abs(
      firstIcon!.getBoundingClientRect().left -
        pageName.getBoundingClientRect().left,
    ),
  ).toBeLessThan(2);
  expect(
    Math.abs(
      lastIcon!.getBoundingClientRect().right -
        pageName.getBoundingClientRect().right,
    ),
  ).toBeLessThan(2);
  expect(
    Math.abs(
      general.getBoundingClientRect().left -
        pageName.getBoundingClientRect().left,
    ),
  ).toBeLessThan(2);
};

export const Overview: Story = {
  parameters: {
    chromatic: {
      modes: DESKTOP_MODES,
    },
  },
  play: expectPageSettings,
  render: (args) => <PageSettingsExample {...args} />,
};

export const NarrowSheet: Story = {
  globals: {
    viewport: {
      isRotated: false,
      value: "mobile1",
    },
  },
  parameters: {
    chromatic: {
      modes: MOBILE_MODES,
    },
  },
  play: expectPageSettings,
  render: (args) => <PageSettingsExample {...args} />,
};

export const SetAsDefault: Story = {
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Page settings" });
    const pageDialog = within(dialog);
    await userEvent.click(
      pageDialog.getByRole("button", { name: "Set as default" }),
    );
    await waitFor(() =>
      expect(
        pageDialog.getByText("Default", { selector: "span" }),
      ).toBeVisible(),
    );
  },
  render: (args) => <PageSettingsExample {...args} />,
};

export const DiscardConfirmation: Story = {
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Page settings" });
    const pageDialog = within(dialog);
    const name = pageDialog.getByRole("textbox", { name: "Page name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Deep work");
    await userEvent.click(
      pageDialog.getByRole("button", { name: "Close page settings" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "Discard page changes?",
    });
    await waitFor(() => expect(confirmation).toBeVisible());
  },
  render: (args) => <PageSettingsExample {...args} />,
};

export const DeleteConfirmation: Story = {
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Page settings" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete page" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "Delete “Work”?",
    });
    await waitFor(() => expect(confirmation).toBeVisible());
  },
  render: (args) => <PageSettingsExample {...args} />,
};

export const ManyCalendars: Story = {
  args: {
    calendars: [
      ...CALENDARS,
      ...Array.from({ length: 17 }, (_, index) => ({
        ...CALENDARS[index % CALENDARS.length]!,
        id: `additional-${index}`,
        name:
          index === 0
            ? "Planning and collaboration across the extended studio team"
            : `Studio calendar ${index + 1}`,
      })),
    ],
    page: { ...WORK_PAGE, name: "Studio planning and collaboration" },
  },
  parameters: { chromatic: { modes: DESKTOP_MODES } },
  play: expectPageSettings,
  render: (args) => <PageSettingsExample {...args} />,
};
