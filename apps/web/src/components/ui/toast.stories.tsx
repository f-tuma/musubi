import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { CalendarDays, CalendarX } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Avatar, AvatarStack } from "~/components/ui/avatar";
import { CoverageBanner, StaleBanner, UpdateBanner } from "~/components/ui/banner";
import { Button } from "~/components/ui/button";
import { Empty } from "~/components/ui/empty";
import { InlineError } from "~/components/ui/inline-error";
import { SectionLabel } from "~/components/ui/section-label";
import { Toast } from "~/components/ui/toast";

const meta = {
  title: "Design system/Feedback",
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const onUndo = fn();

export const UndoToast: Story = {
  parameters: { layout: "fullscreen" },
  render: () => <Toast action={{ label: "Undo", onClick: onUndo }} message="Design review moved to Wednesday." />,
  play: async ({ canvasElement }) => {
    onUndo.mockClear();
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole("button", { name: "Undo" }));
    await expect(onUndo).toHaveBeenCalledOnce();
  },
};

export const ErrorToast: Story = {
  parameters: { layout: "fullscreen" },
  render: () => <Toast message="Studio could not be reached." tone="error" />,
};

export const WorkspaceToast: Story = {
  parameters: { layout: "fullscreen" },
  render: () => <Toast message="Event deleted." placement="workspace" />,
};

export const EmptyStates: Story = {
  render: () => (
    <div className="grid w-full max-w-form gap-6">
      <Empty action={<Button>Connect a calendar</Button>} icon={<CalendarDays />} title="No calendars yet" />
      <Empty description="Try another word or a different calendar." icon={<CalendarX />} title="No events found" />
    </div>
  ),
};

export const Errors: Story = {
  render: () => (
    <div className="grid w-full max-w-form gap-4">
      <InlineError>Family could not be shared.</InlineError>
      <InlineError requestId="req_8f14e45f">The calendar could not be saved.</InlineError>
    </div>
  ),
};

export const RetryError: Story = {
  render: () => (
    <div className="w-full max-w-default">
      <InlineError actions={<Button size="compact" variant="ghost">Retry</Button>}>
        Account search could not load. Showing loaded data.
      </InlineError>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert");
    const action = within(alert).getByRole("button", { name: "Retry" });
    const icon = alert.querySelector("svg")!;
    const text = alert.querySelector("p")!;
    const bounds = alert.getBoundingClientRect();
    const insets = getComputedStyle(alert);
    const actionBounds = action.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const textBounds = text.getBoundingClientRect();
    expect(actionBounds.right).toBeCloseTo(bounds.right - parseFloat(insets.paddingRight) - parseFloat(insets.borderRightWidth), 0);
    expect(iconBounds.top + iconBounds.height / 2).toBeCloseTo(textBounds.top + textBounds.height / 2, 0);
    expect(actionBounds.left - textBounds.right).toBeGreaterThanOrEqual(12);
  },
};

export const Banners: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="grid gap-px">
      <StaleBanner savedAt={Date.now() - 3 * 60_000} />
      <StaleBanner savedAt={Date.now() - 45 * 60_000} tone="refreshing" />
      <StaleBanner savedAt={undefined} suffix="Changes are paused." />
      <UpdateBanner onReload={() => undefined} />
      <CoverageBanner message="Studio shows the last 12 months." />
    </div>
  ),
};

const people = [
  { id: "anna", name: "Anna Svobodová" },
  { id: "tomas", name: "Tomáš Novák" },
  { id: "eva", name: "Eva Dvořáková" },
  { id: "jan", name: "Jan Černý" },
  { id: "lucie", name: "Lucie Horáková" },
];

export const People: Story = {
  render: () => (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <SectionLabel>Avatars</SectionLabel>
        <div className="flex items-center gap-3">
          <Avatar name="Anna Svobodová" size="compact" />
          <Avatar name="Anna Svobodová" />
          <Avatar name="Anna Svobodová" size="profile" />
        </div>
      </div>
      <div className="grid gap-3">
        <SectionLabel>Guests</SectionLabel>
        <AvatarStack label="Show 5 guests" limit={3} people={people} />
      </div>
    </div>
  ),
};
