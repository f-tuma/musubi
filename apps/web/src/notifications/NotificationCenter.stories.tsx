import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../.storybook/modes";
import { NotificationCenter } from "./NotificationCenter";
import type { AppNotification } from "./model";

const items: AppNotification[] = [
  { id: "delivery:home:meeting", title: "Studio planning", detail: "Delivery needs attention", needsAttention: true, action: { kind: "delivery", eventId: "meeting" } },
  { id: "events:family:3", title: "Family dinner", detail: "Changed by another member", needsAttention: false, action: { kind: "event", eventId: "family" } },
];

const meta = {
  title: "Patterns/Notifications",
  component: NotificationCenter,
  parameters: { chromatic: { modes: DESKTOP_MODES } },
  args: { items, readIds: new Set<string>(), onRead: fn(), onRefresh: fn(), onLoadMore: fn(), onActivate: fn() },
  render: function Story(args) {
    const [readIds, setReadIds] = useState(args.readIds);
    return <NotificationCenter {...args} readIds={readIds} onRead={ids => {
      args.onRead(ids);
      setReadIds(current => new Set([...current, ...ids]));
    }} />;
  },
} satisfies Meta<typeof NotificationCenter>;
export default meta;
type Story = StoryObj<typeof meta>;

const open: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByRole("button", { name: /^Notifications/ }));
  const panel = await screen.findByRole("dialog", { name: "Notifications" });
  await waitFor(() => expect(panel).toBeVisible());
};
export const Overview: Story = { play: open };
export const Empty: Story = { args: { items: [] }, play: open };
export const Loading: Story = { args: { items: [], loading: true }, play: open };
export const Failure: Story = { args: { error: true }, play: open };
export const EventReadFailure: Story = { args: { items: [items[0]], eventError: true }, play: open };
export const Narrow: Story = { globals: { viewport: { isRotated: false, value: "mobile1" } }, parameters: { chromatic: { modes: MOBILE_MODES } }, play: open };
export const ReadAndFocus: Story = {
  play: async context => {
    await open(context);
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    // Reading news does not clear an unresolved delivery.
    await expect(screen.getByText("1 need attention")).toBeVisible();
    await expect(screen.queryByText("New", { exact: true })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    const trigger = within(context.canvasElement).getByRole("button", { name: /Notifications · 1/ });
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: /Studio planning/ }));
    await waitFor(() => expect(context.args.onActivate).toHaveBeenCalledWith(items[0], trigger));
  },
};
