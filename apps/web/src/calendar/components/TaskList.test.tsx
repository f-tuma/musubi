import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withTaskAllDay,
  replaceTaskDate,
  replaceTaskTime,
  taskDateKey,
  taskTime,
  taskRecurrenceSummary,
} from "./TaskList";

describe("task editor date values", () => {
  it("keeps the local clock when changing a task date", () => {
    const original = new Date(2026, 0, 2, 14, 35, 20);
    const next = replaceTaskDate(original, "2026-02-03");

    expect(taskDateKey(next)).toBe("2026-02-03");
    expect(taskTime(next)).toBe("14:35");
    expect(next.getSeconds()).toBe(20);
  });

  it("replaces only the local time without serializing through UTC", () => {
    const original = new Date(2026, 0, 2, 14, 35, 20);
    const next = replaceTaskTime(original, "09:05");

    expect(taskDateKey(next)).toBe("2026-01-02");
    expect(taskTime(next)).toBe("09:05");
  });
});

describe("task recurrence summaries", () => {
  it("describes known rules without inventing a weekday for an undated task", () => {
    expect(taskRecurrenceSummary("FREQ=WEEKLY")).toBe("Every week");
    expect(taskRecurrenceSummary("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5")).toBe("Every week on Mon, Wed, 5 times");
  });

  it("does not approximate imported rules or omit their exceptions", () => {
    expect(taskRecurrenceSummary("FREQ=MONTHLY;BYDAY=2MO")).toBe("Custom recurrence");
    expect(taskRecurrenceSummary("RRULE:FREQ=DAILY\nEXDATE:20260912T090000Z")).toBe("Custom recurrence");
  });
});

import { cleanup, render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskSchema } from "@musubi/types";
import { TaskList } from "./TaskList";
import { fixtureCalendars } from "../fixtures";

it("refreshes a coalesced retired baseline and keeps an explicit clear through repeated retirement", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Private title", description: "Private description" });
  const onUpdate = vi.fn(async () => task);
  const props = { calendars: fixtureCalendars, tasks: [task], createRequest: 0, editableCalendarIds: new Set([task.calendarID]), offline: false, tasksResolved: true, onCreateRequestHandled: vi.fn(), onCreate: vi.fn(), onUpdate, onRemove: vi.fn(), settings: { timeFormat: "24h" as const, weekStartsOn: "monday" as const } };
  const view = render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: /Private title/ }));
  await user.clear(screen.getByRole("textbox", { name: "Notes" }));
  view.rerender(<TaskList {...props} tasks={[{ ...task, title: "Fresh permitted title", description: "Fresh permitted description", providerReadRetiredGeneration: 1 }]} />);
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Fresh permitted title");
  expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLInputElement).value).toBe("");
  view.rerender(<TaskList {...props} tasks={[{ ...task, title: "Second permitted title", description: "Second permitted description", providerReadRetiredGeneration: 2 }]} />);
  expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ title: "Second permitted title", description: null, expectedProviderReadRetiredGeneration: 2 }));
});

it("retires a removed source only after confirmed task data, retaining authored title", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Private title", description: "Private description" });
  const props = { calendars: fixtureCalendars, tasks: [task], createRequest: 0, editableCalendarIds: new Set([task.calendarID]), offline: false, onCreateRequestHandled: vi.fn(), onCreate: vi.fn(), onUpdate: vi.fn(), onRemove: vi.fn(), settings: { timeFormat: "24h" as const, weekStartsOn: "monday" as const } };
  const view = render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: /Private title/ }));
  await user.clear(screen.getByRole("textbox", { name: "Title" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "My draft");
  view.rerender(<TaskList {...props} tasks={[]} tasksResolved={false} />);
  expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLInputElement).value).toBe("Private description");
  view.rerender(<TaskList {...props} sourceCalendars={[]} calendarsResolved tasksResolved={false} />);
  expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("My draft");
  expect((screen.getByRole("button", { name: "Save task" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/no longer available from its source/)).toBeTruthy();
});

