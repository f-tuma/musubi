import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { Calendar } from "@musubi/types";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { fixtureCalendars } from "../fixtures";
import { QuickCreate } from "./QuickCreate";

const connectedCalendars: Calendar[] = [
  fixtureCalendars[0]!,
  { ...fixtureCalendars[1]!, provider: "google", accountId: "studio-google", accountLabel: "alex@studio.example" },
  { ...fixtureCalendars[2]!, provider: "google", accountId: "studio-google", accountLabel: "alex@studio.example" },
  { ...fixtureCalendars[1]!, id: "team", name: "Team", provider: "microsoft", accountId: "studio-outlook", accountLabel: "alex@studio.example" },
  { ...fixtureCalendars[3]!, provider: "caldav", serverUrl: "https://caldav.icloud.com", accountId: "family-icloud", accountLabel: "alex@icloud.example" },
];

function CreateEventPreview({ allDay = false, connectedAccounts = false }: { allDay?: boolean; connectedAccounts?: boolean }) {
  const [target, setTarget] = useState<HTMLElement>();
  return <>
    <Button onClick={event => setTarget(event.currentTarget)}>New event</Button>
    {target ? <QuickCreate
      anchor={{ returnFocus: target, x: 0, y: 0 }} calendars={connectedAccounts ? connectedCalendars : fixtureCalendars}
      date="2026-09-11" endDate={allDay ? "2026-09-11" : undefined} isAllDay={allDay}
      email="alex@example.com" userId="alex" userName="Alex Morgan" timeFormat="24h" weekStartsOn="monday"
      onCreate={async event => event} onCreated={() => {}} open
      onOpenChange={open => { if (!open) setTarget(undefined); }}
    /> : null}
  </>;
}

const meta = {
  title: "Calendar/Event creation panel",
  component: CreateEventPreview,
  parameters: { layout: "fullscreen", chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
  args: { allDay: false },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "New event" }));
    const body = within(document.body);
    await expect(body.getByRole("dialog", { name: "Create event" })).toBeVisible();
    await expect(body.getByRole("textbox", { name: "Event title" })).toHaveFocus();
    await expect(body.getByPlaceholderText("Add notes")).toBeInTheDocument();
  },
} satisfies Meta<typeof CreateEventPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Timed: Story = {};
export const AllDay: Story = { args: { allDay: true } };
export const Expanded: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "New event" }));
    const editor = within(within(document.body).getByRole("dialog", { name: "Create event" }));
    await userEvent.type(editor.getByRole("textbox", { name: "Event title" }), "Weekend plans");
    await userEvent.click(editor.getByRole("button", { name: "Expand event editor" }));
    await expect(editor.getByRole("button", { name: "Collapse event editor" })).toHaveFocus();
    await userEvent.click(editor.getByRole("button", { name: "Collapse event editor" }));
    await expect(editor.getByRole("textbox", { name: "Event title" })).toHaveValue("Weekend plans");
    await userEvent.click(editor.getByRole("button", { name: "Expand event editor" }));
  },
};
export const ConnectedAccounts: Story = {
  args: { connectedAccounts: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "New event" }));
    const editor = within(within(document.body).getByRole("dialog", { name: "Create event" }));
    await userEvent.click(editor.getByRole("button", { name: /Choose calendars/ }));
    const choices = editor.getByRole("group", { name: "Calendars for this event" });
    // Identical account addresses remain distinguishable to assistive technology.
    await expect(within(choices).getByText("· Google Calendar")).toBeInTheDocument();
    await expect(within(choices).getByText("· Outlook")).toBeInTheDocument();
    const scroller = choices.closest("form")!.querySelector<HTMLElement>('[class*="formBody"]')!;
    scroller.scrollTop += choices.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  },
};
