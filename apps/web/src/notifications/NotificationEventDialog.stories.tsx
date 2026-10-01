import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, screen, waitFor } from "storybook/test";
import { fixtureEvents } from "~/calendar/fixtures";
import { DESKTOP_MODES } from "../../.storybook/modes";
import { NotificationEventDialog } from "./NotificationEventDialog";

const meta = {
  title: "Patterns/Notifications/Event detail",
  component: NotificationEventDialog,
  parameters: { chromatic: { modes: DESKTOP_MODES } },
  args: { event: fixtureEvents[0], returnFocus: null, onClose: fn(), onRetry: fn() },
  play: async () => {
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toBeVisible());
  },
} satisfies Meta<typeof NotificationEventDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Cancelled: Story = { args: { event: { ...fixtureEvents[0], isCanceled: true } } };
export const Unavailable: Story = { args: { event: undefined } };
export const ReadFailure: Story = { args: { event: undefined, error: true } };
