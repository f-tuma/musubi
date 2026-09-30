import { DateFormatContext } from "~/components/ui/date-picker";
import { applyTheme } from "~/design/theme";
import { pageItemTypes, eventItemType } from "../page-item-filters";
import { calendarTasks, isCalendarTask } from "@musubi/calendar";
import { CalendarTaskContext, TaskDetails } from "./CalendarTaskDetails";
import { eventDayKeys, getMonthGrid } from "@musubi/calendar/layout";
import { getTimeGridDays } from "../time-grid-math";
import { getAgendaGroups } from "../agenda-math";
import { TaskLayoutSwitch } from "./TaskLayoutSwitch";
import { useGridAvailability } from "../use-grid-availability";
import { type EventScopeRequest, editedEvent, EventMutationError } from "@musubi/types";
import type {
  Calendar,
  CreatePageRequest,
  Event,
  PageConfigV1,
  PageDocument,
  PageIcon,
  Settings,
  SettingsDocument,
  SettingsPatch,
  Task,
  TaskCreate,
  TaskUpdate,
  User,
} from "@musubi/types";
import {
  calendarCoverageNotice,
  seriesEditWrites,
  withSeriesEditIntent,
  type EditScope,
} from "@musubi/calendar";
import type {
  Attendee,
  ImportedCalendar,
  RemoveEventResponse,
} from "~/api/contracts";
import {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { describeAge, StaleBanner, UpdateBanner, CoverageBanner } from "~/components/ui/banner";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Toast, type ToastTone } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import {
  DEFAULT_MULTI_WEEK_WEEKS,
  multiWeekDays,
  viewDefinition,
} from "../view-registry";
import { getEventDateLabel, getEventRangeLabel, parseDateKey } from "../calendar-math";
import { toDateKey } from "../date-key";
import { eventFormValues, type EventFormValues } from "../event-form";
import {
  canEditEvent,
  getEditableCalendars,
  getEditableTaskCalendars,
} from "../event-permissions";
import type { Notify } from "../notice";
import type { ReminderControl } from "../reminder-control";

import type { AttendanceChoice } from "../attendance";
import { shortcutFor } from "../shortcuts";
import { useWheelPeriod } from "../use-wheel-period";
import { useSwipePeriod } from "../use-swipe-period";
import { useNarrowViewport } from "~/design/use-narrow-viewport";
import { createTimeGeometry, densityFromPageConfig } from "../time-geometry";
import {
  calendarIdsForVisibility,
  newPageConfig,
  pageConfigEquals,
  viewConfigFor,
  type SavePageResult,
} from "../page-editor";
import type { CalendarViewId } from "../view-registry";
import { AgendaView } from "./AgendaView";
import { ProviderMeetingCreateDialog, isMeetingCalendarCandidate } from "./ProviderMeetingCreateDialog";
import { MonthCalendar } from "./MonthCalendar";
import { MultiWeekCalendar } from "./MultiWeekCalendar";
import { NewPageDialog, PageSettingsDialog } from "./PageSettingsDialog";
import { requestInspectorTransition } from "~/components/ui/inspector";
import { QuickCreate, type QuickCreateAnchor } from "./QuickCreate";
import { RecurrenceScopeDialog } from "./RecurrenceScopeDialog";
import { SearchDialog, type SearchAccountSource } from "./SearchDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { ShareCalendarDialog } from "./ShareCalendarDialog";
import { Sidebar } from "./Sidebar";
import { SettingsWindow, type SettingsSectionId } from "./settings/SettingsWindow";
import { TimeGridView } from "./TimeGridView";
import { TaskList } from "./TaskList";
import { Toolbar } from "./Toolbar";

const TOAST_ACKNOWLEDGEMENT_MS = 3_500;
const TOAST_UNDO_MS = 9_000;

type WorkspaceProps = {
  activeView: CalendarViewId;
  taskLayout?: "list" | "kanban";
  onTaskLayoutChange?: (layout: "list" | "kanban") => void;
  baseEvents?: Event[];
  calendars: Calendar[];
  date: string;
  events: Event[];
  /** Whether this signed-in account may write announcements on this server. */
  isAdmin?: boolean;
  isRefreshing: boolean;
  /**
   * The server could not be reached, so what is on screen came from the local
   * snapshot. `snapshotAt` is when that snapshot was written.
   */
  /** Set when the server has moved past the bundle this tab is running. */
  newerServer?: { reload: () => void } | null;
  offline?: boolean;
  snapshotAt?: number;
  /** On screen is snapshot data while a refresh is in flight (`05:295-306`). */
  stale?: boolean;
  onCreateEvent: (event: Event) => Promise<Event>;
  onCreateTask?: (task: TaskCreate) => Promise<Task>;
  onUpdateTask?: (id: string, task: TaskUpdate) => Promise<Task>;
  onRemoveTask?: (task: Task) => Promise<void>;
  tasks?: Task[];
  tasksResolved?: boolean;
  calendarsResolved?: boolean;
  onDateChange: (date: string) => void;
  onForkEvent?: (input: {
    calendarId: string;
    eventId: string;
  }) => Promise<Event>;
  onLinkEvent?: (input: {
    calendarId: string;
    eventId: string;
  }) => Promise<Event>;
  onPageChange: (pageId: string, view: CalendarViewId) => void;
  onCreatePage?: (request: CreatePageRequest) => Promise<PageDocument>;
  onDeletePage?: (id: string) => Promise<unknown>;
  onReorderPages?: (pageIds: string[]) => Promise<unknown>;
  onSetDefaultPage?: (id: string) => Promise<unknown>;
  onSavePage?: (input: {
    baseRevision: number;
    config: PageConfigV1;
    id: string;
    name: string;
  }) => Promise<SavePageResult>;
  /** Production owns drafts above route loading/redirect gates. */
  taskCreateRequest?: number;
  onTaskCreateRequestChange?: Dispatch<SetStateAction<number>>;
  pageDrafts?: Map<string, PageWorkingDraft>;
  onPageDraftsChange?: Dispatch<SetStateAction<Map<string, PageWorkingDraft>>>;
  onExportCalendar?: (
    calendarId: string,
    connectionId?: string,
  ) => Promise<string>;
  onImportCalendar?: (input: {
    color: string;
    ics: string;
    name: string;
  }) => Promise<ImportedCalendar>;
  onCreateCalendar?: (input: {
    color: string;
    name: string;
  }) => Promise<Calendar>;
  onDisconnectExternalCalendar?: (calendar: Calendar) => Promise<unknown>;
  onUpdateCalendar?: (calendar: Calendar) => Promise<Calendar>;
  onRemoveCalendar?: (calendar: Calendar) => Promise<Calendar>;
  onAdoptSettings?: (document: SettingsDocument) => void;
  onGetSettingsDocument?: (signal?: AbortSignal) => Promise<SettingsDocument>;
  onPatchSettings?: (request: {
    baseRevision: number;
    patch: SettingsPatch;
  }) => Promise<SettingsDocument>;
  onRemoveEvent: (event: Event) => Promise<RemoveEventResponse>;
  onSetAttendance?: (input: {
    // Identifies the owning calendar so a federated event is routed to its
    // server instead of the home one.
    calendarId?: string;
    eventId: string;
    status: AttendanceChoice;
  }) => Promise<Attendee[]>;
  /** Reminder rules plus the writer for them; absent hides the control. */
  reminders?: ReminderControl;
  /**
   * Open the full editor for a draft. An event identifies an update; without
   * one it is a new event. Absent keeps the compact form expanding in place,
   * which is what router-less embeddings use.
   */
  onOpenFullEditor?: (values: EventFormValues, event?: Event) => void;
  searchAccount?: SearchAccountSource;
  onSearchActiveChange?: (active: boolean) => void;
  onStepPeriod?: (offset: number, weeks: number) => void;
  onSignOut: () => void;
  /** State of a provider link that finished while the browser was away. */
  providerLink?: {
    error?: string;
    importing: boolean;
    linked: boolean;
  };
  onApplyEventScope?: (event: Event, request: EventScopeRequest) => Promise<unknown>;
  onUpdateEvent: (event: Event) => Promise<Event>;
  onViewChange: (view: CalendarViewId) => void;
  pageId: string;
  pages: PageDocument[];
  settings: Settings;
  user: Pick<User, "email" | "id" | "image" | "name">;
};