it("refreshes untouched task fields after separate retirement and same-generation restoration before saving", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Original private task", description: "Original notes", url: "https://private.example.test/old", relatedTo: "old-related" });
  const onUpdate = vi.fn(async () => task);
  const props = { calendars: fixtureCalendars, tasks: [task], createRequest: 0, editableCalendarIds: new Set([task.calendarID]), offline: false, tasksResolved: true, onCreateRequestHandled: vi.fn(), onCreate: vi.fn(), onUpdate, onRemove: vi.fn(), settings: { timeFormat: "24h" as const, weekStartsOn: "monday" as const } };
  const view = render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: /Original private task/ }));
  const retired = { ...task, title: "Private task", description: null, url: null, relatedTo: null, providerReadRetiredGeneration: 1 };
  view.rerender(<TaskList {...props} tasks={[retired]} />);
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Private task");
  expect(screen.getByRole("textbox", { name: "Notes" })).toHaveProperty("value", "");
  const restored = { ...task, title: "Restored provider title", description: "Restored provider notes", url: "https://private.example.test/restored", relatedTo: "restored-related", providerReadRetiredGeneration: 1 };
  view.rerender(<TaskList {...props} tasks={[restored]} />);
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", restored.title);
  expect(screen.getByRole("textbox", { name: "Notes" })).toHaveProperty("value", restored.description);
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ title: restored.title, description: restored.description, url: restored.url, relatedTo: restored.relatedTo, expectedProviderReadRetiredGeneration: 1 }));
});

it("preserves authored title and explicit note clear through separate retirement and restoration", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Private draft source", description: "Private notes" });
  const onUpdate = vi.fn(async () => task);
  const props = { calendars: fixtureCalendars, tasks: [task], createRequest: 0, editableCalendarIds: new Set([task.calendarID]), offline: false, tasksResolved: true, onCreateRequestHandled: vi.fn(), onCreate: vi.fn(), onUpdate, onRemove: vi.fn(), settings: { timeFormat: "24h" as const, weekStartsOn: "monday" as const } };
  const view = render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: /Private draft source/ }));
  await user.clear(screen.getByRole("textbox", { name: "Title" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "My authored title");
  await user.clear(screen.getByRole("textbox", { name: "Notes" }));
  view.rerender(<TaskList {...props} tasks={[{ ...task, title: "Private task", description: null, providerReadRetiredGeneration: 1 }]} />);
  view.rerender(<TaskList {...props} tasks={[{ ...task, title: "Authorized restored title", description: "Authorized restored notes", providerReadRetiredGeneration: 1 }]} />);
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "My authored title");
  expect(screen.getByRole("textbox", { name: "Notes" })).toHaveProperty("value", "");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ title: "My authored title", description: null, expectedProviderReadRetiredGeneration: 1 }));
});


afterEach(cleanup);

function emptyTaskProps() {
  return { calendars: fixtureCalendars, tasks: [], createRequest: 0, editableCalendarIds: new Set([fixtureCalendars[0]!.id]), offline: false, onCreateRequestHandled: vi.fn(), onCreate: vi.fn(async input => TaskSchema.parse({ revision: 1, ...input, creatorID: "owner" })), onUpdate: vi.fn(), onRemove: vi.fn(), settings: { timeFormat: "24h" as const, weekStartsOn: "monday" as const } };
}

it("keeps a folded imported recurrence unchanged when saving another field", async () => {
  const user = userEvent.setup();
  const recurrence = "RRULE:FREQ=MONTHLY;BYDAY=2MO\nEXDATE:20260914T090000Z";
  const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Plan workshop", recurrence });
  const props = { ...emptyTaskProps(), tasks: [task], onUpdate: vi.fn(async () => task) };
  render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: /Plan workshop/ }));
  expect(screen.getAllByText("Custom recurrence").length).toBeGreaterThan(0);
  expect(screen.getByRole("textbox", { name: "Recurrence rule" }).closest("details")).toHaveProperty("open", false);
  await user.type(screen.getByRole("textbox", { name: "Title" }), " together");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(props.onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ title: "Plan workshop together", recurrence }));
});

it("creates the first task through the empty state's existing task editor", async () => {
  const user = userEvent.setup();
  const props = emptyTaskProps();
  render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: "Create task" }));
  expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Prepare workshop");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Prepare workshop", calendarID: fixtureCalendars[0]!.id }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("offers no empty-state creation while offline or without an editable calendar", () => {
  const props = emptyTaskProps();
  const view = render(<TaskList {...props} offline />);
  expect(screen.getByRole("heading", { name: "No saved tasks" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create task" })).toBeNull();
  view.rerender(<TaskList {...props} editableCalendarIds={new Set()} />);
  expect(screen.queryByRole("button", { name: "Create task" })).toBeNull();
  expect(screen.getByRole("heading", { name: "No tasks yet" })).toBeTruthy();
  expect(props.onCreate).not.toHaveBeenCalled();
});

it("keeps due-only recurrence anchored without adding a start", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Weekly review", due: new Date(2026, 8, 14), start: null });
  const props = { ...emptyTaskProps(), tasks: [task], onUpdate: vi.fn(async () => task) };
  render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: /Weekly review/ }));
  await user.click(screen.getByText("Recurrence", { exact: true }));
  await user.click(screen.getByRole("combobox", { name: "Repeat" }));
  await user.click(screen.getByRole("option", { name: "Every week" }));
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(props.onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ recurrence: "FREQ=WEEKLY;BYDAY=MO", start: null }));
});

