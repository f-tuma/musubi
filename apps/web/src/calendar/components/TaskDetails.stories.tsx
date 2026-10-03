import { SettingsSchema, TaskSchema, type Task } from "@musubi/types";
import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { fixtureCalendars } from "../fixtures";
import { CalendarTaskContext, TaskDetails } from "./CalendarTaskDetails";

const settings = SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", dateFormat: "dmy", timeFormat: "24h" });
function SharedTask({ mode = "home" }: { mode?: "home" | "mirror" | "legacy" | "unsupported" }) {
  const [open, setOpen] = useState(true);
  const [task, setTask] = useState<Task>(() => TaskSchema.parse({ id: "shared-review", creatorID: "alex", calendarID: "personal", originCalendarID: "personal", calendarIDs: mode === "mirror" ? ["studio"] : mode === "unsupported" ? ["personal", "ms-tasks"] : ["personal", "studio"], revision: mode === "legacy" ? undefined : 4, title: "Review release notes", description: "One task shared with the studio.", status: "in-process", percentComplete: 40, priority: 5, due: new Date("2026-09-16T12:00:00Z"), capabilities: { edit: mode === "home", delete: mode === "home", link: mode === "home", fork: true, unlinkCalendarIDs: [mode === "unsupported" ? "ms-tasks" : "studio"] } }));
  const calendars = mode === "mirror" ? fixtureCalendars.filter(calendar => calendar.id !== "personal") : mode === "unsupported" ? [...fixtureCalendars, { ...fixtureCalendars[0]!, id: "ms-tasks", name: "Microsoft Tasks", provider: "microsoft", supportsTasks: true, supportsTaskLinks: false }] : fixtureCalendars;
  return <CalendarTaskContext.Provider value={{ tasks: [task], calendars, settings, offline: false,
    update: async (_id, patch) => { const saved = TaskSchema.parse({ ...task, ...patch, revision: task.revision! + 1 }); setTask(saved); return saved; },
    remove: async (_task, calendarID) => { if (!calendarID) setOpen(false); else setTask({ ...task, calendarIDs: task.calendarIDs?.filter(id => id !== calendarID), revision: task.revision! + 1 }); },
    link: async (_task, calendarID) => { const saved = { ...task, calendarIDs: [...task.calendarIDs!, calendarID], revision: task.revision! + 1 }; setTask(saved); return saved; },
    fork: async () => ({ ...task, id: "independent-copy", revision: 1 }),
  }}><Button onClick={() => setOpen(true)}>Open shared task</Button><TaskDetails taskId={task.id} open={open} onOpenChange={setOpen} /></CalendarTaskContext.Provider>;
}
const meta = { title: "Calendar/Tasks/Shared detail", component: SharedTask, parameters: { chromatic: { modes: DESKTOP_MODES } } } satisfies Meta<typeof SharedTask>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Home: Story = { play: async () => { const dialog = await screen.findByRole("dialog", { name: "Review release notes" }); await waitFor(() => expect(within(dialog).getByRole("button", { name: "Edit" })).toBeVisible()); } };
export const ReadOnlyMirror: Story = { args: { mode: "mirror" }, play: async () => { const dialog = await screen.findByRole("dialog", { name: "Review release notes" }); await expect(within(dialog).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument(); await expect(within(dialog).getByRole("combobox", { name: "Task status" })).toBeDisabled(); await waitFor(() => expect(within(dialog).getByRole("listitem", { name: "Studio · Linked calendar" })).toBeVisible()); } };
export const LegacyReadOnly: Story = { args: { mode: "legacy" }, play: async () => { await expect(await screen.findByRole("combobox", { name: "Task status" })).toBeDisabled(); } };
export const LinkDestination: Story = { play: async () => { await userEvent.click(await screen.findByRole("button", { name: "More task actions" })); await userEvent.click(screen.getByRole("menuitem", { name: "Link to another calendar" })); await userEvent.click(await screen.findByRole("button", { name: "Link to Client work" })); await waitFor(() => expect(screen.getByRole("listitem", { name: "Client work · Linked calendar" })).toBeVisible()); } };

export const UnsupportedMicrosoftLink: Story = { args: { mode: "unsupported" }, play: async () => {
  const dialog = await screen.findByRole("dialog", { name: "Review release notes" });
  await waitFor(() => expect(within(dialog).getByText("Unsupported link")).toBeVisible());
  await userEvent.click(within(dialog).getByRole("button", { name: "More task actions" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove from Microsoft Tasks" }));
  await waitFor(() => expect(screen.getByText("Only the Musubi link is removed; the Microsoft task stays in To Do.")).toBeVisible());
} };
