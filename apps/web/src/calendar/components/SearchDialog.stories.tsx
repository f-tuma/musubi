import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useRef, useState } from "react";
import { TaskSchema } from "@musubi/types";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { fixtureCalendars, fixtureEvents } from "../fixtures";
import { SearchDialog } from "./SearchDialog";

const retry = fn();

function Example({ failed = false }: { failed?: boolean }) {
  const [query, setQuery] = useState("Review");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <SearchDialog activeView="month" canCreateEvents canCreateTasks canCreateMeetings open query={query} setQuery={setQuery} inputRef={input} returnFocus={trigger}
    accountSource={failed ? { error: true, loading: false, retry } : undefined}
    calendars={fixtureCalendars} visibleCalendarIds={[fixtureCalendars[0]!.id]}
    events={[{ ...fixtureEvents[0]!, title: "Review release details", calendars: [fixtureCalendars[0]!.id] }]}
    tasks={[TaskSchema.parse({ id: "review-task", creatorID: "owner", title: "Review project notes", calendarID: fixtureCalendars[1]!.id })]}
    onCreateMeeting={() => {}} onCreateEvent={() => {}} onCreateTask={() => {}} onEventSelect={() => {}} onTaskSelect={() => {}} onOpenChange={() => {}} onToday={() => {}} onViewChange={() => {}} />;
}
const meta = { title: "Calendar/SearchDialog", component: Example } satisfies Meta<typeof Example>;
export default meta;
export const Overview: StoryObj<typeof meta> = {
  play: async () => {
    await waitFor(() => expect(screen.getByRole("region", { name: "Visible events" })).toBeVisible());
    await expect(screen.getByRole("region", { name: "Elsewhere in your account" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await expect(screen.getByRole("button", { name: /Review project notes/ })).toHaveAttribute("data-active");
  },
};

export const AccountError: StoryObj<typeof meta> = {
  args: { failed: true },
  play: async () => {
    retry.mockClear();
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toBeVisible());
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Visible events" })).toBeVisible();
  },
};
