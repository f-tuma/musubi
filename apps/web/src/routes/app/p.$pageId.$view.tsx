import { privateEditorSearch } from "~/calendar/event-editor-privacy";
import { handoffEventEditor } from "~/calendar/event-editor-draft";
import {
  createFileRoute,
  Outlet,
  useChildMatches,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, ApiResponseError } from "~/api/http";
import { useNewerServer } from "~/api/use-newer-server";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { createTask, getEvents, getTasks, removeTask, updateTask } from "~/api/resources";
import { refreshServerData, useServerStream } from "~/api/realtime";
import { useReminders } from "~/calendar/use-reminders";
import { useProviderLinkReturn } from "~/calendar/connections";
import { useSessionUser } from "~/auth/use-session-user";
import { useSnapshot } from "~/offline/SnapshotProvider";
import { canKeepOfflineQueryData } from "~/offline/query-error";
import { signOutAndReset } from "~/offline/sign-out";
import { parseDateKey } from "~/calendar/calendar-math";
import { toDateKey } from "~/calendar/date-key";
import {
  Workspace,
  type PageWorkingDraft,
} from "~/calendar/components/Workspace";
import { useAnnouncementsQuery } from "~/calendar/components/AnnouncementDialog";
import { useEventMutations } from "~/calendar/event-mutations";
import { usePageMutations } from "~/calendar/page-editor";
import { useCalendarTransfers } from "~/calendar/calendar-transfers";
import { useSettingsMutations } from "~/calendar/settings-mutations";
import { useWorkspaceQueries } from "~/calendar/workspace-queries";
import { WorkspaceDataState } from "~/components/WorkspaceDataState";
import { Onboarding } from "~/onboarding/Onboarding";
import { isCalendarView, viewDefinition, type CalendarViewId } from "~/calendar/view-registry";

const searchSchema = z.object({
  taskLayout: z.enum(["list", "kanban"]).optional().catch(undefined),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .catch(() => toDateKey(new Date())),
});

