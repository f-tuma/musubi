import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskSchema, SettingsSchema } from "@musubi/types";
import { fixtureCalendars } from "../fixtures";
import { CalendarTaskContext, TaskDetails } from "./CalendarTaskDetails";
import { formatTaskDate } from "../task-format";

afterEach(cleanup);
const settings = SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", dateFormat: "dmy", timeFormat: "24h" });
const task = TaskSchema.parse({ id: "qa", creatorID: "alex", calendarID: "personal", title: "Full task", description: "Notes with more detail", status: "in-process", percentComplete: 50, priority: 1, due: new Date("2026-09-16T12:30:00Z"), recurrence: "FREQ=WEEKLY;COUNT=3", relatedTo: "related", url: "https://example.com/task" });
const related = TaskSchema.parse({ ...task, id: "related", title: "Related readable title", relatedTo: null });
function setup(offline = false) {
  const update = vi.fn(async () => task), remove = vi.fn(async () => {}), close = vi.fn();
  render(<CalendarTaskContext.Provider value={{ tasks: [task, related], calendars: fixtureCalendars, settings, offline, update, remove }}>
    <TaskDetails taskId={task.id} open onOpenChange={close} />
  </CalendarTaskContext.Provider>);
  return { update, remove, close };
}
it("shows complete task details, formats dates and opens the related task", async () => {
  const user = userEvent.setup(); setup();
  expect(screen.getByText(formatTaskDate(task.due!, false, settings))).toBeTruthy();
  expect(screen.getByText(/Every week.*3 times/)).toBeTruthy();
  expect(screen.getByRole("link", { name: task.url! }).getAttribute("href")).toBe(task.url);
  expect(within(screen.getByRole("region", { name: "Notes" })).getByText(task.description!)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: related.title }));
  expect(screen.getByRole("dialog", { name: related.title })).toBeTruthy();
});
it("opens the existing editor and saves task content without resetting hidden fields", async () => {
  const user = userEvent.setup(); const { update } = setup();
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByRole("textbox", { name: "Title" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Edited full task");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(update).toHaveBeenCalledWith(task.id, expect.objectContaining({ title: "Edited full task", url: task.url, relatedTo: task.relatedTo, percentComplete: 50 }));
});
it("requires delete confirmation and disables writes offline", async () => {
  const user = userEvent.setup(); const { remove } = setup();
  await user.click(screen.getByRole("button", { name: "More task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  expect(remove).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(remove).not.toHaveBeenCalled();
  cleanup(); setup(true);
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect((screen.getByRole("combobox", { name: "Task status" }) as HTMLButtonElement).disabled).toBe(true);
});
it("preserves all-day civil dates in each date format", () => {
  const date = new Date("2026-09-16T00:00:00Z");
  expect(formatTaskDate(date, true, settings)).toBe("16/09/2026");
  expect(formatTaskDate(date, true, { ...settings, dateFormat: "mdy" })).toBe("09/16/2026");
  expect(formatTaskDate(date, true, { ...settings, dateFormat: "ymd" })).toBe("2026-09-16");
});

it("changes priority in the inspector without changing task progress or content", async () => {
  const user = userEvent.setup(); const { update } = setup();
  await user.click(screen.getByRole("combobox", { name: "Task priority" }));
  await user.click(screen.getByRole("option", { name: "Medium (5)" }));
  expect(update).toHaveBeenCalledWith(task.id, expect.objectContaining({ priority: 5, status: task.status, percentComplete: 50, completedAt: task.completedAt, description: task.description, recurrence: task.recurrence }));
  cleanup(); setup(true);
  expect((screen.getByRole("combobox", { name: "Task priority" }) as HTMLButtonElement).disabled).toBe(true);
});

it("dismisses nested selectors on an outside press without closing the task", async () => {
  const user = userEvent.setup(); const { close, update } = setup();
  for (const label of ["Task status", "Task priority"]) {
    await user.click(screen.getByRole("combobox", { name: label }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.click(screen.getByRole("heading", { name: task.title }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: task.title })).toBeTruthy();
  }
  expect(close).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
