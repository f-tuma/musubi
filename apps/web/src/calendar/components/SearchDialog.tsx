import { providerFlavor, type Calendar, type Event, type Task } from "@musubi/types";
import { ArrowRight, CalendarDays, CheckSquare, Search, Users } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Empty } from "~/components/ui/empty";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { RowAction } from "~/components/ui/row";
import { SectionLabel } from "~/components/ui/section-label";
import { Segmented } from "~/components/ui/segmented";
import { SHORTCUT_GROUPS } from "../shortcuts";
import { AccountMark } from "./ProviderIcon";
import { offeredViews, type CalendarViewId } from "../view-registry";

export type SearchAccountData = { events: Event[]; tasks: Task[]; calendars: Calendar[] };
export type SearchAccountSource = {
  data?: SearchAccountData;
  loading: boolean;
  error: boolean;
  retry: () => void;
};
const dateLabel = (date: Date | null | undefined) => date ? date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }) : "No date";
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
const filters = [{ label: "All", value: "all" }, { label: "Events", value: "events" }, { label: "Tasks", value: "tasks" }] as const;

type SearchDialogProps = {
  activeView: CalendarViewId;
  canCreateEvents: boolean;
  canCreateTasks?: boolean;
  canCreateMeetings?: boolean;
  onCreateMeeting?: () => void;
  events: Event[];
  tasks?: Task[];
  calendars?: Calendar[];
  visibleCalendarIds?: string[];
  visibleEventIds?: string[];
  accountSource?: SearchAccountSource;
  inputRef: RefObject<HTMLInputElement | null>;
  onCreateEvent: () => void;
  onCreateTask?: () => void;
  onEventSelect: (event: Event) => void;
  onTaskSelect?: (task: Task) => void;
  onOpenChange: (open: boolean) => void;
  onToday: () => void;
  onViewChange: (view: CalendarViewId) => void;
  open: boolean;
  query: string;
  returnFocus: RefObject<HTMLElement | null>;
  setQuery: (query: string) => void;
};