export const Route = createFileRoute("/app/p/$pageId/$view")({
  validateSearch: searchSchema,
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  /* The event editor is a layer above this screen rather than a page of its
     own. While it is open the address bar belongs to it, so the canonical-page
     redirect inside the screen has to keep its hands off — otherwise opening
     the editor from a stale Page id would send the URL back to the calendar and
     close the editor with it. */
  const editorOpen = useChildMatches().length > 0;

  return (
    <>
      <CalendarScreen editorOpen={editorOpen} />
      <Outlet />
    </>
  );
}

function CalendarScreen({ editorOpen }: { editorOpen: boolean }) {
  const { pageId, view } = Route.useParams();
  const { date, taskLayout } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  // Offline the session cannot be confirmed, so the last known account stands in
  // — otherwise every query key would say "anonymous" and the snapshot for the
  // real user would sit there unread.
  const { user } = useSessionUser();
  const userId = user?.id ?? "anonymous";
  const snapshot = useSnapshot();
  // Owned above every loading/error/redirect return so a transient Workspace
  // unmount cannot discard edits belonging to another Page.
  const [pageDrafts, setPageDrafts] = useState<Map<string, PageWorkingDraft>>(
    () => new Map(),
  );
  // The first Tasks fetch temporarily unmounts Workspace while loading.
  const [taskCreateRequest, setTaskCreateRequest] = useState(0);
  useServerStream(userId);
  // Reminders ring only while a tab is open (web push is a later phase), so
  // this lives at the top of the signed-in shell rather than inside a view.
  const reminders = useReminders(userId);
  // Above Workspace: provider return state must survive canonical Page redirects.
  const providerLink = useProviderLinkReturn(userId);
  const activeView: CalendarViewId = isCalendarView(view) ? view : "month";
  const taskView = activeView === "tasks";
  const [searchActive, setSearchActive] = useState(false);
  const workspace = useWorkspaceQueries(date, userId, activeView);
  const pages = workspace.pages.data;
  const activePage = pages?.find((page) => page.id === pageId);
  const tasksQuery = useQuery({
    // Dated tasks are part of every calendar view as well as the task list.
    enabled: !snapshot.offline,
    queryFn: ({ signal }) => getTasks(signal),
    queryKey: queryKeys.tasks(getServerOrigin(), userId),
    // Disk restoration may precede the latest mutation's debounced snapshot.
    // Verify online even while the restored query is inside its stale window.
    refetchOnMount: "always",
  });
  const searchEvents = useQuery({
    enabled: searchActive && !snapshot.offline,
    queryKey: ["events", getServerOrigin(), userId, "account-search"],
    queryFn: ({ signal }) => getEvents(undefined, signal),
    // Realtime invalidation refreshes this scoped query while the palette or
    // its detail is open. Never include account-wide results in offline storage.
    gcTime: 0,
    meta: { persist: false },
  });
  useEffect(() => {
    if (!searchActive) queryClient.removeQueries({ queryKey: ["events", getServerOrigin(), userId, "account-search"], exact: true });
  }, [searchActive, queryClient, userId]);
  // Same query (and same staleTime/refetchOnWindowFocus) the announcement
  // modal makes, so this costs no extra request and cannot revive the modal
  // on a focus refetch — see useAnnouncementsQuery's comment.
  const announcements = useAnnouncementsQuery();
  const isAdmin = announcements.data?.isAdmin === true;
  const eventMutations = useEventMutations(userId);
  const calendarTransfers = useCalendarTransfers(userId);
  const settingsMutations = useSettingsMutations(userId);
  const pageMutations = usePageMutations(userId);
  const queries = [
    workspace.calendars,
    workspace.events,
    workspace.pages,
    workspace.settings,
    ...((!snapshot.offline || tasksQuery.data !== undefined)
      ? [tasksQuery]
      : []),
  ];
  // One source for "the server did not answer", shared with every form that has
  // to refuse a write (`SnapshotProvider`).
  const offline = snapshot.offline;
  // A tab left open across a deploy still runs the bundle it started with.
  // Asking costs no request — the capability document is already fetched.
  const newerServer = useNewerServer(!offline);
  // Restored data that this session has not re-fetched yet. `isFetchedAfterMount`
  // is the honest test: `snapshot.restored` stays true all session, long after
  // the first refresh made it moot.
  const stale =
    !offline &&
    queries.some(
      (query) => query.data !== undefined && !query.isFetchedAfterMount,
    );
  // Waiting on the restore counts as loading: painting an empty calendar first
  // and filling it a frame later is worse than a moment of the loading state.
  const pending = queries.some((query) => query.isPending) || !snapshot.ready;
  const errorQuery = queries.find(
    (query) => query.error && !canKeepOfflineQueryData(query, offline),
  );
  const error =
    errorQuery?.error ?? workspace.expansionError ?? reminders?.error;

  // Resolve the URL page id against the loaded pages. Unknown ids (a stale
  // bookmark or the "default" sentinel from the initial redirect) fall back to
  // the canonical default Page — real ids are server UUIDs.
  const fallbackPageId =
    pages && !activePage
      ? (pages.find((page) => page.isDefault) ?? pages[0])?.id
      : undefined;

  // Put the address bar back in step with what is on screen. An unrecognised view
  // renders the month, so leaving `/schedule` in the URL means the page, the view
  // picker and the link someone copies all disagree.
  useEffect(() => {
    if (editorOpen) return;
    if (!fallbackPageId && view === activeView) return;
    void navigate({
      params: { pageId: fallbackPageId ?? pageId, view: activeView },
      replace: true,
      search: { date, taskLayout },
      to: "/app/p/$pageId/$view",
    });
  }, [activeView, date, taskLayout, editorOpen, fallbackPageId, navigate, pageId, view]);

  if (pending) {
    return (
      <WorkspaceDataState
        detail="Loading calendars, events and your display preferences."
        kind="loading"
        title="Preparing your calendar…"
      />
    );
  }

  if (
    error ||
    !workspace.calendars.data ||
    !workspace.events.data ||
    (taskView && !tasksQuery.data) ||
    !workspace.pages.data ||
    !workspace.settings.data
  ) {
    const requestId =
      error instanceof ApiError || error instanceof ApiResponseError
        ? error.requestId
        : undefined;

    return (
      <WorkspaceDataState
        detail={
          offline
            ? "There is no saved copy of this calendar on this device yet. Reconnect and try again."
            : error instanceof Error
              ? error.message
              : "The server did not return the complete calendar data."
        }
        kind={offline ? "offline" : "error"}
        onRetry={() => {
          void Promise.all([
            ...queries.map((query) => query.refetch()),
            workspace.federated.refetch(),
            reminders?.retry?.(),
          ]);
        }}
        requestId={requestId}
        title={
          offline
            ? "The server cannot be reached."
            : "We could not open this calendar."
        }
      />
    );
  }

  if (!activePage) {
    // Either redirecting to the default Page (fallbackPageId set) or the account
    // genuinely has no pages (backfill failed) — offer a retry in that case.
    return fallbackPageId ? (
      <WorkspaceDataState
        detail="Opening your default calendar page."
        kind="loading"
        title="Preparing your calendar…"
      />
    ) : (
      <WorkspaceDataState
        detail="Your account has no calendar pages yet. Retry to create the default page."
        kind="error"
        onRetry={() => void workspace.pages.refetch()}
        title="No calendar pages available."
      />
    );
  }

  // First run, in place rather than at another route: a reactive redirect here
  // races the very queries it depends on. Not while offline — the flag cannot be
  // written without a server, and a snapshot that predates it would ask again on
  // every cold start.
  if (!offline && workspace.settings.data.onboarded !== true) {
    return (
      <Onboarding
        calendars={workspace.mergedCalendars}
        onGetSettingsDocument={settingsMutations.getSettingsDocument}
        onPatchSettings={settingsMutations.patchSettings}
        onUpdateCalendar={calendarTransfers.updateCalendar}
        userName={user?.name ?? ""}
        onDone={() => void workspace.settings.refetch()}
      />
    );
  }

  return (
    <Workspace
      onSearchActiveChange={setSearchActive}
      searchAccount={{
        data: {
          events: (snapshot.offline ? workspace.events.data?.baseEvents ?? [] : searchEvents.isError ? [] : searchEvents.data?.events ?? []).filter(event => !event.isCanceled),
          tasks: tasksQuery.isError ? [] : tasksQuery.data?.tasks ?? [],
          calendars: workspace.calendars.isError ? [] : workspace.calendars.data ?? [],
        },
        loading: searchEvents.isFetching || tasksQuery.isFetching,
        error: searchEvents.isError || tasksQuery.isError,
        retry: () => { void searchEvents.refetch(); void tasksQuery.refetch(); },
      }}
      activeView={activeView}
      taskLayout={taskLayout ?? "list"}
      onTaskLayoutChange={layout => void navigate({ viewTransition: !window.matchMedia("(prefers-reduced-motion: reduce)").matches, search: previous => ({ ...previous, taskLayout: layout }), resetScroll: false })}
      baseEvents={workspace.mergedEvents?.baseEvents}
      calendars={workspace.mergedCalendars}
      pages={workspace.pages.data}
      date={date}
      events={workspace.mergedEvents?.events ?? []}
      tasks={tasksQuery.data?.tasks ?? []}
      calendarsResolved={workspace.calendars.isSuccess && !workspace.calendars.isFetching && !workspace.calendars.isPlaceholderData}
      tasksResolved={tasksQuery.isSuccess && !tasksQuery.isFetching && !tasksQuery.isPlaceholderData}
      isAdmin={isAdmin}
      isRefreshing={queries.some((query) => query.isFetching)}
      onRefreshServer={() => refreshServerData(queryClient, userId)}
      newerServer={newerServer}
      offline={offline}
      snapshotAt={snapshot.savedAt}
      stale={stale}
      onCreateEvent={eventMutations.createEvent}
      onCreateTask={async (task) => {
        const created = await createTask(task);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.tasks(getServerOrigin(), userId),
        });
        return created;
      }}
      onUpdateTask={async (id, task) => {
        try {
          return await updateTask(id, task);
        } finally {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.tasks(getServerOrigin(), userId),
          });
        }
      }}
      onRemoveTask={async (task) => {
        await removeTask(task.id);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.tasks(getServerOrigin(), userId),
        });
      }}
      onAdoptSettings={settingsMutations.adoptSettings}
      onForkEvent={eventMutations.forkEvent}
      onExportCalendar={calendarTransfers.exportCalendar}
      onImportCalendar={calendarTransfers.importCalendar}
      onCreateCalendar={calendarTransfers.createCalendar}
      onDisconnectExternalCalendar={
        calendarTransfers.disconnectExternalCalendar
      }
      onUpdateCalendar={calendarTransfers.updateCalendar}
      onRemoveCalendar={calendarTransfers.removeCalendar}
      onGetSettingsDocument={settingsMutations.getSettingsDocument}
      onLinkEvent={eventMutations.linkEvent}
      onCreatePage={pageMutations.createPage}
      onDeletePage={pageMutations.deletePage}
      onReorderPages={pageMutations.reorderPages}
      onSavePage={pageMutations.savePage}
      onSetDefaultPage={pageMutations.setDefaultPage}
      taskCreateRequest={taskCreateRequest}
      onTaskCreateRequestChange={setTaskCreateRequest}
      pageDrafts={pageDrafts}
      onPageDraftsChange={setPageDrafts}
      pageId={pageId}
      onRemoveEvent={eventMutations.removeEvent}
      onPatchSettings={settingsMutations.patchSettings}
      onSetAttendance={eventMutations.setAttendance}
      reminders={reminders}
      settings={workspace.settings.data}
      user={user!}
      onStepPeriod={(offset, weeks) => void navigate({
        // View transitions may commit after the URL changes. Step from the
        // latest navigation state so fast repeated keys never use an old date.
        search: previous => ({ ...previous, date: toDateKey(viewDefinition(activeView).step(parseDateKey(previous.date), offset, { weeks })) }),
        viewTransition: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      })}
      onDateChange={(nextDate) =>
        void navigate({
          search: { date: nextDate, taskLayout },
          viewTransition: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        })
      }
      onPageChange={(nextPageId, nextView) =>
        void navigate({
          params: { pageId: nextPageId, view: nextView },
          search: { date, taskLayout },
          to: "/app/p/$pageId/$view",
        })
      }
      onOpenFullEditor={(values, event) => {
        // The draft goes in the URL so the page survives a reload.
        const search = {
          ...privateEditorSearch(values, event),
          createID: event ? undefined : values.createID,
          timeKind: values.timeKind,
          timeZone: values.timeZone,
          exactRange: values.exactRange ? { start: values.exactRange.start.toISOString(), end: values.exactRange.end.toISOString() } : undefined,
          invalidatedExactEndpoints: values.invalidatedExactEndpoints,
          allDay: values.isAllDay || undefined,
          attendees: values.hasAttendees || undefined,
          calendarId: values.calendarId,
          calendarIds:
            values.calendarIds.length > 1 ? values.calendarIds : undefined,
          date: values.date,
          endDate: values.endDate || undefined,
          endTime: values.endTime || undefined,
          recurrence: values.recurrence || undefined,
          returnDate: date,
          taskLayout,
          startTime: values.startTime || undefined,
          view: activeView,
        };

        if (event) {
          handoffEventEditor(event);
          void navigate({
            params: { eventId: event.id, pageId, view: activeView },
            search,
            to: "/app/p/$pageId/$view/event/$eventId",
          });
        } else {
          void navigate({
            params: { pageId, view: activeView },
            search,
            to: "/app/p/$pageId/$view/event/new",
          });
        }
      }}
      onViewChange={(nextView) =>
        void navigate({
          params: { pageId, view: nextView },
          viewTransition: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          search: { date, taskLayout },
          to: "/app/p/$pageId/$view",
        })
      }
      providerLink={providerLink}
      onSignOut={() => {
        void signOutAndReset({
          onDone: () => void navigate({ replace: true, to: "/login" }),
          queryClient,
        });
      }}
      onUpdateEvent={eventMutations.updateEvent}
      onApplyEventScope={eventMutations.applyEventScope}
    />
  );
}
