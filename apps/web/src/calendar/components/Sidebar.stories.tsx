import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DESKTOP_MODES } from "../../../.storybook/modes";
import { Sidebar } from "./Sidebar";

const meta = {
  title: "Calendar/Sidebar",
  component: Sidebar,
  parameters: { layout: "fullscreen", chromatic: { modes: DESKTOP_MODES } },
  args: {
    activePageId: "calendar", anchor: new Date("2026-07-01T12:00:00Z"), isOpen: true,
    onClose: fn(), onCreatePage: fn(), onDateChange: fn(), onEditPage: fn(),
    onManageAccount: fn(), onManageCalendars: fn(), onManageConnections: fn(),
    onOpenSettings: fn(), onPageChange: fn(), onReorderPages: fn(), onSignOut: fn(),
    onRefreshServer: fn(), pages: [], syncLabel: "Connected to server", syncTone: "connected",
    user: { name: "Web QA", email: "web-qa@example.invalid", image: null }, weekStartsOn: "monday",
  },
} satisfies Meta<typeof Sidebar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const refresh = canvas.getByRole("button", { name: "Refresh from server" });
    const label = canvas.getByText("Connected to server");
    const buttonRect = refresh.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
    expect(buttonRect.left).toBeGreaterThan(labelRect.right);
    expect(Math.abs(buttonRect.top + buttonRect.height / 2 - labelRect.top - labelRect.height / 2)).toBeLessThan(2);
    await userEvent.tab();
    await userEvent.click(refresh);
    await expect(args.onRefreshServer).toHaveBeenCalledOnce();
  },
};
export const Refreshing: Story = {
  args: { syncLabel: "Refreshing…", syncTone: "refreshing", refreshingServer: true },
  play: async ({ canvasElement }) => {
    const refresh = within(canvasElement).getByRole("button", { name: "Refresh from server" });
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
  },
};
export const Offline: Story = { args: { syncLabel: "Offline — saved just now", syncTone: "offline" } };
