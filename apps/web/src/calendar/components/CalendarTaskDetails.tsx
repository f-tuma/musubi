import { taskCapabilities, taskCalendarIDs, taskDisplayCalendar, taskHomeCalendarID } from "@musubi/calendar";
import { AccountMark } from "./ProviderIcon";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { createContext, useContext, useState, type ReactElement, type RefObject } from "react";
import { can, providerFlavor, type Calendar, type Settings, type Task, type TaskUpdate } from "@musubi/types";
import { CalendarDays, Clock3, Ellipsis, FileText, Flag, X, Pencil, Trash2, Repeat2, Link, GitBranch, CopyPlus, Link2, ArrowLeft } from "lucide-react";
import { Inspector, InspectorContent, InspectorHeaderActions, InspectorTrigger, useInspectorPresentation } from "~/components/ui/inspector";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { InlineError } from "~/components/ui/inline-error";
import { Select } from "~/components/ui/select";
import { DetailList, DetailRow, detailLinkClassName, PanelBody, PanelFooter, PanelHeader, PanelTitle } from "./EventPanel";
import { TaskList, taskUpdate, taskRecurrenceSummary, TASK_STATUSES, TASK_PRIORITIES } from "./TaskList";
import { ItemGroup } from "~/components/ui/item";
import { RowAction } from "~/components/ui/row";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { formatTaskDate } from "../task-format";

export const CalendarTaskContext = createContext<{
  tasks: Task[]; calendars: Calendar[]; settings: Settings; offline: boolean;
  update?: (id: string, task: TaskUpdate) => Promise<Task | null>;
  remove?: (task: Task, unlinkCalendarID?: string) => Promise<void>;
  link?: (task: Task, calendarID: string) => Promise<Task | null>;
  fork?: (task: Task, calendarID: string) => Promise<Task | null>;
} | null>(null);