export type PageWorkingDraft = {
  config: PageConfigV1;
  conflict: boolean;
  persisted: PageDocument;
};

type CreateIntent = {
  exactRange?: { start: Date; end: Date };
  anchor: QuickCreateAnchor;
  /** The chosen calendar's colour, so the draft block wears it too. */
  color?: string;
  date: string;
  /** Set when days were dragged across in the month grid: an all-day range. */
  endDate?: string;
  /** Set when the interval was dragged, so the length carries over. */
  endTime?: string;
  id: number;
  startTime?: string;
};

const unavailableTargetMutation = async (): Promise<Event> => {
  throw new Error("This event action is unavailable.");
};

const unavailableAttendance = async (): Promise<Attendee[]> => {
  throw new Error("Attendance is unavailable.");
};

const unavailableExport = async (): Promise<string> => {
  throw new Error("Calendar export is unavailable.");
};

const unavailableImport = async (): Promise<ImportedCalendar> => {
  throw new Error("Calendar import is unavailable.");
};

const unavailableCalendarWrite = async (): Promise<Calendar> => {
  throw new Error("Calendar management is unavailable.");
};

const unavailableCalendarDisconnect = async (): Promise<void> => {
  throw new Error("External calendar disconnect is unavailable.");
};

const unavailableSettings = async (): Promise<SettingsDocument> => {
  throw new Error("Settings sync is unavailable.");
};

const unavailablePageSave = async (): Promise<SavePageResult> => {
  throw new Error("Page editing is unavailable.");
};

const unavailablePageCreate = async (): Promise<PageDocument> => {
  throw new Error("Page creation is unavailable.");
};

const unavailablePageDelete = async (): Promise<void> => {
  throw new Error("Page deletion is unavailable.");
};

const unavailablePageReorder = async (): Promise<void> => {
  throw new Error("Page reordering is unavailable.");
};

const unavailablePageDefault = async (): Promise<void> => {
  throw new Error("Changing the default Page is unavailable.");
};

const ignoreSettings = () => undefined;
const unavailableTaskWrite = async () => {
  throw new Error("Task updates are unavailable.");
};

