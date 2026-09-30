import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { CSSProperties } from "react";
import { calendarCoverageNotice } from "@musubi/calendar";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Toolbar } from "./Toolbar";
import { NotificationCenter } from "~/notifications/NotificationCenter";

const meta = {
  title: "Calendar/Toolbar",
  component: Toolbar,
  parameters: { layout: "fullscreen", chromatic: { modes: DESKTOP_MODES } },
  decorators: [(Story) => <div className="w-full self-start"><Story /></div>],
  args: {
    notifications: <NotificationCenter items={[]} readIds={new Set()} onRead={fn()} onActivate={fn()} onRefresh={fn()} onLoadMore={fn()} />,
    activeView: "month",
    availability: { shown: false, onToggle: fn(), onOpenList: fn() },
    canCreateEvents: true,
    canCreateMeetings: true,
    canCreateTasks: true,
    coverageNotice: calendarCoverageNotice([{ provider: "microsoft", supportsEvents: true }]),
    onCreateEvent: fn(),
    onCreateMeeting: fn(),
    onCreateTask: fn(),
    onOpenSearch: fn(),
    onOpenSidebar: fn(),
    onPeriodChange: fn(),
    onToday: fn(),
    onViewChange: fn(),
    pageTitle: "My calendar",
    periodLabel: "September 2026",
    periodName: "month",
  },
} satisfies Meta<typeof Toolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

const openCoverage: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Calendar sync coverage" }));
  const dialog = await screen.findByRole("dialog", { name: "Calendar sync coverage" });
  await waitFor(() => expect(dialog).toBeVisible());
};

export const CoverageAction: Story = {};
export const CoverageDetails: Story = { play: openCoverage };
export const NarrowCoverageAction: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  parameters: { chromatic: { modes: MOBILE_MODES } },
};
export const NarrowCoverageDetails: Story = {
  ...NarrowCoverageAction,
  play: openCoverage,
};

const checkConstrainedControls: NonNullable<Story["play"]> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const toolbar = canvas.getByRole("banner");
  const compact = toolbar.clientWidth < 440;
  const viewControl = compact ? canvas.getByRole("combobox", { name: "Calendar view" }) : canvas.getByRole("radio", { name: "Month" });
  await waitFor(() => expect(viewControl).toBeVisible());
  const bounds = toolbar.getBoundingClientRect();
  for (const control of [
    canvas.getByRole("button", { name: "Notifications" }),
    viewControl,
    canvas.getByRole("button", { name: "Calendar sync coverage" }),
    canvas.getByRole("button", { name: "Availability" }),
    canvas.getByRole("button", { name: "Search events and actions" }),
    canvas.getByRole("button", { name: "Create event, meeting or task" }),
  ]) {
    await expect(control).toBeVisible();
    const controlBounds = control.getBoundingClientRect();
    expect(controlBounds.left).toBeGreaterThanOrEqual(bounds.left);
    expect(controlBounds.right).toBeLessThanOrEqual(bounds.right);
  }
  expect(canvas.getByText(args.periodLabel).scrollWidth).toBeLessThanOrEqual(canvas.getByText(args.periodLabel).clientWidth);
  if (compact) {
    await userEvent.click(viewControl);
    await userEvent.click(await screen.findByRole("option", { name: /^Week$/ }));
  } else {
    await userEvent.click(canvas.getByRole("radio", { name: "Week" }));
  }
  await expect(args.onViewChange).toHaveBeenCalledWith("week");
};

// Actual calendar widths after the 244px sidebar and 480px inspector reserve.
export const DockedAt1024: Story = {
  decorators: [(Story) => <div className="w-(--toolbar-demo-width) max-w-full" style={{ "--toolbar-demo-width": "300px" } as CSSProperties}><Story /></div>],
  play: checkConstrainedControls,
};
export const DockedAt1280: Story = {
  decorators: [(Story) => <div className="w-(--toolbar-demo-width) max-w-full" style={{ "--toolbar-demo-width": "556px" } as CSSProperties}><Story /></div>],
  play: checkConstrainedControls,
};
export const DockedAt1555: Story = {
  decorators: [(Story) => <div className="w-(--toolbar-demo-width) max-w-full" style={{ "--toolbar-demo-width": "831px" } as CSSProperties}><Story /></div>],
  play: checkConstrainedControls,
};
