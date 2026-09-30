import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { fn } from "storybook/test";
import { fixtureCalendars, fixtureEvents } from "../fixtures";
import { createTimeGeometry } from "../time-geometry";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { TimeGridView } from "./TimeGridView";
const meta = {
  title: "Calendar/Time grid clock changes",
  component: TimeGridView,
  parameters: { layout: "fullscreen", chromatic: { modes: DESKTOP_MODES } },
  decorators: [Story => <div className="h-dvh overflow-auto"><Story /></div>],
  args: {
    anchor: new Date(2026, 9, 25), view: "week", calendars: fixtureCalendars, geometry: createTimeGeometry(), timeFormat: "24h", weekStartsOn: "monday",
    events: [{ ...fixtureEvents[0]!, title: "Clock-change handoff", start: new Date(2026, 9, 24, 2, 30), end: new Date(2026, 9, 24, 3, 30), isAllDay: false }],
    user: { id: "alex", name: "Alex" }, getEventMaster: event => event, onForkEvent: fn(), onLinkEvent: fn(), onNotice: fn(), onRemoveEvent: fn(), onSetAttendance: fn(), onUpdateEvent: fn(), onCreateAtTime: fn(), onMoveEvent: fn(),
  },
} satisfies Meta<typeof TimeGridView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FallWeek: Story = {};
export const FallDay: Story = { args: { view: "day", events: [{ ...fixtureEvents[0]!, title: "First clock occurrence", start: new Date("2026-10-25T00:30:00Z"), end: new Date("2026-10-25T01:30:00Z"), isAllDay: false }] } };
export const SpringWeek: Story = { args: { anchor: new Date(2026, 2, 29), events: [] } };
export const Narrow: Story = { parameters: { chromatic: { modes: MOBILE_MODES } } };
