import type { Meta, StoryObj } from "@storybook/tanstack-react";
import type { Calendar, Event } from "@musubi/types";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { fixtureCalendars, fixtureEvents } from "../fixtures";
import { EventDetailsPopover } from "./EventDetailsPopover";

const calendars: Calendar[] = [
  { ...fixtureCalendars[0], provider: "google" },
  fixtureCalendars[1],
  { ...fixtureCalendars[2], provider: "microsoft" },
];
const home = calendars[1];
const event: Event = {
  ...fixtureEvents[0],
  title: "Project check-in",
  description: "Review the next milestone together.",
  hasAttendees: false,
  recurrence: null,
  originCalendarID: home.id,
  calendars: calendars.map(calendar => calendar.id),
  color: home.color,
};

function CalendarChipsPreview() {
  return <EventDetailsPopover
    calendar={calendars[0]} calendars={calendars} event={event}
    getEventMaster={() => event} user={{ id: "alex", name: "Alex" }}
    onNotice={() => {}} onForkEvent={async () => event} onLinkEvent={async () => event}
    onUpdateEvent={async updated => updated} onRemoveEvent={async removed => ({ id: removed.id, calendars: [], removed: true })}
    onSetAttendance={async () => []}
    timeFormat="24h" weekStartsOn="monday"
  ><Button>Open event details</Button></EventDetailsPopover>;
}

const meta = {
  title: "Calendar/Event details",
  component: CalendarChipsPreview,
  parameters: {
    layout: "fullscreen",
    chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Open event details" }));
    const dialog = within(document.body).getByRole("dialog", { name: event.title });
    const chips = within(within(dialog).getByRole("list", { name: "Calendars" }));
    await expect(chips.getAllByRole("listitem")).toHaveLength(3);
    await waitFor(() => expect(chips.getByRole("listitem", { name: `${home.name} · Home calendar` })).toBeVisible());
  },
} satisfies Meta<typeof CalendarChipsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const HomeCalendar: Story = {};
