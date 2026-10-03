import { taskCanEdit, taskDisplayCalendar, taskHomeCalendarID } from "@musubi/calendar";
import { formatTaskDate } from "../task-format";
import { X, ChevronDown, CalendarDays, GripVertical, Circle, CircleCheck, Clock3, CircleX, Flag, FlagOff, Plus, Repeat2, Trash2 } from "lucide-react";
import {
  describeAdvanced,
  isEditableRRule,
  parseAdvanced,
  splitRecurrence,
} from "@musubi/calendar/rrule-editor";
import { Fragment, useId, useLayoutEffect, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { providerFlavor } from "@musubi/types";
import type {
  Calendar,
  Settings,
  Task,
  TaskCreate,
  TaskUpdate,
} from "@musubi/types";
import { parseDateKey } from "../calendar-math";
import { toDateKey } from "../date-key";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { DatePicker } from "~/components/ui/date-picker";
import { Inspector, InspectorContent, InspectorHeaderActions } from "~/components/ui/inspector";
import { DialogBody, DialogFooter } from "~/components/ui/dialog";
import { Disclosure } from "~/components/ui/disclosure";
import { Empty } from "~/components/ui/empty";
import { Field } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Row, RowAction } from "~/components/ui/row";
import { Textarea } from "~/components/ui/textarea";
import { useKanbanDrag } from "../use-kanban-drag";
import { TaskLayoutSwitch } from "./TaskLayoutSwitch";
import { SectionLabel } from "~/components/ui/section-label";
import { TimePicker } from "~/components/ui/time-picker";
import { AccountMark } from "./ProviderIcon";
import { RecurrenceEditor } from "./RecurrenceEditor";

type TaskListProps = {
  inspectorPresentation?: Pick<Parameters<typeof Inspector>[0], "presentation" | "onPresentationChange" | "position">;
  editorOnly?: boolean;
  initialEditTask?: Task;
  onEditorClose?: () => void;
  onOpenTask?: (task: Task) => void;
  showLayoutControl?: boolean;
  layout?: "list" | "kanban";
  onLayoutChange?: (layout: "list" | "kanban") => void;
  calendars: Calendar[];
  createRequest: number;
  editableCalendarIds: ReadonlySet<string>;
  offline: boolean;
  onCreateRequestHandled: () => void;
  onCreate: (task: TaskCreate) => Promise<Task | null>;
  onRemove: (task: Task) => Promise<void>;
  onUpdate: (id: string, task: TaskUpdate) => Promise<Task | null>;
  settings: Pick<Settings, "timeFormat" | "weekStartsOn"> & Partial<Pick<Settings, "dateFormat">>;
  tasks: Task[];
  sourceTasks?: Task[];
  sourceCalendars?: Calendar[];
  calendarsResolved?: boolean;
  tasksResolved?: boolean;
};

export const TASK_STATUSES = [
  { label: "Needs action", value: "needs-action", icon: <Circle size={16} /> },
  { label: "In progress", value: "in-process", icon: <Clock3 size={16} /> },
  { label: "Completed", value: "completed", icon: <CircleCheck size={16} /> },
  { label: "Cancelled", value: "cancelled", icon: <CircleX size={16} /> },
];
export const TASK_PRIORITIES = Array.from({ length: 10 }, (_, priority) => ({
  label: priority === 0 ? "No priority" : `${priority <= 4 ? "High" : priority === 5 ? "Medium" : "Low"} (${priority})`,
  value: String(priority),
  icon: priority === 0 ? <FlagOff size={16} /> : <Flag size={16} fill={priority <= 4 ? "currentColor" : "none"} />,
}));

type Draft = TaskUpdate & { id: string };

function emptyDraft(calendarID: string): Draft {
  return {
    id: crypto.randomUUID(),
    calendarID,
    completedAt: null,
    description: null,
    due: null,
    isAllDay: false,
    percentComplete: 0,
    priority: 0,
    recurrence: null,
    relatedTo: null,
    start: null,
    status: "needs-action",
    title: "",
    url: null,
  };
}

export function taskUpdate(task: Task): TaskUpdate {
  return {
    expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0,
    expectedRevision: task.revision,
    calendarID: taskHomeCalendarID(task) ?? task.calendarID,
    completedAt: task.completedAt,
    description: task.description,
    due: task.due,
    isAllDay: task.isAllDay,
    percentComplete: task.percentComplete,
    priority: task.priority,
    recurrence: task.recurrence,
    relatedTo: task.relatedTo,
    start: task.start,
    status: task.status,
    title: task.title,
    url: task.url,
  };
}

