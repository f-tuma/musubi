import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskSchema, SettingsSchema } from "@musubi/types";
import { fixtureCalendars } from "../fixtures";
import { CalendarTaskContext, TaskDetails } from "./CalendarTaskDetails";
import { formatTaskDate } from "../task-format";

afterEach(cleanup);
const settings = SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", dateFormat: "dmy", timeFormat: "24h" });
const task = TaskSchema.parse({ revision: 1, id: "qa", creatorID: "alex", calendarID: "personal", title: "Full task", description: "Notes with more detail", status: "in-process", percentComplete: 50, priority: 1, due: new Date("2026-09-16T12:30:00Z"), recurrence: "FREQ=WEEKLY;COUNT=3", relatedTo: "related", url: "https://example.com/task" });
const related = TaskSchema.parse({ revision: 1, ...task, id: "related", title: "Related readable title", relatedTo: null });
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

it("shows a readable mirror without its home and allows unlink without editing completion", async () => {
  const user = userEvent.setup();
  const member = fixtureCalendars[0]!;
  const shared = TaskSchema.parse({ ...task, calendarID: member.id, calendarIDs: [member.id], originCalendarID: "private-home", capabilities: { edit: false, delete: false, link: false, fork: true, unlinkCalendarIDs: [member.id] } });
  const remove = vi.fn(async () => {}), fork = vi.fn(async () => shared), update = vi.fn();
  const view = render(<CalendarTaskContext.Provider value={{ tasks: [shared], calendars: [member], settings, offline: false, update, remove, fork }}><TaskDetails taskId={shared.id} open onOpenChange={vi.fn()} /></CalendarTaskContext.Provider>);
  expect(screen.getByRole("listitem", { name: `${member.name} · Linked calendar` })).toBeTruthy();
  expect(screen.getByText(shared.description!)).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Task status" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "More task actions" }));
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: `Remove from ${member.name}` }));
  await user.click(screen.getByRole("button", { name: "Remove from calendar" }));
  expect(remove).toHaveBeenCalledWith(shared, member.id);
  expect(update).not.toHaveBeenCalled();
  view.rerender(<CalendarTaskContext.Provider value={{ tasks: [], calendars: [member], settings, offline: false, update, remove, fork }}><TaskDetails taskId={shared.id} open onOpenChange={vi.fn()} /></CalendarTaskContext.Provider>);
  expect(screen.queryByText(shared.description!)).toBeNull();
  expect(screen.queryByRole("dialog", { name: shared.title })).toBeNull();
});

it("links the canonical task with its revision using the existing destination picker", async () => {
  const user = userEvent.setup();
  const home = fixtureCalendars[0]!, destination = { ...home, id: "destination", name: "Shared work" };
  const shared = TaskSchema.parse({ ...task, calendarID: home.id, originCalendarID: home.id, calendarIDs: [home.id], revision: 7, capabilities: { edit: true, delete: true, link: true, fork: true, unlinkCalendarIDs: [] } });
  const link = vi.fn(async () => shared), fork = vi.fn(async () => shared), update = vi.fn(), remove = vi.fn();
  render(<CalendarTaskContext.Provider value={{ tasks: [shared], calendars: [home, destination], settings, offline: false, update, remove, link, fork }}><TaskDetails taskId={shared.id} open onOpenChange={vi.fn()} /></CalendarTaskContext.Provider>);
  await user.click(screen.getByRole("button", { name: "More task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Link to another calendar" }));
  await user.click(screen.getByRole("button", { name: "Link to Shared work" }));
  expect(link).toHaveBeenCalledWith(shared, destination.id);
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: shared.title })).toBeTruthy();
});

it("keeps an old cached task readable but disables writes until its revision is refreshed", () => {
  const old = { ...task, revision: undefined };
  render(<CalendarTaskContext.Provider value={{ tasks: [old], calendars: fixtureCalendars, settings, offline: false, update: vi.fn(), remove: vi.fn() }}><TaskDetails taskId={old.id} open onOpenChange={vi.fn()} /></CalendarTaskContext.Provider>);
  expect(screen.getByText(old.description!)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect((screen.getByRole("combobox", { name: "Task status" }) as HTMLButtonElement).disabled).toBe(true);
});


it("offers Microsoft only for independent copies and shows legacy unsupported links", async () => {
  const user = userEvent.setup();
  const home = fixtureCalendars[0]!, ms = { ...home, id: "ms-tasks", name: "Microsoft Tasks", provider: "microsoft", supportsTasks: true, supportsTaskLinks: false };
  const supported = { ...home, id: "google-tasks", name: "Google Tasks", provider: "google", supportsTasks: true };
  const shared = TaskSchema.parse({ ...task, recurrence: null, calendarID: home.id, originCalendarID: home.id, calendarIDs: [home.id], capabilities: { edit: true, delete: true, link: true, fork: true, unlinkCalendarIDs: [ms.id] } });
  const link = vi.fn(async () => shared), fork = vi.fn(async () => shared), remove = vi.fn(async () => {});
  const context = { tasks: [shared], calendars: [home, ms, supported], settings, offline: false, update: vi.fn(), remove, link, fork };
  const view = render(<CalendarTaskContext.Provider value={context}><TaskDetails taskId={shared.id} open onOpenChange={vi.fn()} /></CalendarTaskContext.Provider>);
  await user.click(screen.getByRole("button", { name: "More task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Link to another calendar" }));
  expect(screen.queryByRole("button", { name: "Link to Microsoft Tasks" })).toBeNull();
  expect(screen.getByRole("button", { name: "Link to Google Tasks" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to task actions" }));
  await user.click(screen.getByRole("button", { name: "More task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Make an independent copy" }));
  await user.click(screen.getByRole("button", { name: "Make copy in Microsoft Tasks" }));
  expect(fork).toHaveBeenCalledWith(shared, ms.id); expect(link).not.toHaveBeenCalled();
  view.rerender(<CalendarTaskContext.Provider value={{ ...context, tasks: [{ ...shared, calendarIDs: [home.id, ms.id] }] }}><TaskDetails taskId={shared.id} open onOpenChange={vi.fn()} /></CalendarTaskContext.Provider>);
  expect(screen.getByText("Unsupported link")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "More task actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove from Microsoft Tasks" }));
  expect(screen.getByText("Only the Musubi link is removed; the Microsoft task stays in To Do.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove from calendar" }));
  expect(remove).toHaveBeenCalledWith(expect.objectContaining({ calendarIDs: [home.id, ms.id] }), ms.id);
});
