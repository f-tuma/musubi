import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Bell, CalendarPlus, Plus, Trash2, X } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { SectionLabel } from "~/components/ui/section-label";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";

const meta = {
  title: "Design system/Actions",
  component: Button,
  args: { children: "Save event", onClick: fn() },
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Save event" }));
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};

export const Variants: Story = {
  render: () => (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <SectionLabel>Variants</SectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Save event</Button>
          <Button variant="secondary">Cancel</Button>
          <Button variant="ghost">Skip for now</Button>
          <Button variant="destructive">
            <Trash2 aria-hidden="true" />
            Delete Family
          </Button>
          <Button variant="link">Open calendar settings</Button>
        </div>
      </div>
      <div className="grid gap-3">
        <SectionLabel>Sizes</SectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <Button>
            <CalendarPlus aria-hidden="true" />
            New event
          </Button>
          <Button size="compact" variant="secondary">
            <Plus aria-hidden="true" />
            Add calendar
          </Button>
          <Button aria-label="Notifications" size="icon" title="Notifications" variant="ghost">
            <Bell aria-hidden="true" />
          </Button>
          <Button aria-label="Close" size="icon-compact" title="Close" variant="ghost">
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="grid gap-3">
        <SectionLabel>States</SectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <Button loading>Saving</Button>
          <Button disabled>Save event</Button>
          <Button disabled variant="secondary">
            Cancel
          </Button>
          <Button aria-pressed="true" variant="ghost">
            Week
          </Button>
        </div>
      </div>
    </div>
  ),
};

export const Loading: Story = {
  args: { loading: true, children: "Saving" },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Saving" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(getComputedStyle(button).opacity).toBe("1");
  },
};

export const Waiting: Story = {
  args: { disabled: true, "aria-busy": true, children: "Add task", variant: "ghost" },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Add task" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(getComputedStyle(button).opacity).toBe("1");
  },
};

export const Link: Story = {
  render: () => (
    <Button asChild variant="link">
      <a href="#calendars">Manage calendars</a>
    </Button>
  ),
};

export const Marks: Story = {
  render: () => (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Personal</Badge>
        <Badge variant="muted">Read only</Badge>
        <Badge variant="success">Connected</Badge>
        <Badge variant="warning">Needs attention</Badge>
        <Badge variant="shu">New</Badge>
      </div>
      <Separator />
      <div className="flex flex-wrap items-center gap-4 text-13 text-foreground-secondary">
        <span className="flex items-center gap-2">
          New event <Kbd>C</Kbd>
        </span>
        <span className="flex items-center gap-2">
          Search
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </span>
        <span className="flex items-center gap-2">
          <Spinner /> Syncing Studio
        </span>
      </div>
    </div>
  ),
};