export function taskDateKey(value: Date | null | undefined, allDay = false) {
  return value ? (allDay ? value.toISOString().slice(0, 10) : toDateKey(value)) : "";
}

/** All-day dates are UTC calendar days, never instants in the browser's zone. */
export function withTaskAllDay<T extends { start?: Date | null; due?: Date | null; isAllDay: boolean }>(draft: T, allDay: boolean): T {
  if (draft.isAllDay === allDay) return draft;
  const convert = (value: Date | null | undefined) => {
    if (!value) return value;
    const day = taskDateKey(value, draft.isAllDay);
    return allDay ? new Date(`${day}T00:00:00.000Z`) : parseDateKey(day);
  };
  return { ...draft, isAllDay: allDay, start: convert(draft.start), due: convert(draft.due) };
}

/** Keep an existing time-of-day while a date picker replaces only its date. */
export function replaceTaskDate(value: Date | null | undefined, date: string) {
  const next = parseDateKey(date);
  if (value) {
    next.setHours(
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    );
  }
  return next;
}

export function taskTime(value: Date | null | undefined) {
  if (!value) return "";
  return `${String(value.getHours()).padStart(2, "0")}:${String(
    value.getMinutes(),
  ).padStart(2, "0")}`;
}

/** Describe only rules the shared parser understands; keep imported syntax intact. */
export function taskRecurrenceSummary(
  recurrence: string | null | undefined,
  start?: Date | null,
  allDay = false,
) {
  if (!recurrence) return "Does not repeat";
  const { rrule, extras } = splitRecurrence(recurrence);
  if (extras.length || !isEditableRRule(rrule)) return "Custom recurrence";
  const config = parseAdvanced(rrule, allDay ? start?.getUTCDay() : start?.getDay());
  if (!start && !rrule.includes("BYDAY=")) config.days = new Set();
  return describeAdvanced(config);
}

/** Replace only the local clock part; dates are calendar values, never UTC slices. */
export function replaceTaskTime(value: Date | null | undefined, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  if (hours === undefined || minutes === undefined) return value ?? null;
  const next = value ? new Date(value) : new Date();
  next.setHours(hours, minutes, 0, 0);
  return next;
}