export function CalendarTaskDetails({ taskId, children }: { taskId: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return <TaskDetails key={taskId} taskId={taskId} open={open} onOpenChange={setOpen}>{children}</TaskDetails>;
}

/** The same task inspector is used by calendar chips, search, list and kanban. */
export function TaskDetails({ taskId, open, onOpenChange, children, returnFocus: requestedReturnFocus }: {
  taskId: string; open: boolean; onOpenChange: (open: boolean) => void; children?: ReactElement; returnFocus?: RefObject<HTMLElement | null>;
}) {
  const context = useContext(CalendarTaskContext);
  const [presentation, onPresentationChange, position] = useInspectorPresentation(open);
  const [returnFocus] = useState(() => typeof document !== "undefined" ? document.activeElement as HTMLElement | null : null);
  const [relatedId, setRelatedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unlinkCalendarID, setUnlinkCalendarID] = useState<string>();
  const [targetAction, setTargetAction] = useState<"link" | "fork">();
  const [error, setError] = useState("");
  const task = context?.tasks.find(task => task.id === (relatedId ?? taskId));
  const calendar = task ? taskDisplayCalendar(task, context?.calendars ?? []) : undefined;
  const capabilities = task ? taskCapabilities(task, context?.calendars ?? []) : undefined;
  const memberships = task ? context?.calendars.filter(calendar => taskCalendarIDs(task).includes(calendar.id)) ?? [] : [];
  const targets = context?.calendars.filter(calendar => can(calendar.role, "editTasks") && calendar.supportsTasks !== false && (!task?.recurrence || !calendar.provider) && (targetAction === "fork" || !task || !taskCalendarIDs(task).includes(calendar.id))) ?? [];
  const related = context?.tasks.find(item => item.id === task?.relatedTo);
  const editableCalendarIds = new Set(context?.calendars.filter(item => can(item.role, "editTasks") && item.supportsTasks !== false).map(item => item.id));
  const editable = !!context?.update && !context.offline && !!capabilities?.edit;
  const actionable = !!task && !context?.offline && !!(editable || capabilities?.delete || capabilities?.link && context?.link || capabilities?.fork && context?.fork || capabilities?.unlinkCalendarIDs.length);
  const format = (date: Date, allDay = task?.isAllDay ?? false) => formatTaskDate(date, allDay, context!.settings);
  async function update(patch: Partial<Pick<TaskUpdate, "status" | "priority">>) {
    if (!task || !editable || busy) return;
    setBusy(true); setError("");
    try {
      await context!.update!(task.id, { ...taskUpdate(task), ...patch,
        ...(patch.status ? {
          percentComplete: patch.status === "completed" ? 100 : task.status === "completed" ? 0 : task.percentComplete,
          completedAt: patch.status === "completed" ? task.completedAt ?? new Date() : null,
        } : {}) });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update task."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!task || !context?.remove || context.offline || busy || !(unlinkCalendarID ? capabilities?.unlinkCalendarIDs.includes(unlinkCalendarID) : capabilities?.delete)) return;
    setBusy(true); setError("");
    try { await context.remove(task, unlinkCalendarID); setConfirmDelete(false); onOpenChange(false); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not delete task."); setConfirmDelete(false); }
    finally { setBusy(false); }
  }
  async function share(calendarID: string) {
    if (!task || !context || !targetAction || busy || context.offline) return;
    const action = targetAction === "link" ? context.link : context.fork;
    if (!action || !(targetAction === "link" ? capabilities?.link : capabilities?.fork)) return;
    setBusy(true); setError("");
    try { await action(task, calendarID); setTargetAction(undefined); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not share task."); }
    finally { setBusy(false); }
  }
  return <>
    {!editing ? <Inspector position={position} presentation={presentation} onPresentationChange={onPresentationChange} open={open} onOpenChange={onOpenChange} onRequestClose={after => { if (!busy && !editing && !confirmDelete) { onOpenChange(false); after(); } }}>
      {children ? <InspectorTrigger asChild>{children}</InspectorTrigger> : null}
      <InspectorContent accessibleTitle={task?.title ?? "Task"}
        onCloseAutoFocus={event => { const target = requestedReturnFocus?.current ?? returnFocus; if (!children && target?.isConnected) { event.preventDefault(); target.focus(); } }}
        onFocusOutside={event => event.preventDefault()}>
        <PanelHeader accent={calendar?.color}>
          <PanelTitle>{task?.status === "completed" ? <s>{task.title}</s> : task?.title ?? "Task"}</PanelTitle>
          <InspectorHeaderActions><Button aria-label="Close task" title="Close task" size="icon-compact" variant="ghost" disabled={busy || editing || confirmDelete} onClick={() => onOpenChange(false)}><X aria-hidden="true" strokeWidth={1.6} /></Button></InspectorHeaderActions>
        </PanelHeader>
        <PanelBody>
          {!task ? <p className="text-13 text-muted-foreground">This task is no longer available.</p> : <>
            <DetailList>
              <DetailRow icon={<AccountMark flavor={calendar ? providerFlavor(calendar) : null} size="compact" color={calendar?.color} />} label="Calendar">
                <ul aria-label="Calendars" className="grid gap-1">{memberships.map(member => <li key={member.id} aria-label={`${member.name} · ${member.id === taskHomeCalendarID(task) ? "Home calendar" : "Linked calendar"}`} className="font-medium">{member.name}{member.id === taskHomeCalendarID(task) ? " · Home" : ""}</li>)}</ul>
              </DetailRow>
              <DetailRow icon={<TaskStatusIcon status={task.status} size={17} />} label="Status" trailing={
                <Select label="Task status" size="compact" value={task.status} options={TASK_STATUSES} disabled={!editable || busy}
                  onChange={value => { void update({ status: value as Task["status"] }); }} />}>Status</DetailRow>
              {task.start ? <DetailRow icon={<Clock3 strokeWidth={1.5} />} label="Starts">{format(task.start)}</DetailRow> : null}
              {task.due ? <DetailRow icon={<CalendarDays strokeWidth={1.5} />} label="Deadline">{format(task.due)}</DetailRow> : null}
              {task.completedAt ? <DetailRow icon={<TaskStatusIcon status="completed" size={17} />} label="Completed">{format(task.completedAt, false)}</DetailRow> : null}
              <DetailRow icon={<Flag strokeWidth={1.5} />} label="Priority" trailing={
                <Select label="Task priority" size="compact" value={String(task.priority)} options={TASK_PRIORITIES} disabled={!editable || busy}
                  onChange={value => { void update({ priority: Number(value) }); }} />}>Priority</DetailRow>
              {task.recurrence ? <DetailRow icon={<Repeat2 strokeWidth={1.5} />} label="Repeat">{taskRecurrenceSummary(task.recurrence, task.start ?? task.due)}</DetailRow> : null}
              {task.relatedTo ? <DetailRow icon={<GitBranch strokeWidth={1.5} />} label="Related task">
                {related ? <Button variant="link" disabled={busy} onClick={() => setRelatedId(related.id)}>{related.title || "Untitled task"}</Button> : <span className="text-muted-foreground">Task unavailable</span>}
              </DetailRow> : null}
              {task.url ? <DetailRow icon={<Link strokeWidth={1.5} />} label="Link">{/^https?:\/\//i.test(task.url) ? <a className={detailLinkClassName} href={task.url} target="_blank" rel="noreferrer">{task.url}</a> : task.url}</DetailRow> : null}
            </DetailList>
            {task.description ? <section className="flex gap-2" aria-label="Notes">
              <FileText aria-hidden="true" className="mt-0.5 w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
              <p className="min-w-0 flex-1 text-13 leading-normal whitespace-pre-wrap wrap-anywhere text-foreground-secondary">{task.description}</p>
            </section> : null}
          </>}
          {targetAction ? <section aria-label={targetAction === "link" ? "Link to a calendar" : "Make an independent copy"} className="grid gap-3">
            <div className="flex items-center gap-2"><Button size="icon-compact" variant="ghost" aria-label="Back to task actions" disabled={busy} onClick={() => setTargetAction(undefined)}><ArrowLeft aria-hidden="true" /></Button>
              <h3 className="font-serif text-15">{targetAction === "link" ? "Link to a calendar" : "Make an independent copy"}</h3>
              <HelpTooltip label={targetAction === "link" ? "About linking tasks" : "About task copies"}>{targetAction === "link" ? "One task, one completion status. Only its home calendar can change it." : "The copy has its own completion status and can be changed independently."}{task?.recurrence ? " This recurrence is available only in Musubi calendars." : ""}</HelpTooltip></div>
            {targets.length ? <ItemGroup>{targets.map(target => <RowAction key={target.id} label={target.name} aria-label={`${targetAction === "link" ? "Link to" : "Make copy in"} ${target.name}`} disabled={busy} icon={<AccountMark size="compact" flavor={providerFlavor(target)} color={target.color} />} onClick={() => void share(target.id)} />)}</ItemGroup> : <p className="text-13 text-muted-foreground">No available calendars</p>}
          </section> : null}
          {error ? <InlineError>{error}</InlineError> : null}
        </PanelBody>
        {actionable && task ? <PanelFooter aria-label="Task actions">
          {context?.remove ? <Menu>
            <MenuTrigger asChild>
              <Button aria-label="More task actions" title="More actions" disabled={busy} size="icon" variant="ghost"><Ellipsis aria-hidden="true" strokeWidth={1.6} /></Button>
            </MenuTrigger>
            <MenuContent align="start" label="Task actions">
              {capabilities?.link && context.link ? <MenuItem icon={<Link2 />} onSelect={() => setTargetAction("link")}>Link to another calendar</MenuItem> : null}
              {capabilities?.fork && context.fork ? <MenuItem icon={<CopyPlus />} onSelect={() => setTargetAction("fork")}>Make an independent copy</MenuItem> : null}
              {memberships.filter(member => capabilities?.unlinkCalendarIDs.includes(member.id)).map(member => <MenuItem key={member.id} icon={<Trash2 />} onSelect={() => { setUnlinkCalendarID(member.id); setConfirmDelete(true); }}>Remove from {member.name}</MenuItem>)}
              {capabilities?.delete ? <MenuItem icon={<Trash2 size={16} strokeWidth={1.6} />} tone="destructive" onSelect={() => { setUnlinkCalendarID(undefined); setConfirmDelete(true); }}>Delete</MenuItem> : null}
            </MenuContent>
          </Menu> : null}
          {editable ? <Button className="ml-auto" disabled={busy} onClick={() => setEditing(true)}><Pencil aria-hidden="true" strokeWidth={1.6} />Edit</Button> : null}
        </PanelFooter> : null}
      </InspectorContent>
    </Inspector> : null}
    {editing && task && context?.update ? <TaskList inspectorPresentation={{ presentation, onPresentationChange, position }} key={task.id} editorOnly initialEditTask={task} onEditorClose={() => setEditing(false)}
      calendars={context.calendars} sourceCalendars={context.calendars} tasks={context.tasks} sourceTasks={context.tasks} calendarsResolved tasksResolved
      settings={context.settings} editableCalendarIds={editableCalendarIds} offline={context.offline} createRequest={0} onCreateRequestHandled={() => {}}
      onCreate={async () => { throw new Error("Use the new task form to create tasks."); }} onUpdate={context.update}
      onRemove={async value => { if (!context.remove) throw new Error("Task cannot be deleted."); await context.remove(value); onOpenChange(false); }} /> : null}
    <ConfirmationDialog open={confirmDelete} onOpenChange={value => { if (!busy) setConfirmDelete(value); }} title={unlinkCalendarID ? "Remove task from calendar" : "Delete task"} description={unlinkCalendarID ? undefined : `“${task?.title ?? "This task"}” will be permanently deleted.`} closeLabel="Close delete task confirmation" confirmLabel={unlinkCalendarID ? "Remove from calendar" : "Delete task"} loading={busy} onConfirm={() => void remove()} />
  </>;
}