export function SearchDialog({ activeView, canCreateEvents, canCreateTasks, canCreateMeetings, onCreateMeeting, events, tasks = [], calendars = [], visibleCalendarIds, visibleEventIds, accountSource, inputRef, onCreateEvent, onCreateTask, onEventSelect, onTaskSelect, onOpenChange, onToday, onViewChange, open, query, returnFocus, setQuery }: SearchDialogProps) {
  const account = accountSource?.data;
  const loading = accountSource?.loading ?? false;
  const error = accountSource?.error ?? false;
  const [filter, setFilter] = useState("all");
  const [active, setActive] = useState(0);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setActive(0);
  }
  const [limit, setLimit] = useState(40);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const normalized = normalize(query.trim());
  const calendarMap = new Map((account?.calendars ?? calendars).map(calendar => [calendar.id, calendar]));
  const visible = new Set(visibleCalendarIds ?? calendars.map(calendar => calendar.id));
  const records = useMemo(() => [
    ...(account?.events ?? events).map(event => ({ key: `event:${event.id}`, kind: "events", title: event.title, text: [event.title, event.description, event.location].filter(Boolean).join(" "), calendars: event.calendars, date: event.start, event, task: undefined as Task | undefined })),
    ...(account?.tasks ?? tasks).map(task => ({ key: `task:${task.id}`, kind: "tasks", title: task.title, text: [task.title, task.description].filter(Boolean).join(" "), calendars: [task.calendarID], date: task.due ?? task.start, event: undefined as Event | undefined, task })),
  ], [account, events, tasks]);
  const visibleEvents = new Set(visibleEventIds ?? events.map(event => event.recurrence ? event.id.replace(/_\d+$/, "") : event.id));
  function section(record: typeof records[number]) {
    if (visibleCalendarIds && !record.calendars.some(id => visible.has(id))) return 3;
    if (record.event && visibleEvents.has(record.event.id)) return 0;
    if (record.task && activeView === "tasks") return 1;
    return 2;
  }
  const matches = normalized ? records.filter(record => (filter === "all" || filter === record.kind) && normalized.split(/\s+/).every(word => normalize(`${record.text} ${record.calendars.map(id => calendarMap.get(id)?.name ?? "").join(" ")}`).includes(word))).sort((a, b) => {
    const visibleDifference = section(a) - section(b);
    return visibleDifference || Number(normalize(b.title).startsWith(normalized)) - Number(normalize(a.title).startsWith(normalized)) || (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0) || a.key.localeCompare(b.key);
  }) : [];
  const shown = matches.slice(0, limit);
  const actions: { label: string; onSelect: () => void; shortcut?: string }[] = [
    ...(canCreateEvents ? [{ label: "New event", shortcut: SHORTCUT_GROUPS.flatMap(group => group.items).find(item => item.action === "New event")?.keys, onSelect: onCreateEvent }] : []),
    ...(canCreateMeetings && onCreateMeeting ? [{ label: "New meeting", onSelect: onCreateMeeting }] : []),
    ...(canCreateTasks && onCreateTask ? [{ label: "New task", onSelect: onCreateTask }] : []),
    { label: "Go to today", onSelect: onToday },
    ...offeredViews().filter(view => view.id !== activeView).map(view => ({ label: `Switch to ${view.label}`, shortcut: SHORTCUT_GROUPS.find(group => group.title === "Switch view")?.items.find(item => item.action === view.label)?.keys, onSelect: () => onViewChange(view.id as CalendarViewId) })),
  ];
  const resultCount = shown.length + actions.length;
  const selected = Math.min(active, Math.max(0, resultCount - 1));
  function run(action: () => void) { onOpenChange(false); action(); }
  function openRecord(record: typeof shown[number]) { run(() => record.event ? onEventSelect(record.event) : record.task && onTaskSelect?.(record.task)); }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Enter" && event.currentTarget.tagName === "INPUT") {
      event.preventDefault();
      const record = shown[selected];
      if (record) openRecord(record); else if (actions[selected - shown.length]) run(actions[selected - shown.length]!.onSelect);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp"].includes(event.key) || !resultCount) return;
    event.preventDefault();
    const inResults = selected < shown.length;
    const start = inResults ? 0 : shown.length;
    const count = inResults ? shown.length : actions.length;
    const row = selected - start;
    let next = selected;
    if (event.key === "ArrowRight") {
      if (inResults && actions.length) next = shown.length + Math.min(row, actions.length - 1);
    } else if (event.key === "ArrowLeft") {
      if (!inResults && shown.length) next = Math.min(row, shown.length - 1);
    } else {
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? 5 : -5;
      next = start + ((row + delta) % count + count) % count;
    }
    setActive(next);
    const target = listRef.current?.querySelectorAll<HTMLElement>("[data-search-result]")[next];
    target?.scrollIntoView?.({ block: "nearest" });
    if (event.currentTarget.tagName !== "INPUT") target?.focus();
  }
  function group(label: string, items: typeof shown) {
    if (!items.length) return null;
    return <section aria-label={label} className="grid gap-1">
      <SectionLabel className="mb-2">{label}<span className="ml-2">{items.length}</span></SectionLabel>
      {items.map(record => {
        const index = shown.indexOf(record);
        const calendar = record.calendars.map(id => calendarMap.get(id)).find(calendar => calendar && visible.has(calendar.id)) ?? calendarMap.get(record.calendars[0] ?? "");
        return <div key={record.key} className="overflow-hidden rounded-control has-data-active:bg-raised">
          <RowAction id={`${id}-${index}`} data-search-result data-active={selected === index || undefined}
            icon={<AccountMark size="compact" flavor={calendar ? providerFlavor(calendar) : null} color={calendar?.color} />}
            label={record.title} showChevron={false}
            detail={`${record.event ? "Event" : "Task"} · ${dateLabel(record.date)}${record.task ? ` · ${record.task.status.replace("in-process", "in progress").replace("needs-action", "needs action")}` : ""}`}
            trailing={<span className="block max-w-32 truncate text-12 text-muted-foreground max-sm:max-w-20">{calendar?.name ?? "Calendar"}</span>}
            onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)} onClick={() => openRecord(record)} />
        </div>;
      })}
    </section>;
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="wide" tall aria-describedby={undefined} closeLabel="Close search" initialFocus={inputRef} returnFocus={returnFocus}>
      <DialogHeader>
        <div className="flex items-center gap-1">
          <DialogTitle>Search Musubi</DialogTitle>
          <HelpTooltip label="About search">Events and tasks on this server, across all your calendars and dates. The current view comes first; recurring events appear as their series. ↑ ↓ move, ← → switch columns, Enter opens.</HelpTooltip>
        </div>
      </DialogHeader>
      <DialogBody>
        <div className="flex items-center gap-4 max-sm:flex-col max-sm:items-stretch">
          <InputGroup>
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput aria-label="Search events and actions" placeholder="Events, tasks, calendars" ref={inputRef} type="search" value={query}
              aria-describedby={`${id}-status`} onChange={event => { setQuery(event.target.value); setActive(0); setLimit(40); }} onKeyDown={keyboard} />
          </InputGroup>
          <Segmented className="flex-none sm:w-64" label="Search type" value={filter} options={filters} onChange={value => { setFilter(value); setActive(0); setLimit(40); }} />
        </div>
        <p className="-mt-2 min-h-4 text-12 text-muted-foreground" role="status" id={`${id}-status`}>{loading ? "Searching…" : normalized ? `${matches.length} ${matches.length === 1 ? "result" : "results"}` : ""}</p>
        {error ? (
          <InlineError actions={<Button size="compact" variant="ghost" onClick={accountSource?.retry}>Retry</Button>}>
            Account search could not load. Showing loaded data.
          </InlineError>
        ) : null}
        <span className="sr-only" aria-live="polite">{shown[selected]?.title ?? actions[selected - shown.length]?.label}</span>
        <div className="grid gap-5 sm:grid-cols-3" ref={listRef} onKeyDown={keyboard}>
          <div className="flex min-w-0 flex-col gap-5 sm:col-span-2">
            {group("Visible events", shown.filter(record => section(record) === 0))}
            {group("Visible tasks", shown.filter(record => section(record) === 1))}
            {group("Outside current range", shown.filter(record => section(record) === 2))}
            {group("Elsewhere in your account", shown.filter(record => section(record) === 3))}
            {!normalized ? <Empty icon={<Search />} title="Find events and tasks" /> : !shown.length ? <Empty title={loading ? "Looking for matches…" : "No matches"} /> : null}
            {matches.length > limit ? <Button className="self-start" variant="ghost" onClick={() => setLimit(value => value + 40)}>Show {matches.length - limit} more</Button> : null}
          </div>
          <aside className="grid min-w-0 content-start gap-1 max-sm:border-t max-sm:border-border-subtle max-sm:pt-4 sm:border-l sm:border-border-subtle sm:pl-5" aria-label="Actions">
            <SectionLabel className="mb-2">Actions</SectionLabel>
            {actions.map((action, index) => <div key={action.label} className="overflow-hidden rounded-control has-data-active:bg-raised">
              <RowAction id={`${id}-${shown.length + index}`} data-search-result data-active={selected === shown.length + index || undefined} label={action.label} showChevron={false}
                icon={action.label === "New meeting" ? <Users /> : action.label === "New task" ? <CheckSquare /> : action.label === "New event" ? <CalendarDays /> : <ArrowRight />}
                trailing={action.shortcut ? <Kbd>{action.shortcut}</Kbd> : undefined} onFocus={() => setActive(shown.length + index)} onMouseEnter={() => setActive(shown.length + index)} onClick={() => run(action.onSelect)} />
            </div>)}
          </aside>
        </div>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
