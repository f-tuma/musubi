import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useRef, useState, type ComponentProps } from "react";
import { Button } from "~/components/ui/button";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
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

function DrawerExample(args: ComponentProps<typeof Sidebar>) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex">
      <Sidebar {...args} isOpen={open} onModalStateChange={setModal} returnFocusRef={trigger}
        onClose={() => { args.onClose(); setOpen(false); }} />
      <main inert={modal || undefined}>
        <Button ref={trigger} variant="secondary" onClick={() => setOpen(true)}>Open navigation</Button>
      </main>
    </div>
  );
}

export const Narrow: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  parameters: { chromatic: { modes: MOBILE_MODES } },
  render: args => <DrawerExample {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Open navigation" });
    await userEvent.click(trigger);
    const drawer = await canvas.findByRole("complementary", { name: "Workspace navigation" });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Close navigation" })).toHaveFocus());
    await expect(canvas.getByRole("main")).toHaveAttribute("inert", "");
    await userEvent.tab({ shift: true });
    await expect(within(drawer).getByRole("button", { name: /^User menu for / })).toHaveFocus();
    await userEvent.tab();
    await expect(within(drawer).getByRole("button", { name: "Close navigation" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(canvas.getByRole("main")).not.toHaveAttribute("inert");
  },
};