export function Workspace({
  activeView,
  taskLayout,
  onTaskLayoutChange,
  baseEvents,
  calendars,
  date,
  events,
  isAdmin = false,
  isRefreshing,
  newerServer,
  offline = false,
  snapshotAt,
  stale = false,
  onCreateEvent,
  onCreateTask = unavailableTaskWrite,
  onUpdateTask = unavailableTaskWrite,
  onRemoveTask = unavailableTaskWrite,
  tasks = [],
  tasksResolved = false,
  calendarsResolved = false,
  onAdoptSettings = ignoreSettings,
  onDateChange,
  onExportCalendar = unavailableExport,
  onForkEvent = unavailableTargetMutation,
  onLinkEvent = unavailableTargetMutation,
  onImportCalendar = unavailableImport,
  onCreateCalendar = unavailableCalendarWrite,
  onDisconnectExternalCalendar = unavailableCalendarDisconnect,
  onUpdateCalendar = unavailableCalendarWrite,
  onRemoveCalendar = unavailableCalendarWrite,
  onGetSettingsDocument = unavailableSettings,
  onCreatePage = unavailablePageCreate,
  onDeletePage = unavailablePageDelete,
  onPageChange,
  onReorderPages = unavailablePageReorder,
  onSetDefaultPage = unavailablePageDefault,
  onPatchSettings = unavailableSettings,
  onSavePage = unavailablePageSave,
  taskCreateRequest: controlledTaskCreateRequest,
  onTaskCreateRequestChange,
  pageDrafts: controlledPageDrafts,
  onPageDraftsChange,
  onRemoveEvent,
  onOpenFullEditor,
  onSetAttendance = unavailableAttendance,
  reminders,
  onSignOut,
  searchAccount,
  onSearchActiveChange,
  onStepPeriod,
  providerLink,
  onUpdateEvent,
  onApplyEventScope,
  onViewChange,
  pageId,
  pages,
  settings,
  user,
}: WorkspaceProps) {
  const anchor = useMemo(() => parseDateKey(date), [date]);
  const wheelPeriodRef = useWheelPeriod(activeView === "month", offset => changePeriod(offset));
  const swipePeriod = useSwipePeriod((offset) => changePeriod(offset));
  // Phone chrome has less room for a date label than it has date to spell out.
  const narrow = useNarrowViewport();
  // Direct renders (tests/stories) can own drafts locally. The route passes the
  // production state so data gates and canonical redirects cannot erase it.
  const [localTaskLayout, setLocalTaskLayout] = useState<"list" | "kanban">("list");
  const [localPageDrafts, setLocalPageDrafts] = useState<
    Map<string, PageWorkingDraft>
  >(() => new Map());
  const pageDrafts = controlledPageDrafts ?? localPageDrafts;
  const setPageDrafts = onPageDraftsChange ?? setLocalPageDrafts;
  const [savingPageId, setSavingPageId] = useState<string>();
  const [discardPageDraftOpen, setDiscardPageDraftOpen] = useState(false);
  const discardPageDraftButtonRef = useRef<HTMLButtonElement>(null);
  // The page whose settings dialog is open. Any page in the sidebar, not just
  // the active one.
  const [settingsPage, setSettingsPage] = useState<PageDocument>();
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [meetingCreate, setMeetingCreate] = useState<{
    initialCalendarID?: string;
    returnFocus: HTMLElement;
  }>();
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarModal, setSidebarModal] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const [notice, setNotice] = useState<{
    message: string;
    tone: ToastTone;
    undo?: () => Promise<unknown> | void;
  }>();
  const notify = useCallback<Notify>(
    (message, options) =>
      setNotice({
        message,
        tone: options?.tone ?? "neutral",
        undo: options?.undo,
      }),
    [],
  );

  async function runUndo(undo: NonNullable<typeof notice>["undo"]) {
    // Take the offer away first: the toast is gone either way, and a second
    // click would replay the reversal.
    setNotice(undefined);
    try {
      await undo?.();
      notify("Change undone.");
    } catch {
      notify(
        // The undo is what failed, so the change it was reversing is still in
        // place — saying only "could not be undone" leaves that ambiguous.
        "That change could not be undone and is still applied. Try again.",
        { tone: "error" },
      );
    }
  }

  function askScope(occurrence: Event, start: Date, end: Date) {
    // Captured before the dialog steals focus, so Alt+arrow keyboard editing
    // lands back on the event block it started from.
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    return new Promise<EditScope | undefined>((resolve) => {
      setScopeRequest({
        resolve: (scope) => {
          setScopeRequest(undefined);
          resolve(scope);
        },
        returnFocus,
        timeLabel: getEventRangeLabel(
          { ...occurrence, end, start },
          settings.timeFormat,
        ),
        title: occurrence.title,
      });
    });
  }

  /**
   * Write a new time for an event, whatever gesture produced it. A series first
   * asks which occurrences it applies to; dismissing that writes nothing, and
   * the block is already back where it was.
   */
  async function commitEventTimes({
    end,
    event,
    start,
  }: {
    end: Date;
    event: Event;
    start: Date;
  }) {
    const master = getEventMaster(event);
    let scope: EditScope = "series";

    if (master.recurrence) {
      const chosen = await askScope(event, start, end);
      if (!chosen) return;
      scope = chosen;
    }

    const created: Event[] = [];
    const { creates, updates } = withSeriesEditIntent(
      seriesEditWrites({
        edited: { ...event, end, start },
        master,
        occurrence: event,
        scope,
      }),
    );

    let savedMaster: Event | undefined;

    setBusyEventId(master.id);
    try {
      // Sequential: the update carries the exclusion that keeps the created
      // event from briefly showing twice.
      for (const update of updates) {
        savedMaster = await onUpdateEvent(update);
      }
      for (const create of creates) {
        created.push(await onCreateEvent(create));
      }
    } catch (error) {
      if (savedMaster)
        throw new EventMutationError(
          "Part of this recurring edit was saved. Later delivery was not confirmed. Refresh and reconcile before retrying.",
          true,
        );
      throw error;
    } finally {
      setBusyEventId(undefined);
    }

    notify(
      start.getTime() === event.start.getTime()
        ? "Event resized."
        : "Event moved.",
      {
        undo: async () => {
          for (const event of created) {
            await onRemoveEvent(event);
          }
          await onUpdateEvent(
            withSeriesEditIntent({
              updates: [editedEvent(savedMaster!, master)],
              creates: [],
            }).updates[0],
          );
        },
      },
    );
  }
  const [createIntent, setCreateIntent] = useState<CreateIntent>();
  const createSaving = useRef(false);
  const [localTaskCreateRequest, setLocalTaskCreateRequest] = useState(0);
  useEffect(() => { applyTheme(settings.theme); }, [settings.theme]);
  const [searchTaskId, setSearchTaskId] = useState<string>();
  const taskReturnFocus = useRef<HTMLElement | null>(null);
  const [searchDetailId, setSearchDetailId] = useState<string>();
  const searchDetail = (searchAccount?.data?.events ?? events).find(event => event.id === searchDetailId);
  useEffect(() => {
    onSearchActiveChange?.(searchOpen || !!searchTaskId || !!searchDetailId);
  }, [searchOpen, searchTaskId, searchDetailId, onSearchActiveChange]);
  const taskCreateRequest = controlledTaskCreateRequest ?? localTaskCreateRequest;
  const setTaskCreateRequest = onTaskCreateRequestChange ?? setLocalTaskCreateRequest;
  const consumeTaskCreateRequest = useCallback(
    () => setTaskCreateRequest(0),
    [setTaskCreateRequest],
  );
  const [scopeRequest, setScopeRequest] = useState<{
    resolve: (scope: EditScope | undefined) => void;
    returnFocus: HTMLElement | null;
    timeLabel: string;
    title: string;
  }>();
  const [shareCalendar, setShareCalendar] = useState<Calendar | null>(null);
  // One settings window; the section says which entry point opened it.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  const [connectionsReturnFocus, setConnectionsReturnFocus] = useState<HTMLElement | null>(null);
  // Coming back from a provider's consent screen, the dialog that started the
  // link is long gone — so it reopens itself onto the freshly imported account.
  // Derived rather than set in an effect, and dismissible like any other close.
  const [linkNoticeDismissed, setLinkNoticeDismissed] = useState(false);
  const activeSettingsSection: SettingsSectionId | null =
    settingsSection ?? (providerLink?.linked && !linkNoticeDismissed ? "connections" : null);
  const showConnections = activeSettingsSection === "connections";
  // Kept after closing until the next opening replaces it: the dialog hands
  // focus back once its exit animation ends, after this state has moved on.
  function openSettings(section: SettingsSectionId, returnFocus: HTMLElement | null = null) {
    setConnectionsReturnFocus(returnFocus);
    setSettingsSection(section);
  }
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The event a time write is in flight for. One gesture at a time, so one id.
  const [busyEventId, setBusyEventId] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const editableCalendars = useMemo(
    () => getEditableCalendars(calendars),
    [calendars],
  );
  const editableTaskCalendars = useMemo(
    () => getEditableTaskCalendars(calendars),
    [calendars],
  );
  const sourceEvents = baseEvents ?? events;
  const eventMasters = useMemo(() => {
    const masters = new Map(
      sourceEvents.map((baseEvent) => [baseEvent.id, baseEvent]),
    );
    const recurring = sourceEvents.filter((baseEvent) => baseEvent.recurrence);

    for (const visibleEvent of events) {
      if (masters.has(visibleEvent.id)) continue;
      const master = recurring.find((baseEvent) =>
        visibleEvent.id.startsWith(`${baseEvent.id}_`),
      );
      if (master) masters.set(visibleEvent.id, master);
    }

    return masters;
  }, [sourceEvents, events]);
  const getEventMaster = useCallback(
    (event: Event) => eventMasters.get(event.seriesID ?? event.id) ?? event,
    [eventMasters],
  );

  useEffect(() => {
    const pageIds = new Set(pages.map((page) => page.id));
    setPageDrafts((current) => {
      if ([...current.keys()].every((id) => pageIds.has(id))) return current;
      return new Map([...current].filter(([id]) => pageIds.has(id)));
    });
  }, [pages, setPageDrafts]);

  const activePage = useMemo(
    () => pages.find((page) => page.id === pageId) ?? pages[0],
    [pages, pageId],
  );
  const activeDraft = pageDrafts.get(activePage.id);
  const workingConfig = activeDraft?.config ?? activePage.config;
  const activeDraftConflict = Boolean(
    activeDraft &&
      (activeDraft.conflict ||
        activePage.revision !== activeDraft.persisted.revision),
  );

  const visibleCalendarIds = useMemo(
    () => calendarIdsForVisibility(workingConfig.calendarVisibility, calendars),
    [calendars, workingConfig.calendarVisibility],
  );
  const coverageNotice = calendarCoverageNotice(calendars.filter(calendar => visibleCalendarIds.includes(calendar.id)));

  // Density lives in the Page config, so "this page shows time grids compactly"
  // is saved with the page rather than being a device preference.
  const geometry = useMemo(
    () => createTimeGeometry(densityFromPageConfig(workingConfig)),
    [workingConfig],
  );

  const presentationView = viewConfigFor(workingConfig, activeView);
  const showWeekend =
    "weekend" in presentationView ? presentationView.weekend : true;
  const gridAvailability = useGridAvailability({ userId: user.id, pageId: activePage.id, anchor, view: activeView, weekStartsOn: settings.weekStartsOn, showWeekend, offline, listOpen: showConnections });
  const showAdjacentDays =
    "showAdjacentDays" in presentationView
      ? presentationView.showAdjacentDays
      : true;
  // How many weeks a multi-week page shows. Read from the Page rather than from
  // settings: a planning page wants eight, a "this fortnight" page wants two.
  const weeks =
    "weeks" in presentationView
      ? presentationView.weeks
      : DEFAULT_MULTI_WEEK_WEEKS;
  const multiWeek = activeView === "multi-week";
  // Whole weeks, split into blocks. The matrix decides how they are arranged.
  const multiWeekBlocks = useMemo(() => {
    if (!multiWeek) return [];
    const days = multiWeekDays(anchor, settings.weekStartsOn, weeks);

    return Array.from({ length: days.length / 7 }, (_, index) =>
      days.slice(index * 7, index * 7 + 7),
    );
  }, [anchor, multiWeek, settings.weekStartsOn, weeks]);

  const pageTitle = activePage.name;

  const itemTypes = pageItemTypes(workingConfig.filters);
  const visibleTasks = tasks.filter(task => itemTypes.includes("tasks") && visibleCalendarIds.includes(task.calendarID));
  const visibleEvents = useMemo(
    () =>
      [...events, ...calendarTasks(tasks, calendars)].filter((event) =>
        itemTypes.includes(isCalendarTask(event) ? "tasks" : eventItemType(event)) &&
        event.calendars.some((calendarId) => visibleCalendarIds.includes(calendarId)),
      ),
    [events, tasks, calendars, visibleCalendarIds, itemTypes],
  );
  const searchVisibleEventIds = useMemo(() => {
    if (activeView === "tasks") return [];
    const days = activeView === "month"
      ? getMonthGrid(anchor, settings.weekStartsOn).filter(day => showAdjacentDays || day.getMonth() === anchor.getMonth())
      : activeView === "multi-week" ? multiWeekBlocks.flat()
      : activeView === "day" || activeView === "week" ? getTimeGridDays(anchor, activeView, settings.weekStartsOn, { includeWeekend: showWeekend }) : [];
    const dayKeys = new Set(days.map(toDateKey));
    const shown = activeView === "agenda" ? getAgendaGroups(visibleEvents, anchor).flatMap(group => group.items)
      : visibleEvents.filter(event => eventDayKeys(event).some(day => dayKeys.has(day)));
    return shown.filter(event => !isCalendarTask(event)).map(event => event.recurrence ? event.id.replace(/_\d+$/, "") : event.id);
  }, [activeView, anchor, settings.weekStartsOn, showAdjacentDays, showWeekend, multiWeekBlocks, visibleEvents]);
  useEffect(() => {
    if (!notice) {
      return;
    }

    // An offer to undo has to outlive a plain acknowledgement: it is only real
    // if it is still there when you notice the mistake.
    const timeout = window.setTimeout(
      () => setNotice(undefined),
      notice.undo ? TOAST_UNDO_MS : TOAST_ACKNOWLEDGEMENT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const view = viewDefinition(activeView);
  const periodLabel = view.title(anchor, {
    compact: narrow,
    weekStartsOn: settings.weekStartsOn,
    weeks,
  });

  function changePeriod(offset: number) {
    if (onStepPeriod) onStepPeriod(offset, weeks);
    else onDateChange(toDateKey(view.step(anchor, offset, { weeks })));
  }

  function removePageDraft(id: string, expected?: PageWorkingDraft) {
    setPageDrafts((current) => {
      if (!current.has(id) || (expected && current.get(id) !== expected)) {
        return current;
      }
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  function handleViewChange(nextView: CalendarViewId) {
    onViewChange(nextView);
  }

  function handlePageChange(nextPageId: string, createdView?: CalendarViewId) {
    const page = pages.find((candidate) => candidate.id === nextPageId);
    const view =
      createdView ??
      pageDrafts.get(nextPageId)?.config.view.id ??
      page?.config.view.id;
    if (view) onPageChange(nextPageId, view);
  }

  function discardActivePageDraft() {
    if (!activeDraft) return;
    setDiscardPageDraftOpen(false);
    removePageDraft(activePage.id);
    notify("Page changes discarded.");
  }

  async function saveActivePageDraft() {
    if (!activeDraft || activeDraftConflict || savingPageId || offline) return;
    setSavingPageId(activePage.id);
    try {
      const result = await onSavePage({
        baseRevision: activeDraft.persisted.revision,
        config: activeDraft.config,
        id: activePage.id,
        name: activeDraft.persisted.name,
      });
      if (result.status === "conflict") {
        setPageDrafts((current) => {
          const draft = current.get(activePage.id);
          if (!draft) return current;
          return new Map(current).set(activePage.id, {
            ...draft,
            conflict: true,
          });
        });
        notify("This Page changed elsewhere. Your draft is still here.", {
          tone: "error",
        });
        return;
      }

      setPageDrafts((current) => {
        const latest = current.get(activePage.id);
        if (!latest) return current;
        const next = new Map(current);
        if (
          latest === activeDraft ||
          pageConfigEquals(latest.config, result.page.config)
        ) {
          next.delete(activePage.id);
        } else {
          next.set(activePage.id, {
            config: latest.config,
            conflict: false,
            persisted: result.page,
          });
        }
        return next;
      });
      notify("Page saved.");
    } catch {
      notify(
        "This Page could not be saved. Your draft is still here — try again.",
        {
          tone: "error",
        },
      );
    } finally {
      setSavingPageId(undefined);
    }
  }

  async function saveActiveDraftAsCopy() {
    if (!activeDraft || savingPageId) return;
    const submittedDraft = activeDraft;
    setSavingPageId(activePage.id);
    try {
      const created = await onCreatePage({
        config: submittedDraft.config,
        name: `${submittedDraft.persisted.name} copy`,
      });
      removePageDraft(activePage.id, submittedDraft);
      notify("Saved as a new page.");
      onPageChange(created.id, created.config.view.id);
    } catch {
      notify("The new Page could not be created. Your draft is still here.", {
        tone: "error",
      });
    } finally {
      setSavingPageId(undefined);
    }
  }

  function openCreateAtDate(
    nextDate: string,
    target: HTMLElement,
    startTime?: string,
    {
      endDate,
      endTime,
      exactRange,
      point,
    }: {
      endDate?: string;
      endTime?: string;
      exactRange?: { start: Date; end: Date };
      point?: Pick<QuickCreateAnchor, "x" | "y">;
    } = {},
  ) {
    if (editableCalendars.length === 0) {
      notify("You need edit access to a calendar to create events.", {
        tone: "error",
      });
      return;
    }

    const bounds = target.getBoundingClientRect();
    requestInspectorTransition(() => setCreateIntent({
      anchor: {
        returnFocus: target,
        x: point?.x ?? bounds.right,
        y: point?.y ?? bounds.top,
      },
      date: nextDate,
      exactRange,
      endDate,
      endTime,
      id: Date.now(),
      startTime,
    }));
  }

  /**
   * Move the open draft to a new slot. The intent keeps its id, so the panel
   * is not remounted and a title already typed into it survives the drag.
   */
  function moveCreateDraft(when: {
    exactRange?: { start: Date; end: Date };
    color?: string;
    date: string;
    endDate?: string;
    endTime?: string;
    startTime?: string;
  }) {
    if (!createSaving.current) setCreateIntent((current) => current && { ...current, ...when });
  }

  function handleWorkspaceKeyDown(event: globalThis.KeyboardEvent) {
    const target = event.target;
    // An open layer owns the keyboard: a letter behind a dialog must not switch
    // the view under it, and a menu or a listbox spends letters on its own
    // type-ahead. Radix gives popovers and dialogs both role="dialog".
    if (
      target instanceof Element &&
      target.closest('[role="dialog"], [role="menu"], [role="listbox"]')
    ) {
      return;
    }

    const command = shortcutFor(event, {
      // Only a text field reads letters as text. A focused button used to count
      // as typing too, which killed every shortcut for as long as focus sat on
      // the last thing clicked — and a button answers to Space and Enter, neither
      // of which is a shortcut here, so there was nothing to protect.
      typing:
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable),
    });
    if (!command) {
      return;
    }

    // Every shortcut runs the same path as its control, so the two cannot drift.
    switch (command.kind) {
      case "create": {
        const main = mainRef.current;
        if (!main) return;
        event.preventDefault();
        const bounds = main.getBoundingClientRect();
        openCreateAtDate(date, main, undefined, {
          point: { x: bounds.left + bounds.width / 2, y: bounds.top + 92 },
        });
        return;
      }
      case "help":
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      case "next":
        event.preventDefault();
        changePeriod(1);
        return;
      case "previous":
        event.preventDefault();
        changePeriod(-1);
        return;
      case "save":
        if (!activeDraft) return;
        event.preventDefault();
        void saveActivePageDraft();
        return;
      case "search":
        event.preventDefault();
        setSearchOpen(true);
        return;
      case "view":
        event.preventDefault();
        handleViewChange(command.view);
        return;
    }
  }

  // Shortcuts listen on the window, not on the workspace element: an app-level
  // key has to work when nothing in particular is focused. The handler is read
  // through a ref so it always sees current state without re-registering.
  const keyHandlerRef = useRef(handleWorkspaceKeyDown);
  useEffect(() => {
    keyHandlerRef.current = handleWorkspaceKeyDown;
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) =>
      keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    if (pageDrafts.size === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pageDrafts.size]);

  /**
   * A new Page takes its name and icon from the dialog and everything else from
   * the state it was created in; its settings dialog owns the rest afterwards.
   * Errors surface in the dialog, which stays open, so the typed name survives.
   */
  async function createNewPage(input: { icon: PageIcon; name: string }) {
    const created = await onCreatePage({
      config: {
        ...newPageConfig(activeView, workingConfig.view, visibleCalendarIds),
        filters: workingConfig.filters,
        icon: input.icon,
      },
      name: input.name,
    });
    onPageChange(created.id, created.config.view.id);
  }

  return (
    <DateFormatContext.Provider value={settings.dateFormat}>
    <CalendarTaskContext.Provider value={{ tasks: searchAccount?.data?.tasks ?? tasks, calendars: searchAccount?.data?.calendars ?? calendars, settings, offline, update: onUpdateTask, remove: onRemoveTask }}>
    <div className="flex min-h-dvh cursor-default overflow-hidden bg-canvas select-none max-md:block" data-workspace="">
      <Sidebar
        activePageId={pageId}
        anchor={anchor}
        pages={pages}
        isOpen={sidebarOpen}
        onClose={closeSidebar}
        onCreatePage={() => setNewPageOpen(true)}
        onDateChange={(nextDate) => {
          onDateChange(nextDate);
          setSidebarOpen(false);
        }}
        onManageAccount={() => {
          setSidebarOpen(false);
          openSettings("account");
        }}
        onManageCalendars={() => {
          setSidebarOpen(false);
          openSettings("calendars");
        }}
        onManageConnections={() => {
          setSidebarOpen(false);
          openSettings("connections");
        }}
        onEditPage={(page) => {
          setSidebarOpen(false);
          if (savingPageId === page.id) return;
          const draft = pageDrafts.get(page.id);
          setSettingsPage(
            draft ? { ...draft.persisted, config: draft.config } : page,
          );
        }}
        onModalStateChange={setSidebarModal}
        onOpenSettings={() => {
          setSidebarOpen(false);
          openSettings("general");
        }}
        onPageChange={handlePageChange}
        onReorderPages={(pageIds) =>
          // Rethrown so the sidebar knows to stop showing the order it asked for.
          onReorderPages(pageIds).catch((error: unknown) => {
            notify(
              "That order could not be saved. The pages went back to the order they were in.",
              { tone: "error" },
            );
            throw error;
          })
        }
        onSignOut={onSignOut}
        returnFocusRef={sidebarTriggerRef}
        /* Short enough to fit the sidebar's slot on one line. The snapshot's age
           only appears while offline: that is the case where how old the data is
           changes what you do about it. */
        syncLabel={
          offline
            ? snapshotAt
              ? `Offline — saved ${describeAge(snapshotAt)}`
              : "Offline — server unreachable"
            : stale
              ? "Refreshing saved data…"
              : isRefreshing
                ? "Refreshing…"
                : "Connected to server"
        }
        syncTone={
          offline
            ? "offline"
            : stale || isRefreshing
              ? "refreshing"
              : "connected"
        }
        user={user}
        weekStartsOn={settings.weekStartsOn}
      />

      <main
        className="relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden"
        id="main-content"
        tabIndex={-1}
        inert={sidebarModal ? true : undefined}
        ref={mainRef}
      >
        {/* Offline is the one state worth a bar, and only where the sidebar is a
            drawer: a reader who cannot see the status would trust data that may
            be days old. Everything else lives in the sidebar. */}
        {offline && narrow ? (
          <StaleBanner
            savedAt={snapshotAt}
            suffix="Changes cannot be saved until it is back."
          />
        ) : null}
        {/* Not while offline: a reload with no network lands on nothing. */}
        {newerServer && !offline ? (
          <UpdateBanner onReload={newerServer.reload} />
        ) : null}
        <Toolbar
          taskLayoutControl={activeView === "tasks" ? <TaskLayoutSwitch value={taskLayout ?? localTaskLayout} onChange={next => { setLocalTaskLayout(next); onTaskLayoutChange?.(next); }} /> : undefined}
          activeView={activeView}
          availability={gridAvailability.available ? { shown: gridAvailability.shown, onToggle: gridAvailability.toggle, onOpenList: target => openSettings("connections", target) } : undefined}
          coverageNotice={activeView === "tasks" ? null : coverageNotice}
          canCreateEvents={editableCalendars.length > 0}
          canCreateMeetings={!offline && calendars.some(isMeetingCalendarCandidate)}
          canCreateTasks={!offline && editableTaskCalendars.length > 0}
          navigationTriggerRef={sidebarTriggerRef}
          onCreateEvent={(target) => openCreateAtDate(date, target)}
          onCreateMeeting={(returnFocus) => setMeetingCreate({ returnFocus })}
          onCreateTask={() => requestInspectorTransition(() => setTaskCreateRequest(request => request + 1))}
          onOpenSearch={() => setSearchOpen(true)}
          onPeriodChange={changePeriod}
          onOpenSidebar={() => setSidebarOpen(true)}
          onToday={() => onDateChange(toDateKey(new Date()))}
          onViewChange={handleViewChange}
          pageTitle={pageTitle}
          periodLabel={periodLabel}
          periodNavigation={activeView !== "agenda" && activeView !== "tasks"}
          periodName={activeView === "agenda" ? "agenda start" : activeView}
          searchTriggerRef={searchTriggerRef}
        />

        {activeDraft ? (
          <section
            aria-label="Unsaved Page changes"
            className="z-10 flex min-h-12 flex-none items-center justify-between gap-3 border-b border-border-subtle bg-panel px-3.5 py-2 data-[conflict]:bg-shu/10 max-sm:items-start md:px-7"
            data-conflict={activeDraftConflict ? "" : undefined}
          >
            <p className="text-12 text-foreground-secondary max-sm:pt-2">
              {activeDraftConflict
                ? "This Page changed elsewhere. Save your draft as a copy or discard it."
                : "Unsaved Page changes"}
            </p>
            <div className="flex flex-none gap-2">
              <Button
                disabled={savingPageId === activePage.id}
                ref={discardPageDraftButtonRef}
                size="compact"
                variant="secondary"
                onClick={() => setDiscardPageDraftOpen(true)}
              >
                Discard
              </Button>
              {activeDraftConflict ? (
                <Button
                  loading={savingPageId === activePage.id}
                  size="compact"
                  onClick={() => void saveActiveDraftAsCopy()}
                >
                  Save as a copy
                </Button>
              ) : (
                <Button
                  disabled={offline}
                  loading={savingPageId === activePage.id}
                  size="compact"
                  onClick={() => void saveActivePageDraft()}
                >
                  Save
                </Button>
              )}
            </div>
          </section>
        ) : null}

        {gridAvailability.notice ? <CoverageBanner message={gridAvailability.notice} /> : null}
        <div
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-auto bg-canvas select-none max-sm:pb-20",
            activeView === "month" && "overflow-hidden overscroll-none",
          )}
          ref={wheelPeriodRef}
          data-calendar-area=""
          // Flick sideways to move a period, like the native client's pager.
          // Agenda is one continuous list, so it has no period to page.
          onPointerDown={view.swipeable ? swipePeriod.onPointerDown : undefined}
        >
            <TaskList
              editorOnly={activeView !== "tasks"}
              showLayoutControl={false}
              layout={taskLayout ?? localTaskLayout}
              onLayoutChange={onTaskLayoutChange}
              sourceTasks={tasks}
              sourceCalendars={calendars}
              calendarsResolved={calendarsResolved}
              tasksResolved={tasksResolved}
              calendars={calendars.filter(
                (calendar) =>
                  calendar.supportsTasks !== false &&
                  visibleCalendarIds.includes(calendar.id),
              )}
              createRequest={taskCreateRequest}
              editableCalendarIds={
                new Set(
                  offline
                    ? []
                    : editableTaskCalendars.map((calendar) => calendar.id),
                )
              }
              offline={offline}
              onCreateRequestHandled={consumeTaskCreateRequest}
              settings={settings}
              tasks={visibleTasks}
              onCreate={onCreateTask}
              onOpenTask={task => { taskReturnFocus.current = document.activeElement as HTMLElement; requestInspectorTransition(() => setSearchTaskId(task.id)); }}
              onRemove={onRemoveTask}
              onUpdate={onUpdateTask}
            />
          {activeView === "tasks" ? null : activeView === "agenda" ? (
            <AgendaView
              anchor={anchor}
              calendars={calendars}
              events={visibleEvents}
              getEventMaster={getEventMaster}
              onForkEvent={onForkEvent}
              onLinkEvent={onLinkEvent}
              onNotice={notify}
              onOpenFullEditor={onOpenFullEditor}
              onRemoveEvent={onRemoveEvent}
              onRestoreEvent={onCreateEvent}
              onSetAttendance={onSetAttendance}
              reminders={reminders}
              onUpdateEvent={onUpdateEvent}
              onApplyEventScope={onApplyEventScope}
              timeFormat={settings.timeFormat}
              user={user}
              weekStartsOn={settings.weekStartsOn}
            />
          ) : activeView === "day" || activeView === "week" ? (
            <TimeGridView
              availabilityIntervals={gridAvailability.intervals}
              anchor={anchor}
              busyEventId={busyEventId}
              calendars={calendars}
              events={visibleEvents}
              geometry={geometry}
              pendingCreate={
                createIntent
                  ? {
                      color: createIntent.color,
                      date: createIntent.date,
                      exactRange: createIntent.exactRange,
                      endTime: createIntent.endTime,
                      startTime: createIntent.startTime,
                    }
                  : undefined
              }
              // The grid already shows the new position; this confirms it. A
              // rejection propagates so the drag reports it and the block snaps
              // back to the server's truth.
              onMoveDraft={moveCreateDraft}
              onMoveEvent={commitEventTimes}
              showWeekend={showWeekend}
              getEventMaster={getEventMaster}
              onForkEvent={onForkEvent}
              onLinkEvent={onLinkEvent}
              onCreateAtTime={
                editableCalendars.length > 0
                  ? (nextDate, time, createAnchor, endTime, exactRange) =>
                      openCreateAtDate(
                        nextDate,
                        createAnchor.returnFocus,
                        time,
                        { endTime, exactRange, point: createAnchor },
                      )
                  : undefined
              }
              onNotice={notify}
              onOpenFullEditor={onOpenFullEditor}
              onRemoveEvent={onRemoveEvent}
              onRestoreEvent={onCreateEvent}
              onSetAttendance={onSetAttendance}
              reminders={reminders}
              onUpdateEvent={onUpdateEvent}
              onApplyEventScope={onApplyEventScope}
              timeFormat={settings.timeFormat}
              user={user}
              view={activeView}
              weekStartsOn={settings.weekStartsOn}
            />
          ) : multiWeek ? (
            <MultiWeekCalendar
              busyEventId={busyEventId}
              calendars={calendars}
              events={visibleEvents}
              getEventMaster={getEventMaster}
              onForkEvent={onForkEvent}
              onLinkEvent={onLinkEvent}
              onNotice={notify}
              onOpenFullEditor={onOpenFullEditor}
              onRemoveEvent={onRemoveEvent}
              onRestoreEvent={onCreateEvent}
              onSetAttendance={onSetAttendance}
              reminders={reminders}
              onUpdateEvent={onUpdateEvent}
              onApplyEventScope={onApplyEventScope}
              timeFormat={settings.timeFormat}
              user={user}
              weeks={multiWeekBlocks}
              weekStartsOn={settings.weekStartsOn}
            />
          ) : (
            <MonthCalendar
              anchor={anchor}
              busyEventId={busyEventId}
              calendars={calendars}
              events={visibleEvents}
              showAdjacentDays={showAdjacentDays}
              onMoveEventToDate={async ({ dayKey, event, originDayKey }) => {
                // Only the date changes; the time of day and length are kept.
                // The shift is from the day grabbed, so a multi-day bar taken by
                // its middle moves rather than restarting on the drop day —
                // which is the move the preview drew.
                const shift =
                  parseDateKey(dayKey).getTime() -
                  parseDateKey(originDayKey).getTime();
                await commitEventTimes({
                  end: new Date(event.end.getTime() + shift),
                  event,
                  start: new Date(event.start.getTime() + shift),
                });
              }}
              getEventMaster={getEventMaster}
              onForkEvent={onForkEvent}
              onLinkEvent={onLinkEvent}
              onCreateAtDate={
                editableCalendars.length > 0
                  ? (nextDate, target, endDate) =>
                      openCreateAtDate(nextDate, target, undefined, {
                        endDate,
                      })
                  : undefined
              }
              onMonthChange={changePeriod}
              onMoveDraft={moveCreateDraft}
              pendingCreate={
                createIntent
                  ? {
                      color: createIntent.color,
                      date: createIntent.date,
                      endDate: createIntent.endDate,
                    }
                  : undefined
              }
              onNotice={notify}
              onOpenFullEditor={onOpenFullEditor}
              onRemoveEvent={onRemoveEvent}
              onRestoreEvent={onCreateEvent}
              onSetAttendance={onSetAttendance}
              reminders={reminders}
              onUpdateEvent={onUpdateEvent}
              onApplyEventScope={onApplyEventScope}
              timeFormat={settings.timeFormat}
              user={user}
              weekStartsOn={settings.weekStartsOn}
            />
          )}
        </div>

        <SearchDialog
          activeView={activeView}
          canCreateEvents={editableCalendars.length > 0}
          events={visibleEvents.filter(event => !isCalendarTask(event))}
          tasks={tasks}
          calendars={calendars}
          visibleCalendarIds={visibleCalendarIds}
          visibleEventIds={searchVisibleEventIds}
          accountSource={searchAccount}
          canCreateMeetings={!offline && calendars.some(isMeetingCalendarCandidate)}
          onCreateMeeting={() => {
            const returnFocus = searchTriggerRef.current;
            if (returnFocus) setMeetingCreate({ returnFocus });
          }}
          canCreateTasks={editableTaskCalendars.length > 0}
          onCreateTask={() => requestInspectorTransition(() => setTaskCreateRequest(value => value + 1))}
          onTaskSelect={task => { taskReturnFocus.current = searchTriggerRef.current; requestInspectorTransition(() => setSearchTaskId(task.id)); }}
          inputRef={searchRef}
          onCreateEvent={() => {
            const target = searchTriggerRef.current;
            if (!target) return;
            requestAnimationFrame(() => openCreateAtDate(date, target));
          }}
          onEventSelect={event => setSearchDetailId(event.id)}
          onOpenChange={(nextOpen) => {
            setSearchOpen(nextOpen);
            if (!nextOpen) setSearchQuery("");
          }}
          onToday={() => onDateChange(toDateKey(new Date()))}
          onViewChange={handleViewChange}
          open={searchOpen}
          query={searchQuery}
          returnFocus={searchTriggerRef}
          setQuery={setSearchQuery}
        />

        {searchTaskId ? <TaskDetails key={searchTaskId} taskId={searchTaskId} returnFocus={taskReturnFocus} open onOpenChange={open => { if (!open) setSearchTaskId(undefined); }} /> : null}

        <Dialog open={Boolean(searchDetailId)} onOpenChange={open => { if (!open) setSearchDetailId(undefined); }}>
          <DialogContent aria-describedby={undefined} closeLabel="Close event" returnFocus={searchTriggerRef} size="form">
            <DialogHeader>
              <DialogTitle>{searchDetail?.title ?? "Event"}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="grid gap-2 text-14 text-foreground-secondary">
              {searchDetail ? <>
                <p>{getEventDateLabel(searchDetail)} · {getEventRangeLabel(searchDetail, settings.timeFormat)}</p>
                {searchDetail.location ? <p>{searchDetail.location}</p> : null}
                {searchDetail.description ? <p className="whitespace-pre-wrap">{searchDetail.description}</p> : null}
              </> : <p>This event is no longer available.</p>}
              </div>
            </DialogBody>
            {searchDetail && onOpenFullEditor && canEditEvent(searchDetail, calendars) ? (
              <DialogFooter>
                <Button onClick={() => { setSearchDetailId(undefined); onOpenFullEditor(eventFormValues(searchDetail), searchDetail); }}>Edit</Button>
              </DialogFooter>
            ) : null}
          </DialogContent>
        </Dialog>

        <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />

        {scopeRequest ? (
          <RecurrenceScopeDialog
            onResolve={scopeRequest.resolve}
            returnFocus={scopeRequest.returnFocus}
            timeLabel={scopeRequest.timeLabel}
            title={scopeRequest.title}
          />
        ) : null}

        {notice ? (
          <Toast
            action={
              notice.undo
                ? {
                    label: "Undo",
                    onClick: () => void runUndo(notice.undo),
                  }
                : undefined
            }
            message={notice.message}
            placement="workspace"
            tone={notice.tone}
          />
        ) : null}
      </main>
      {createIntent ? (
        <QuickCreate
          anchor={createIntent.anchor}
          calendars={editableCalendars}
          date={createIntent.date}
          email={user.email}
          userName={user.name}
          endDate={createIntent.endDate}
          endTime={createIntent.endTime}
          exactRange={createIntent.exactRange}
          isAllDay={Boolean(createIntent.endDate)}
          key={createIntent.id}
          onCreate={onCreateEvent}
          onSavingChange={saving => { createSaving.current = saving; }}
          onCreated={() => notify("Event created.")}
          // The block on the grid and the fields in here describe one event, so
          // editing the time, the length or the calendar moves and recolours it.
          onDraftChange={(draft) =>
            moveCreateDraft({
              color: draft.color,
              exactRange: draft.exactRange,
              date: draft.date,
              endDate: draft.isAllDay ? draft.endDate : undefined,
              endTime: draft.isAllDay ? undefined : draft.endTime,
              startTime: draft.isAllDay ? undefined : draft.startTime,
            })
          }
          onOpenChange={(open) => {
            if (!open) {
              setCreateIntent(undefined);
            }
          }}
          open
          startTime={createIntent.startTime}
          timeFormat={settings.timeFormat}
          userId={user.id}
          weekStartsOn={settings.weekStartsOn}
        />
      ) : null}
      {meetingCreate ? (
        <ProviderMeetingCreateDialog
          calendars={calendars}
          initialCalendarID={meetingCreate.initialCalendarID}
          initialDate={date}
          returnFocus={meetingCreate.returnFocus}
          onClose={() => setMeetingCreate(undefined)}
        />
      ) : null}
      {newPageOpen ? (
        <NewPageDialog
          onCreate={createNewPage}
          onOpenChange={(open) => {
            if (!open) setNewPageOpen(false);
          }}
        />
      ) : null}
      <ConfirmationDialog
        closeLabel="Close discard Page changes confirmation"
        confirmLabel="Discard changes"
        description="View and calendar visibility changes will be lost."
        onConfirm={discardActivePageDraft}
        onOpenChange={setDiscardPageDraftOpen}
        open={discardPageDraftOpen}
        returnFocus={discardPageDraftButtonRef}
        title="Discard Page changes"
      />
      {settingsPage ? (
        <PageSettingsDialog
          calendars={calendars}
          // The last page can't go: the server would backfill a fresh default
          // on the next read anyway.
          canDelete={pages.length > 1}
          key={settingsPage.id}
          onCreatePage={onCreatePage}
          onDeletePage={async (id) => {
            const result = await onDeletePage(id);
            removePageDraft(id);
            return result;
          }}
          onNotice={notify}
          onOpenChange={(open) => {
            if (!open) setSettingsPage(undefined);
          }}
          onResolveConflictDraft={() => removePageDraft(settingsPage.id)}
          onOpenPage={handlePageChange}
          onSavePage={async (input) => {
            const result = await onSavePage(input);
            if (result.status === "saved") removePageDraft(input.id);
            return result;
          }}
          onSetDefaultPage={onSetDefaultPage}
          page={settingsPage}
        />
      ) : null}
      {shareCalendar ? (
        <ShareCalendarDialog
          calendar={shareCalendar}
          onNotice={notify}
          onOpenChange={(open) => {
            if (!open) setShareCalendar(null);
          }}
          userId={user.id}
        />
      ) : null}
      <SettingsWindow
        calendars={calendars}
        isAdmin={isAdmin}
        onAdoptSettings={onAdoptSettings}
        onCreateCalendar={onCreateCalendar}
        onCreateMeeting={(calendar, returnFocus) => setMeetingCreate({ initialCalendarID: calendar.id, returnFocus })}
        onDisconnectCalendar={onDisconnectExternalCalendar}
        onExportCalendar={onExportCalendar}
        onImportCalendar={onImportCalendar}
        onLoadSettings={onGetSettingsDocument}
        onManageMembers={(calendar) => {
          setSettingsSection(null);
          setLinkNoticeDismissed(true);
          setShareCalendar(calendar);
        }}
        onNotice={notify}
        onOpenChange={(open) => {
          if (open) return;
          setSettingsSection(null);
          // Coming back from a provider opened this window; closing it is the
          // answer to that notice too.
          setLinkNoticeDismissed(true);
        }}
        onPatchSettings={onPatchSettings}
        onRemoveCalendar={onRemoveCalendar}
        onSectionChange={setSettingsSection}
        onUpdateCalendar={onUpdateCalendar}
        open={activeSettingsSection !== null}
        providerLink={providerLink}
        reminders={reminders}
        returnFocus={connectionsReturnFocus}
        section={activeSettingsSection ?? "general"}
        userId={user.id}
      />
    </div>
    </CalendarTaskContext.Provider>
    </DateFormatContext.Provider>
  );
}
