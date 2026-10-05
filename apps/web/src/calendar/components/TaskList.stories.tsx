import type { Calendar, Task, TaskCreate, TaskUpdate } from "@musubi/types";
import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { TaskList } from "./TaskList";

const CALENDARS: Calendar[] = [
  {
    color: "#7A8BA3",
    creatorID: "user-1",
    id: "work",
    isDefault: true,
    members: [],
    name: "Work",
    role: "owner",
  },
  {
    color: "#D4A574",
    creatorID: "user-1",
    id: "personal",
    members: [],
    name: "Personal",
    role: "editor",
  },
  {
    color: "#A8B5A0",
    creatorID: "user-2",
    id: "shared",
    members: [],
    name: "Team roadmap",
    role: "viewer",
  },
];

const TASKS: Task[] = [
  {
    revision: 1,
    calendarID: "work",
    completedAt: null,
    creatorID: "user-1",
    description: "Confirm the release notes and deployment window.",
    due: new Date(2026, 8, 5, 16, 0),
    id: "5df0a8e2-f15f-4a11-a4cd-269333b81b16",
    isAllDay: false,
    percentComplete: 40,
    priority: 3,
    recurrence: "FREQ=WEEKLY;BYDAY=SA",
    relatedTo: null,
    sequence: 2,
    start: new Date(2026, 8, 5, 14, 30),
    status: "in-process",
    title: "Prepare release",
    url: null,
  },
  {
    revision: 1,
    calendarID: "shared",
    completedAt: null,
    creatorID: "user-2",
    description: null,
    due: new Date(2026, 8, 8),
    id: "27e6eaa8-5d96-42dc-b986-910370251f49",
    isAllDay: true,
    percentComplete: 0,
    priority: 0,
    recurrence: null,
    relatedTo: null,
    sequence: 0,
    start: null,
    status: "needs-action",
    title: "Review the shared roadmap and collect feedback from the design team",
    url: null,
  },
  {
    revision: 1,
    calendarID: "personal",
    completedAt: new Date(2026, 8, 2, 10, 15),
    creatorID: "user-1",
    description: "Round-trip create, update and delete passed.",
    due: null,
    id: "83701c42-d14a-486e-819c-2192ab14d252",
    isAllDay: false,
    percentComplete: 100,
    priority: 0,
    recurrence: null,
    relatedTo: null,
    sequence: 1,
    start: null,
    status: "completed",
    title: "Verify CalDAV tasks",
    url: null,
  },
];

function TaskListExample({ offline = false, initialLayout = "list" }: { offline?: boolean; initialLayout?: "list" | "kanban" }) {
  const [layout, setLayout] = useState(initialLayout);
  const [tasks, setTasks] = useState(TASKS);

  async function create(input: TaskCreate): Promise<Task> {
    const task: Task = { ...input, revision: 1, creatorID: "user-1", sequence: 0 };
    setTasks((current) => [...current, task]);
    return task;
  }

  async function update(id: string, input: TaskUpdate): Promise<Task> {
    const existing = tasks.find((task) => task.id === id);
    if (!existing) throw new Error("Task not found");
    const task = { ...existing, ...input };
    setTasks((current) =>
      current.map((candidate) => (candidate.id === id ? task : candidate)),
    );
    return task;
  }

  async function remove(task: Task) {
    setTasks((current) =>
      current.filter((candidate) => candidate.id !== task.id),
    );
  }

  return (
    <TaskList
      layout={layout}
      onLayoutChange={setLayout}
      calendars={CALENDARS}
      createRequest={0}
      editableCalendarIds={new Set(offline ? [] : ["work", "personal"])}
      offline={offline}
      onCreateRequestHandled={() => undefined}
      onCreate={create}
      onRemove={remove}
      onUpdate={update}
      settings={{ timeFormat: "24h", weekStartsOn: "monday" }}
      tasks={tasks}
    />
  );
}

const meta = {
  component: TaskListExample,
  parameters: { layout: "fullscreen" },
  title: "Calendar/Task Page",
} satisfies Meta<typeof TaskListExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  parameters: { chromatic: { modes: DESKTOP_MODES } },
  render: () => <TaskListExample />,
};

export const Editor: Story = {
  parameters: { chromatic: { modes: DESKTOP_MODES } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /Prepare release/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit task" });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByLabelText("Title")).toHaveValue(
      "Prepare release",
    );
    await expect(
      within(dialog).getByRole("button", { name: "Save task" }),
    ).toBeVisible();
  },
  render: () => <TaskListExample />,
};

export const Narrow: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  parameters: { chromatic: { modes: MOBILE_MODES } },
  render: () => <TaskListExample />,
};

export const Offline: Story = {
  render: () => <TaskListExample offline />,
};


export const Kanban: Story = {
  parameters: { chromatic: { modes: DESKTOP_MODES } },
  render: () => <TaskListExample initialLayout="kanban" />,
};

export const KanbanOffline: Story = {
  render: () => <TaskListExample initialLayout="kanban" offline />,
};