export function TaskList({
  inspectorPresentation, editorOnly = false, initialEditTask, onEditorClose, onOpenTask,
  showLayoutControl = true,
  layout: controlledLayout,
  onLayoutChange,
  calendars,
  createRequest,
  editableCalendarIds,
  offline,
  onCreateRequestHandled,
  onCreate,
  onRemove,
  onUpdate,
  settings,
  tasks: serverTasks,
  sourceTasks = serverTasks,
  sourceCalendars = calendars,
  calendarsResolved = false,
  tasksResolved = false,
}: TaskListProps) {
  const [optimisticTask, setOptimisticTask] = useState<Task>();
  const tasks = useMemo(() => optimisticTask ? serverTasks.map(task => task.id === optimisticTask.id ? { ...task, status: optimisticTask.status, priority: optimisticTask.priority, completedAt: optimisticTask.completedAt, percentComplete: optimisticTask.percentComplete } : task) : serverTasks, [serverTasks, optimisticTask]);
  const [localLayout, setLocalLayout] = useState<"list" | "kanban">("list");
  const layout = controlledLayout ?? localLayout;
  const drag = useKanbanDrag(async (task, status) => {
    const current = tasks.find(item => item.id === task.id);
    return current ? updateInline(current, { status }) : false;
  });
  const boardRef = useRef<HTMLDivElement>(null);
  const previousPositions = useRef(new Map<string, { left: number; top: number }>());
  const cardOrder = tasks.map(task => `${task.id}:${task.status}`).join("|");
  useLayoutEffect(() => {
    const next = new Map<string, { left: number; top: number }>();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const boardRect = boardRef.current?.getBoundingClientRect();
    boardRef.current?.querySelectorAll<HTMLElement>("[data-task-id]").forEach(card => {
      const id = card.dataset.taskId!;
      card.getAnimations?.().forEach(animation => animation.cancel());
      const bounds = card.getBoundingClientRect();
      const rect = { left: bounds.left - (boardRect?.left ?? 0), top: bounds.top - (boardRect?.top ?? 0) };
      const previous = previousPositions.current.get(id);
      next.set(id, rect);
      if (previous && id !== drag.draggingId && !reduced && card.animate) {
        const x = previous.left - rect.left, y = previous.top - rect.top;
        if (x || y) card.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    });
    previousPositions.current = next;
  }, [cardOrder, layout, drag.draggingId, drag.targetStatus]);
  const firstEditableCalendarID = calendars.find((calendar) =>
    editableCalendarIds.has(calendar.id),
  )?.id;
  const [handledCreateRequest, setHandledCreateRequest] =
    useState(createRequest);
  const [editing, setEditing] = useState<Task | undefined>(initialEditTask);
  const [draft, setDraft] = useState<Draft | undefined>(() =>
    initialEditTask ? { ...taskUpdate(initialEditTask), id: initialEditTask.id } : createRequest && firstEditableCalendarID && !offline
      ? emptyDraft(firstEditableCalendarID)
      : undefined,
  );
  const [removedTaskID, setRemovedTaskID] = useState<string>();
  const [ownedFields, setOwnedFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [inlineBusy, setInlineBusy] = useState(false);
  const inlineLock = useRef(false);
  const inlineControls = useRef(new Map<string, HTMLButtonElement>());
  const restoreInlineFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (inlineBusy || !restoreInlineFocus.current) return;
    const control = inlineControls.current.get(restoreInlineFocus.current);
    if (control && document.activeElement === document.body) control.focus();
    restoreInlineFocus.current = undefined;
  }, [inlineBusy, tasks]);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const calendarById = useMemo(
    () => new Map(calendars.map((calendar) => [calendar.id, calendar])),
    [calendars],
  );


  if (createRequest !== handledCreateRequest) {
    setHandledCreateRequest(createRequest);
    if (createRequest && firstEditableCalendarID && !offline) {
      openCreate();
    }
  }

  const liveTask = editing ? sourceTasks.find(task => task.id === editing.id) : undefined;
  const liveRetirement = liveTask?.providerReadRetiredGeneration ?? 0;
  const editingRetirement = editing?.providerReadRetiredGeneration ?? 0;
  const restoredContent = editing && liveTask && liveRetirement > 0 && liveRetirement === editingRetirement &&
    (["title", "description", "url", "relatedTo"] as const).some(field => (liveTask[field] ?? "") !== (editing[field] ?? ""));
  // Restoration retains the retirement counter. Refresh copied fields from the
  // newly authorized baseline even when retirement arrived in a separate read.
  if (editing && draft && liveTask && (liveRetirement > editingRetirement || restoredContent)) {
    const refreshed = { ...draft, expectedProviderReadRetiredGeneration: liveTask.providerReadRetiredGeneration ?? 0, expectedRevision: liveTask.revision };
    for (const field of ["title", "description", "url", "relatedTo"] as const) {
      if (!ownedFields.includes(field) && (draft[field] ?? "") === (editing[field] ?? "")) Object.assign(refreshed, { [field]: liveTask[field] });
    }
    setEditing(liveTask); setDraft(refreshed);
  }

  if (editing && draft && !offline && ((tasksResolved && !liveTask) || (calendarsResolved && !sourceCalendars.some(calendar => calendar.id === taskHomeCalendarID(editing)))) && removedTaskID !== editing.id) {
    const retired = { ...draft };
    for (const field of ["title", "description", "url", "relatedTo"] as const) {
      if (!ownedFields.includes(field) && (draft[field] ?? "") === (editing[field] ?? "")) Object.assign(retired, { [field]: field === "title" ? "" : null });
    }
    setDraft(retired);
    setRemovedTaskID(editing.id);
    setError("This task is no longer available from its source. Your own changes are still here.");
  }

  function resetEditor() {
    setDraft(undefined);
    setEditing(undefined);
    setOwnedFields([]);
    setRemovedTaskID(undefined);
    setError("");
    onCreateRequestHandled();
    onEditorClose?.();
  }

  function closeEditor() {
    if (!busy) resetEditor();
  }

  function openCreate(status: Task["status"] = "needs-action") {
    if (!firstEditableCalendarID || offline || busy) return;
    setEditing(undefined);
    setOwnedFields([]);
    setRemovedTaskID(undefined);
    setDraft({ ...emptyDraft(firstEditableCalendarID), status, completedAt: status === "completed" ? new Date() : null, percentComplete: status === "completed" ? 100 : 0 });
    setError("");
  }

  function openEdit(task: Task) {
    if (!taskCanEdit(task, editableCalendarIds)) return;
    setEditing(task);
    setOwnedFields([]);
    setRemovedTaskID(undefined);
    setDraft({ ...taskUpdate(task), id: task.id });
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !draft.title.trim() || busy || editing && !taskCanEdit(liveTask ?? editing, editableCalendarIds) || removedTaskID === editing?.id && !!editing) return;
    setBusy(true);
    setError("");
    try {
      const calendar = calendars.find(calendar => calendar.id === draft.calendarID);
      const input = { ...withTaskAllDay(draft, calendar?.provider === "google" || draft.isAllDay), title: draft.title.trim() };
      if (editing) await onUpdate(editing.id, input);
      else await onCreate({ ...input, id: draft.id });
      resetEditor();
    } catch {
      setError(
        editing
          ? "This task could not be saved. Your changes are still here — try again."
          : "This task could not be created. Your details are still here — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing || busy) return;
    setBusy(true);
    setError("");
    try {
      await onRemove(editing);
      resetEditor();
    } catch {
      setError("This task could not be deleted. It is still here — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function updateInline(task: Task, patch: Partial<Pick<TaskUpdate, "status" | "priority">>) {
    if (!taskCanEdit(task, editableCalendarIds) || offline || inlineLock.current || busy) return false;
    restoreInlineFocus.current = `${task.id}:${patch.status ? "status" : "priority"}`;
    inlineLock.current = true;
    setInlineBusy(true);
    const input = {
        ...taskUpdate(task),
        ...patch,
        ...(patch.status ? {
          completedAt: patch.status === "completed" ? task.completedAt ?? new Date() : null,
          percentComplete: patch.status === "completed" ? 100 : task.status === "completed" ? 0 : task.percentComplete,
        } : {}),
      };
    setOptimisticTask({ ...task, ...input });
    try {
      await onUpdate(task.id, input);
      return true;
    } catch {
      openEdit(task);
      setError("This task could not be updated. It is still unchanged — try again.");
      return false;
    } finally {
      setOptimisticTask(undefined);
      inlineLock.current = false;
      setInlineBusy(false);
    }
  }

  const editor = draft ? (
        <TaskEditor
          inspectorPresentation={inspectorPresentation}
          busy={busy}
          unavailable={Boolean(editing && (removedTaskID === editing.id || !taskCanEdit(liveTask ?? editing, editableCalendarIds)))}
          calendars={calendars}
          draft={draft}
          editableCalendarIds={editableCalendarIds}
          editing={editing}
          error={error}
          initialFocus={titleRef}
          settings={settings}
          onChange={next => {
            if (draft) setOwnedFields(previous => [...new Set([...previous, ...["title", "description", "url", "relatedTo"].filter(field => next[field as keyof Draft] !== draft[field as keyof Draft])])]);
            setDraft(next);
          }}
          onDelete={editing && removedTaskID !== editing.id ? remove : undefined}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          onSubmit={submit}
        />
      ) : null;
  if (editorOnly) return editor;

  return (
    <section
      aria-label="Tasks"
      className={cn(
        layout === "kanban"
          ? "flex h-full min-h-0 flex-col overflow-x-auto overflow-y-hidden px-6 pt-6 max-sm:px-5 max-sm:pt-5"
          : "overflow-auto p-6 max-sm:p-5",
      )}
      data-layout={layout}
      data-kanban-scroll
    >
      {showLayoutControl ? <div className="mb-5 flex flex-none justify-end">
        <TaskLayoutSwitch value={layout} onChange={next => { setLocalLayout(next); onLayoutChange?.(next); }} />
      </div> : null}
      <div ref={boardRef} className={layout === "kanban" ? "grid min-h-0 flex-1 basis-0 grid-cols-4 items-stretch gap-4 max-md:flex" : undefined}>
      {tasks.length === 0 && layout === "list" ? (
        <Empty
          action={!offline && firstEditableCalendarID ? <Button onClick={() => openCreate()}><Plus aria-hidden="true" />Create task</Button> : undefined}
          description={offline ? "Reconnect to load tasks." : undefined}
          headingLevel={2}
          title={offline ? "No saved tasks" : "No tasks yet"}
        />
      ) : (
        TASK_STATUSES.map(({ value, label, icon }) => (
          <TaskGroup
            key={value}
            kanban={layout === "kanban"}
            placeholderBeforeId={tasks.find((task, index) => task.status === value && index > tasks.findIndex(item => item.id === drag.draggingId))?.id}
            statusValue={value}
            dropActive={drag.targetStatus === value && !tasks.some(task => task.id === drag.draggingId && task.status === value)}
            draggingId={drag.draggingId}
            onDragTask={drag.begin}
            onCreate={!offline && firstEditableCalendarID ? () => openCreate(value as Task["status"]) : undefined}
            calendarById={calendarById}
            editableCalendarIds={editableCalendarIds}
            label={label}
            icon={icon}
            onEdit={onOpenTask ?? openEdit}
            readableDetail={Boolean(onOpenTask)}
            onUpdateInline={updateInline}
            busy={inlineBusy || busy}
            saving={inlineBusy}
            pendingTaskId={optimisticTask?.id}
            controls={inlineControls}
            timeFormat={settings.timeFormat}
            dateFormat={settings.dateFormat ?? "dmy"}
            tasks={tasks.filter(task => task.status === value)}
          />
        ))
      )}
      </div>
      {editor}
    </section>
  );
}

function TaskGroup({
  kanban,
  dropActive,
  onDragTask,
  draggingId,
  statusValue,
  placeholderBeforeId,
  onCreate,
  icon,
  calendarById,
  editableCalendarIds,
  label,
  onEdit,
  readableDetail,
  onUpdateInline,
  busy,
  controls,
  saving,
  pendingTaskId,
  timeFormat,
  dateFormat,
  tasks,
}: {
  kanban: boolean;
  dropActive: boolean;
  onDragTask: (task: Task, event: React.PointerEvent<HTMLElement>) => void;
  draggingId?: string;
  statusValue: string;
  placeholderBeforeId?: string;
  onCreate?: () => void;
  icon: ReactNode;
  calendarById: Map<string, Calendar>;
  editableCalendarIds: ReadonlySet<string>;
  label: string;
  onEdit: (task: Task) => void;
  readableDetail: boolean;
  onUpdateInline: (task: Task, patch: Partial<Pick<TaskUpdate, "status" | "priority">>) => Promise<boolean>;
  busy: boolean;
  saving: boolean;
  pendingTaskId?: string;
  controls: React.RefObject<Map<string, HTMLButtonElement>>;
  timeFormat: Settings["timeFormat"];
  dateFormat: Settings["dateFormat"];
  tasks: Task[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  if (!tasks.length && !kanban) return null;
  const placeholder = <li key="drop-placeholder" className="grid h-(--kanban-drag-height) place-items-center rounded-card border border-dashed border-foreground-secondary p-4 text-13 text-foreground-secondary duration-standard animate-in fade-in-0 motion-reduce:animate-none" data-drop-placeholder aria-hidden="true">Move to {label.toLowerCase()}</li>;
  const heading = <span className="flex items-center gap-2 group-data-drop-active/column:text-foreground"><span aria-hidden="true" className="inline-flex">{icon}</span>{label}{" "}<span className="inline-flex tabular-nums">{tasks.length}</span></span>;
  return (
    <section
      className={kanban
        ? "group/column relative flex min-h-0 min-w-0 flex-col gap-3 not-first:before:absolute not-first:before:inset-y-0 not-first:before:-left-2 not-first:before:border-l not-first:before:border-border-subtle max-md:w-80 max-md:flex-none"
        : "mb-7 grid gap-3"}
      aria-label={label}
      data-drop-active={dropActive || undefined}
      data-saving={saving || undefined}
      data-kanban-status={kanban ? statusValue : undefined}
    >
      <div className={kanban ? "flex flex-none items-center justify-between gap-2" : undefined}>
        <SectionLabel className="flex items-center">
          {kanban ? heading :
            /* A heading that folds its group: the small-caps label stays the
               label, so this is not a Button with its own type and fill. */
            <button type="button" className="-mx-2 inline-flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 transition-colors duration-fast hover:bg-raised hover:text-foreground" aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed(value => !value)}>
              <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform duration-fast motion-reduce:transition-none", collapsed && "-rotate-90")} />
              {heading}
            </button>}
        </SectionLabel>
        {kanban && onCreate ? <Button variant="ghost" size="compact" disabled={busy} aria-busy={saving || undefined} onClick={onCreate}><Plus aria-hidden="true" />Add task</Button> : null}
      </div>
      <div id={bodyId} hidden={!kanban && collapsed} className={kanban ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-y-contain pb-4 focus-inset" : undefined} data-kanban-column-scroll={kanban ? "" : undefined} tabIndex={kanban ? 0 : undefined} role={kanban ? "region" : undefined} aria-label={kanban ? `${label} tasks` : undefined}>
      {kanban && !tasks.length && !dropActive ? <p className="p-5 text-center text-13 text-foreground-secondary">No tasks</p> : null}
      <ul className={kanban
        ? "grid flex-none grid-cols-1 gap-3"
        : "flex flex-col divide-y divide-border-subtle overflow-hidden rounded-card border border-border bg-panel"}>
        {tasks.map((task) => {
          const calendar = taskDisplayCalendar(task, [...calendarById.values()]);
          const complete = task.status === "completed";
          const editable = taskCanEdit(task, editableCalendarIds);
          const due = task.due ? formatTaskDate(task.due, task.isAllDay, { timeFormat, dateFormat }) : undefined;
          const status = task.status === "in-process"
            ? "In progress"
            : task.status === "cancelled" ? "Cancelled" : undefined;
          const providerMark = <AccountMark size="compact" flavor={calendar ? providerFlavor(calendar) : null} color={calendar?.color} />;
          const detailText = [
            calendar?.name ?? "Unknown calendar",
            status,
            due ? `Due ${due}` : undefined,
            !editable ? "Read only" : undefined,
          ].filter(Boolean).join(" · ");
          const detail = <span className="inline-flex items-center gap-1 *:first:flex-none">{providerMark}<span>{detailText}</span></span>;
          const title = (
            <span className={cn("wrap-anywhere", complete && "text-foreground-secondary line-through")}>{task.title}</span>
          );
          if (kanban) return (
            <Fragment key={task.id}>
            {dropActive && placeholderBeforeId === task.id ? placeholder : null}
            <li
              className="flex min-w-0 flex-col gap-3 rounded-card border border-border-subtle bg-panel p-4 transition-shadow duration-standard data-dragging:not-data-drag-preview:opacity-25 data-drag-preview:border-foreground-secondary data-drag-preview:shadow-overlay data-draggable:cursor-grab data-draggable:select-none data-draggable:active:cursor-grabbing data-draggable:**:touch-manipulation motion-reduce:transition-none"
              key={task.id} data-task-id={task.id} data-editable={editable || undefined} data-dragging={draggingId === task.id || undefined}
              data-draggable={editable && !busy || undefined}
              onPointerDown={event => {
                if (!editable || busy || event.pointerType === "touch" || !(event.target instanceof Element)) return;
                if (event.target.closest('button, a, input, textarea, select, [role="combobox"], [contenteditable="true"]')) return;
                onDragTask(task, event);
              }}>
              <div className="relative flex min-h-5 items-center justify-between gap-2 pr-7 text-12 text-foreground-secondary">
                <span className="inline-flex min-w-0 items-center gap-2 *:first:flex-none"><span className="inline-flex">{providerMark}</span><span className="truncate">{calendar?.name ?? "Unknown calendar"}</span></span>
                {editable ? <Button
                  variant="ghost"
                  size="icon-compact"
                  className="absolute top-1/2 right-0 -translate-y-1/2 cursor-grab touch-none active:cursor-grabbing"
                  aria-label={`Drag ${task.title} to another status; press Enter to open task details`}
                  title="Drag to another status"
                  aria-busy={saving || undefined}
                  loading={saving && task.id === pendingTaskId}
                  disabled={busy}
                  onPointerDown={event => onDragTask(task, event)}
                  onClick={event => { if (event.detail === 0) onEdit(task); }}><GripVertical aria-hidden="true" /></Button> : <span className="truncate">Read only</span>}
              </div>
              {/* The card's own heading: prose that wraps, not a one-line control label. */}
              {editable || readableDetail ? <button type="button" className="block min-w-0 cursor-pointer rounded-sm text-left text-15 leading-normal font-medium text-foreground wrap-anywhere hover:underline hover:decoration-border-strong hover:underline-offset-4 disabled:cursor-default" disabled={busy} onClick={() => onEdit(task)}>{title}</button> : <p className="min-w-0 text-15 leading-normal font-medium text-foreground wrap-anywhere">{title}</p>}
              {task.description ? <p className="line-clamp-2 text-13 text-foreground-secondary wrap-anywhere">{task.description}</p> : null}
              <div className="flex flex-wrap gap-x-3 gap-y-2 text-12 text-foreground-secondary">
                {due ? <span className="inline-flex items-center gap-1"><CalendarDays size={14} aria-hidden="true" className="flex-none" />{due}</span> : <span>No due date</span>}
                {task.recurrence ? <span className="inline-flex items-center gap-1" title={taskRecurrenceSummary(task.recurrence, task.start, task.isAllDay)}><Repeat2 size={14} aria-hidden="true" className="flex-none" />Repeats</span> : null}
              </div>
            </li>
            </Fragment>
          );
          return (
            <li className="flex min-h-row items-center" key={task.id}>
              <div className="flex-none py-4 pl-4 max-sm:pl-3">
                <Select
                  className="w-9"
                  ref={node => { if (node) controls.current.set(`${task.id}:status`, node); else controls.current.delete(`${task.id}:status`); }}
                  label={`Status of ${task.title}`}
                  iconOnly
                  options={TASK_STATUSES}
                  size="compact"
                  value={task.status}
                  disabled={!editable || busy}
                  onChange={status => void onUpdateInline(task, { status: status as Task["status"] })}
                />
              </div>
              {editable || readableDetail ? (
                <RowAction
                  className="ml-2 min-w-0 flex-1 self-stretch"
                  detail={detail}
                  label={title}
                  showChevron={false}
                  disabled={busy}
                  onClick={() => onEdit(task)}
                />
              ) : (
                <Row className="ml-2 min-w-0 flex-1 self-stretch" detail={detail} label={title} />
              )}
            </li>
          );
        })}
        {kanban && dropActive && !placeholderBeforeId ? placeholder : null}
      </ul>
      </div>
    </section>
  );
}

type TaskEditorSurfaceProps = {
  busy: boolean;
  children: ReactNode;
  footer: ReactNode;
  initialFocus: React.RefObject<HTMLInputElement | null>;
  inspectorPresentation?: TaskListProps["inspectorPresentation"];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
};

function TaskEditorSurface({ busy, inspectorPresentation, ...props }: TaskEditorSurfaceProps) {
  return <Inspector {...inspectorPresentation} open={props.open} onOpenChange={props.onOpenChange} onRequestClose={() => { if (!busy) props.onOpenChange(false); }}>
    <InspectorContent accessibleTitle={props.title} onFocusOutside={event => event.preventDefault()}
      onOpenAutoFocus={event => { event.preventDefault(); props.initialFocus?.current?.focus(); }}>
      <header data-inspector-header="" className="flex flex-none items-start justify-between gap-4 px-6 pt-6 pb-5 max-sm:pt-7">
        <h2 className="font-serif text-22 leading-tight font-normal text-foreground">{props.title}</h2>
        <InspectorHeaderActions>
          <Button variant="ghost" size="icon-compact" aria-label="Close task editor" title="Close task editor" disabled={busy} onClick={() => props.onOpenChange(false)}>
            <X aria-hidden="true" strokeWidth={1.6} />
          </Button>
        </InspectorHeaderActions>
      </header>
      <DialogBody>{props.children}</DialogBody>
      {/* The inspector surface already pays the home-indicator inset. */}
      <DialogFooter>{props.footer}</DialogFooter>
    </InspectorContent>
  </Inspector>;
}

function TaskEditor({
  inspectorPresentation,
  busy,
  unavailable,
  calendars,
  draft,
  editableCalendarIds,
  editing,
  error,
  initialFocus,
  settings,
  onChange,
  onDelete,
  onOpenChange,
  onSubmit,
}: {
  inspectorPresentation?: TaskListProps["inspectorPresentation"];
  busy: boolean;
  unavailable: boolean;
  calendars: Calendar[];
  draft: Draft;
  editableCalendarIds: ReadonlySet<string>;
  editing?: Task;
  error: string;
  initialFocus: React.RefObject<HTMLInputElement | null>;
  settings: Pick<Settings, "timeFormat" | "weekStartsOn"> & Partial<Pick<Settings, "dateFormat">>;
  onChange: (draft: Draft) => void;
  onDelete?: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
}) {
  const googleTasks = calendars.find(calendar => calendar.id === draft.calendarID)?.provider === "google";
  const dateOnly = googleTasks || draft.isAllDay;
  const calendarOptions = calendars
    .filter((calendar) => editableCalendarIds.has(calendar.id))
    .map((calendar) => ({ label: calendar.name, value: calendar.id, icon: <AccountMark size="compact" flavor={providerFlavor(calendar)} /> }));
  const updateDate = (key: "start" | "due", value: string) =>
    onChange({
      ...withTaskAllDay(draft, dateOnly),
      [key]: value ? (dateOnly ? new Date(`${value}T00:00:00.000Z`) : replaceTaskDate(draft[key], value)) : null,
    });
  const updateTime = (key: "start" | "due", value: string) =>
    onChange({
      ...draft,
      [key]: value ? replaceTaskTime(draft[key], value) : null,
    });

  return (
    <TaskEditorSurface
      inspectorPresentation={inspectorPresentation}
      busy={busy}
      footer={
        <>
          {onDelete ? (
            <Button
              className="sm:mr-auto"
              disabled={busy}
              variant="ghost"
              onClick={() => void onDelete()}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          ) : null}
          <Button
            disabled={busy || !draft.title.trim() || unavailable}
            form="task-editor"
            loading={busy}
            type="submit"
          >
            Save task
          </Button>
        </>
      }
      initialFocus={initialFocus}
      open
      title={editing ? "Edit task" : "New task"}
      onOpenChange={onOpenChange}
    >
      <form
        className="grid content-start gap-5"
        id="task-editor"
        onSubmit={(event) => void onSubmit(event)}
      >
        <Field label="Title">
          <Input
            ref={initialFocus}
            value={draft.title}
            onChange={(event) =>
              onChange({ ...draft, title: event.target.value })
            }
          />
        </Field>
        <Field label="Calendar">
            <Select
              disabled={Boolean(editing)}
              label="Calendar"
              options={calendarOptions}
              value={draft.calendarID}
              onChange={(calendarID) => onChange(withTaskAllDay({ ...draft, calendarID }, calendars.find(calendar => calendar.id === calendarID)?.provider === "google" || draft.isAllDay))}
            />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Status">
            <Select
              label="Status"
              options={TASK_STATUSES}
              value={draft.status}
              onChange={(status) =>
                onChange({
                  ...draft,
                  completedAt: status === "completed" ? new Date() : null,
                  percentComplete:
                    status === "completed" ? 100 : draft.percentComplete,
                  status: status as Draft["status"],
                })
              }
            />
          </Field>
          <Field label="Priority">
            <Select
              label="Priority"
              options={TASK_PRIORITIES}
              value={String(draft.priority)}
              onChange={(value) =>
                onChange({ ...draft, priority: Number(value) })
              }
            />
          </Field>
        </div>
        <div className="grid gap-5">
          {(["start", "due"] as const).map(endpoint => {
            const label = endpoint === "start" ? "Start" : "Due";
            return <div className={cn("grid gap-4", dateOnly ? "grid-cols-1" : "grid-cols-3")} key={endpoint}>
              <Field className={dateOnly ? undefined : "col-span-2"} label={`${label} date`}>
                <DatePicker
                  label={`${label} date`}
                  value={taskDateKey(draft[endpoint], draft.isAllDay)}
                  weekStartsOn={settings.weekStartsOn}
                  onChange={value => updateDate(endpoint, value)}
                  onClear={() => updateDate(endpoint, "")}
                />
              </Field>
              {!dateOnly ? <Field label={`${label} time`}>
                <TimePicker
                  label={`${label} time`}
                  placeholder="Select time"
                  timeFormat={settings.timeFormat}
                  value={taskTime(draft[endpoint])}
                  onChange={value => updateTime(endpoint, value)}
                />
              </Field> : null}
            </div>;
          })}
        </div>
        {!googleTasks ? <Row label="All day" trailing={<Switch
          checked={draft.isAllDay}
          label="All day"
          disabled={busy}
          onCheckedChange={isAllDay => onChange(withTaskAllDay(draft, isAllDay))}
        />} /> : null}
        <Field label="Notes">
          <Textarea
            rows={4}
            value={draft.description ?? ""}
            onChange={(event) =>
              onChange({ ...draft, description: event.target.value || null })
            }
          />
        </Field>
        <Disclosure
          density="compact"
          icon={<Repeat2 aria-hidden="true" size={16} />}
          label="Recurrence"
          detail={taskRecurrenceSummary(draft.recurrence, draft.start, draft.isAllDay)}
        >
          {!draft.start && !draft.due ? <p className="text-13 text-muted-foreground">Set a start or due date first.</p> : null}
          <RecurrenceEditor
            followStartDate={false}
            date={taskDateKey(draft.start, draft.isAllDay) || taskDateKey(draft.due, draft.isAllDay) || toDateKey(new Date())}
            allDay={dateOnly}
            weekStartsOn={settings.weekStartsOn}
            disabled={busy || unavailable || (!draft.start && !draft.due)}
            value={draft.recurrence ?? ""}
            onChange={(recurrence) => onChange({
              ...draft,
              recurrence: recurrence || null,
            })}
          />
          <Disclosure density="compact" label="Advanced rule">
          <Field label="Recurrence rule" help="Uses iCalendar recurrence syntax.">
            <Textarea
              disabled={busy || unavailable}
              placeholder="RRULE:FREQ=WEEKLY"
              rows={2}
              spellCheck={false}
              value={draft.recurrence ?? ""}
              onChange={(event) =>
                onChange({ ...draft, recurrence: event.target.value || null })
              }
            />
          </Field>
          </Disclosure>
        </Disclosure>
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </TaskEditorSurface>
  );
}