it("updates status inline without dropping recurrence", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "inline", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Inline task", recurrence: "FREQ=WEEKLY" });
  const props = { ...emptyTaskProps(), tasks: [task], onUpdate: vi.fn(async () => task) };
  render(<TaskList {...props} />);
  await user.click(screen.getByRole("combobox", { name: "Status of Inline task" }));
  await user.click(screen.getByRole("option", { name: "Completed" }));
  expect(props.onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "completed", percentComplete: 100, completedAt: expect.any(Date), recurrence: "FREQ=WEEKLY" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("exposes failed inline status writes", async () => {
  const user = userEvent.setup();
  const completedAt = new Date();
  const task = TaskSchema.parse({ revision: 1, id: "inline", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Inline task", status: "completed", completedAt, percentComplete: 100 });
  const props = { ...emptyTaskProps(), tasks: [task], onUpdate: vi.fn(async () => { throw new Error("offline"); }) };
  render(<TaskList {...props} />);
  await user.click(screen.getByRole("combobox", { name: "Status of Inline task" }));
  await user.click(screen.getByRole("option", { name: "In progress" }));
  expect(props.onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "in-process", completedAt: null, percentComplete: 0 }));
  expect(await screen.findByRole("dialog", { name: "Edit task" })).toBeTruthy();
  expect(screen.getByText(/This task could not be updated/)).toBeTruthy();
});


it("returns keyboard focus to the status control after moving between groups", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "focus", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Focus task" });
  function Example() {
    const [tasks, setTasks] = useState([task]);
    return <TaskList {...emptyTaskProps()} tasks={tasks} onUpdate={async (_id, update) => {
      const updated = { ...task, ...update };
      setTasks([updated]);
      return updated;
    }} />;
  }
  render(<Example />);
  for (const status of ["Completed", "Needs action"]) {
    await user.click(screen.getByRole("combobox", { name: "Status of Focus task" }));
    await user.click(screen.getByRole("option", { name: status }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Status of Focus task" }));
  }
});


it("groups every task under its own phase", () => {
  const statuses = ["needs-action", "in-process", "completed", "cancelled"] as const;
  const labels = ["Needs action", "In progress", "Completed", "Cancelled"];
  const tasks = statuses.map(status => TaskSchema.parse({ revision: 1, id: status, creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: `Task ${status}`, status }));
  render(<TaskList {...emptyTaskProps()} tasks={tasks} />);
  statuses.forEach((status, index) => {
    const group = screen.getByRole("heading", { name: `${labels[index]} 1` }).closest("section")!;
    expect(within(group).getByRole("button", { name: new RegExp(`Task ${status}`) })).toBeTruthy();
    expect(group.querySelectorAll("li")).toHaveLength(1);
  });
});


it("shows all four Kanban columns and creates tasks directly in their phase", async () => {
  const user = userEvent.setup();
  const props = emptyTaskProps();
  render(<TaskList {...props} layout="kanban" />);
  for (const name of ["Needs action", "In progress", "Completed", "Cancelled"]) {
    expect(screen.getByRole("region", { name })).toBeTruthy();
  }
  await user.click(within(screen.getByRole("region", { name: "Completed" })).getByRole("button", { name: "Add task" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Already done");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", percentComplete: 100, completedAt: expect.any(Date) }));
});

it("offers a keyboard path from the drag handle to task details", async () => {
  const task = TaskSchema.parse({ revision: 1, id: "drag", title: "Drag task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id });
  const onOpenTask = vi.fn();
  render(<TaskList {...emptyTaskProps()} tasks={[task]} layout="kanban" onOpenTask={onOpenTask} />);
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Drag Drag task to another status/ }), { detail: 0 });
  expect(onOpenTask).toHaveBeenCalledWith(task);
});

it("keeps read-only Kanban cards visible without drag or create actions", () => {
  const task = TaskSchema.parse({ revision: 1, id: "readonly", title: "Read only task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id });
  render(<TaskList {...emptyTaskProps()} tasks={[task]} editableCalendarIds={new Set()} offline layout="kanban" />);
  expect(screen.getByText("Read only task")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Drag Read only task/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("lets touch gestures scroll the card while keeping touch drag on its handle", () => {
  const task = TaskSchema.parse({ revision: 1, id: "touch", title: "Touch task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id });
  render(<TaskList {...emptyTaskProps()} tasks={[task]} layout="kanban" />);
  const card = screen.getByRole("button", { name: "Touch task" }).closest("[data-task-id]")!;
  const press = () => Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch", pointerId: 8, button: 0, clientX: 20, clientY: 20 });
  const scrollStart = press();
  fireEvent(card, scrollStart);
  expect(scrollStart.defaultPrevented).toBe(false);
  expect(document.querySelector("[data-drag-preview]")).toBeNull();
  fireEvent(screen.getByRole("button", { name: /Drag Touch task to another status/ }), press());
  expect(document.querySelector("[data-drag-preview]")).not.toBeNull();
  // Unmount's cleanup also cancels the animation frame and removes the preview.
  cleanup();
  expect(document.querySelector("[data-drag-preview]")).toBeNull();
});

it("follows the active pointer even when a child stops move and release propagation", async () => {
  const task = TaskSchema.parse({ revision: 1, id: "pointer", title: "Pointer task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id });
  render(<TaskList {...emptyTaskProps()} tasks={[task]} layout="kanban" />);
  const card = screen.getByRole("button", { name: "Pointer task" }).closest("[data-task-id]")!;
  const pointer = (type: string, x: number, id = 7) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerType: "mouse", pointerId: id, button: 0, clientX: x, clientY: 20,
  });
  const originalHit = document.elementFromPoint;
  document.elementFromPoint = () => card;
  const stop = (event: Event) => event.stopPropagation();
  card.addEventListener("pointermove", stop);
  card.addEventListener("pointerup", stop);
  try {
    fireEvent(card, pointer("pointerdown", 20));
    const preview = document.querySelector<HTMLElement>("[data-drag-preview]")!;
    fireEvent(card, pointer("pointermove", 150, 99));
    expect(preview.style.transform).toContain("translate3d(0px");
    fireEvent(card, pointer("pointermove", 150));
    expect(preview.style.transform).toContain("translate3d(130px");
    fireEvent.mouseMove(card, { clientX: 190, clientY: 20, buttons: 1 });
    expect(preview.style.transform).toContain("translate3d(170px");
    fireEvent(card, pointer("pointerup", 150));
    await waitFor(() => expect(document.querySelector("[data-drag-preview]")).toBeNull());
  } finally {
    document.elementFromPoint = originalHit;
    card.removeEventListener("pointermove", stop);
    card.removeEventListener("pointerup", stop);
    cleanup();
  }
});

it("collapses a list group without losing its count or tasks", async () => {
  const user = userEvent.setup();
  const task = TaskSchema.parse({ revision: 1, id: "collapse", title: "Collapsible task", creatorID: "owner", calendarID: fixtureCalendars[0]!.id });
  render(<TaskList {...emptyTaskProps()} tasks={[task]} />);
  const toggle = screen.getByRole("button", { name: "Needs action 1" });
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("combobox")).toBeNull();
  await user.click(toggle);
  expect(screen.getByRole("combobox", { name: "Status of Collapsible task" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Priority of Collapsible task" })).toBeNull();
});
describe.each(["Europe/Prague", "America/Los_Angeles"])("date-only task scheduling in %s", timezone => {
  beforeEach(() => vi.stubEnv("TZ", timezone));
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the selected local day when sending a Google Tasks due date", () => {
    expect(new Date(2026, 8, 25).getTimezoneOffset()).toBe(timezone === "Europe/Prague" ? -120 : 420);
    for (const month of [0, 8]) {
      const draft = { isAllDay: false, start: null, due: new Date(2026, month, 25, 0, 0) };
      const normalized = withTaskAllDay(draft, true);
      expect(normalized.due?.toISOString()).toBe(`2026-${String(month + 1).padStart(2, "0")}-25T00:00:00.000Z`);
      expect(taskDateKey(normalized.due, true)).toBe(taskDateKey(draft.due));
      expect(withTaskAllDay(normalized, false).due?.getDate()).toBe(25);
      expect(withTaskAllDay(normalized, true)).toBe(normalized);
    }
  });

  it("keeps a Google date's UTC calendar day in the picker in any timezone", () => {
    expect(taskDateKey(new Date("2026-09-25T00:00:00Z"), true)).toBe("2026-09-25");
  });

  it("creates Google tasks with date-only scheduling and allows clearing the date", async () => {
    const user = userEvent.setup();
    const googleCalendar = { ...fixtureCalendars[0]!, provider: "google" as const };
    const props = { ...emptyTaskProps(), calendars: [googleCalendar] };
    render(<TaskList {...props} />);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Book train tickets");
    expect(screen.queryByRole("switch", { name: "All day" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Due time" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Start time" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Due date:/ }));
    await user.type(screen.getByRole("textbox", { name: "Exact date" }), "2026-09-25{Enter}");
    await user.click(screen.getByRole("button", { name: "Save task" }));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ isAllDay: true, due: new Date("2026-09-25T00:00:00Z"), start: null }));

    const created = await props.onCreate.mock.results[0]!.value;
    cleanup();
    render(<TaskList {...props} tasks={[created]} />);
    await user.click(screen.getByRole("button", { name: /Book train tickets/ }));
    await user.click(screen.getByRole("button", { name: "Due date: Friday, September 25, 2026" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Save task" }));
    expect(props.onUpdate).toHaveBeenCalledWith(created.id, expect.objectContaining({ due: null }));
  });

  it("keeps the displayed day when moving a timed draft to a Google task list", async () => {
    const user = userEvent.setup();
    const googleCalendar = { ...fixtureCalendars[1]!, provider: "google" as const, name: "Google Tasks" };
    const props = { ...emptyTaskProps(), calendars: [fixtureCalendars[0]!, googleCalendar], editableCalendarIds: new Set([fixtureCalendars[0]!.id, googleCalendar.id]) };
    render(<TaskList {...props} />);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Book train tickets");
    expect(screen.getByRole("combobox", { name: "Due time" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Due date:/ }));
    await user.type(screen.getByRole("textbox", { name: "Exact date" }), "2026-09-25{Enter}");
    await user.click(screen.getByRole("combobox", { name: "Calendar" }));
    await user.click(screen.getByRole("option", { name: "Google Tasks" }));
    expect(screen.getByRole("button", { name: "Due date: Friday, September 25, 2026" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save task" }));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ calendarID: googleCalendar.id, isAllDay: true, due: new Date("2026-09-25T00:00:00Z") }));
  });

  it("keeps the UTC weekday when setting recurrence on an all-day task", async () => {
    const user = userEvent.setup();
    const due = new Date("2026-09-25T00:00:00Z");
    const task = TaskSchema.parse({ revision: 1, id: "all-day", creatorID: "owner", calendarID: fixtureCalendars[0]!.id, title: "Weekly review", due, start: null, isAllDay: true });
    const props = { ...emptyTaskProps(), tasks: [task] };
    render(<TaskList {...props} />);
    await user.click(screen.getByRole("button", { name: /Weekly review/ }));
    expect(screen.getByRole("button", { name: "Due date: Friday, September 25, 2026" })).toBeTruthy();
    await user.click(screen.getByText("Recurrence", { exact: true }));
    await user.click(screen.getByRole("combobox", { name: "Repeat" }));
    await user.click(screen.getByRole("option", { name: "Every week" }));
    await user.click(screen.getByRole("button", { name: "Save task" }));
    expect(props.onUpdate).toHaveBeenCalledWith(task.id, expect.objectContaining({ due, recurrence: "FREQ=WEEKLY;BYDAY=FR", start: null }));
    expect(taskRecurrenceSummary("FREQ=WEEKLY", due, true)).toBe("Every week on Fri");
  });
});


it("retries a lost create response with the same task identity and starts a new identity after acknowledgement", async () => {
  const user = userEvent.setup();
  const props = emptyTaskProps();
  props.onCreate.mockRejectedValueOnce(new Error("Lost response"));
  render(<TaskList {...props} />);
  await user.click(screen.getByRole("button", { name: "Create task" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Prepare workshop");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(screen.getByRole("alert").textContent).toContain("could not be created");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  const first = props.onCreate.mock.calls[0]![0].id;
  expect(first).toMatch(/^[a-f0-9-]{36}$/);
  expect(props.onCreate.mock.calls[1]![0].id).toBe(first);
  await user.click(screen.getByRole("button", { name: "Create task" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Separate workshop");
  await user.click(screen.getByRole("button", { name: "Save task" }));
  expect(props.onCreate.mock.calls[2]![0].id).not.toBe(first);
});
