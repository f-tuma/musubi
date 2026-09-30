import { observeGraphSeriesContent, prepareGraphSeriesContent } from "./microsoft_series_content";
import { observeGraphOccurrenceContent, prepareGraphOccurrenceContent, updateGraphOccurrenceContent } from "./microsoft_occurrence_content";
import { prepareGraphSeriesDeletion, deleteGraphSeries } from "./microsoft_series_delete";
import { assertMicrosoftPersonalContent, microsoftPersonalContentPatch, microsoftEventVersion, updateMicrosoftPersonalContent, deleteMicrosoftPersonalEvent } from "./microsoft_event_content";
import { getOrganizerTimeEventIDs } from "@musubi/db";
import { observeGraphMeetingCancellation, prepareGraphMeetingCancellation, cancelGraphMeeting } from "./microsoft_meeting_cancel";
import { microsoftOrganizerTransport } from "./microsoft_organizer";
import { graphRsvpTime } from "./microsoft_rsvp";
import { isDeepStrictEqual } from "node:util";
import { findGraphCreatedSeriesAdoption } from "./microsoft_series_create";
import { createGraphSeries } from "./microsoft_series_delivery";
import { readGraphSeriesFamily, readGraphSeriesFamilyOrMissing } from "./microsoft_series_family";
import { microsoftEventState } from "./provider_event_state";
import { config, logger } from "@musubi/config";
import { getOAuthAccountIDs, hasOAuthTaskScope } from "@musubi/db";
import { assertTaskMutationResponse, ProviderTaskWriteError } from "../task_write";
import {
  DEFAULT_CALENDAR_COLOR,
  EventWriteError,
  OccurrenceStartSchema,
  type Event,
  nearestMicrosoftCalendarColor,
  type Task,
  type TaskStatus,
} from "@musubi/types";
import type {
  CalendarAdapter,
  CalendarDiscoveryResult,
  ExternalCalendarInfo,
  FetchChangesResult,
  NormalizedChange,
  NormalizedEvent,
  NormalizedTask,
} from "../adapter";
import { getOAuthAccessToken } from "../oauth";
import { isOptionalTaskError, TaskScopeMissingError } from "../errors";
import { assertEventWriteEvidence, assertEventWriteResponse, assertOAuthEventWriteGrant, assertProviderEventMutationResponse, ProviderEventWriteError } from "../event_write";
import { assertCompleteEventReadResponse, assertCreatedEventEvidence, eventCreateOperationID } from "../event_create_identity";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TASK_LIST_PREFIX = "musubi-microsoft-task-list:";

export function microsoftTaskListExternalId(taskListId: string) {
  return `${TASK_LIST_PREFIX}${taskListId}`;
}

function microsoftTaskListId(externalCalendarId: string) {
  return externalCalendarId.startsWith(TASK_LIST_PREFIX)
    ? externalCalendarId.slice(TASK_LIST_PREFIX.length)
    : null;
}

// ── Sync window tuning ───────────────────────────────────────────────────────
// Graph's v1.0 event delta only works on a calendarView — a FIXED date range
// baked into the delta token at the initial sync. Events outside the window
// are invisible to the mirror; when the future edge gets close, we force a
// full re-sync with a fresh window (reset: true → the engine wipes + refetches
// and its sweep tombstones events that slid out of the window).
// ponytail: rolling ~2.5y view, not full history like Google. Upgrade path:
// beta /events/delta (unbounded) once it hits v1.0.
const WINDOW_PAST_DAYS = 180;
const WINDOW_FUTURE_DAYS = 730;
const WINDOW_RENEW_MARGIN_DAYS = 90; // re-window when less future than this remains
const PAGE_SIZE = 100;

const DAY_MS = 86_400_000;

// Every request asks for UTC times and plain-text bodies up front — saves
// timezone/HTML conversion on our side.
const PREFER = `outlook.timezone="UTC", outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}`;

async function getAccessToken(
  userID: string,
  accountId: string,
  requireTasks = false,
) {
  const tenant = config.social.microsoftTenantID;
  const accessToken = await getOAuthAccessToken(
    "microsoft",
    userID,
    accountId,
    {
      tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      clientId: config.social.microsoftClientID,
      clientSecret: config.social.microsoftClientSecret,
      // Omit scope on refresh: Microsoft retains the original grant, including
      // Tasks when granted, without escalating calendar-only consent.
      subtypeKey: "suberror",
    },
  );
  // Refresh may return a narrower grant. Check after minting, before any Tasks
  // endpoint, including task writes that bypass discovery.
  if (
    requireTasks &&
    !(await hasOAuthTaskScope(userID, "microsoft", accountId))
  )
    throw new TaskScopeMissingError();
  return accessToken;
}

// Error with Graph's own message when available ("Cannot delete default
// calendar", …) — status text alone is useless to the user.
async function graphError(res: Response): Promise<Error> {
  let detail = res.statusText;
  try {
    detail = (await res.json())?.error?.message ?? detail;
  } catch {
    /* keep statusText */
  }
  return new Error(`Outlook ${res.status}: ${detail}`);
}

// Graph dateTime comes as "2026-07-18T20:30:00.0000000" (no zone designator,
// zone is UTC via the Prefer header). Trim the 7-digit fraction and pin Z.
export function parseGraphDate(dateTime: string): Date {
  const normalized = dateTime.replace(/(\.\d{3})\d*/, "$1");
  return new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`,
  );
}

// Graph event JSON -> NormalizedEvent. Recurring series arrive pre-expanded by
// calendarView (occurrences + exceptions as individual events), so recurrence
// is always null here — no RRULE conversion on pull.
export function toNormalized(item: any): NormalizedEvent {
  if (item["@removed"]) {
    return {
      externalId: item.id,
      status: "cancelled",
      title: "",
      start: new Date(0),
      end: new Date(0),
      isAllDay: false,
      description: null,
      location: null,
      organizer: null,
      recurrence: null,
      url: null,
    };
  }

  const isAllDay = !!item.isAllDay;
  const start = parseGraphDate(item.start.dateTime);
  const end = isAllDay
    ? new Date(parseGraphDate(item.end.dateTime).getTime() - DAY_MS) // Graph all-day end is exclusive
    : parseGraphDate(item.end.dateTime);

  let reminderTimeEvidence: NormalizedEvent["reminderTimeEvidence"];
  if (item.type === "singleInstance" && !item.recurrence && !item.seriesMasterId || ["occurrence", "exception"].includes(item.type) && item.providerOccurrence) {
    try { const native = graphRsvpTime({ ...item, type: "singleInstance" }); reminderTimeEvidence = { timeModel: native.timeModel!, start: native.start, end: native.end, isAllDay: native.isAllDay }; } catch { /* Legacy reads remain available without action evidence. */ }
  }
  return {
    ...(typeof item.iCalUId === "string" ? { icalUid: item.iCalUId } : {}),
    ...(reminderTimeEvidence ? { reminderTimeEvidence } : {}),
    externalId: item.id,
    // Keep the exact provider version for the verified personal and organizer
    // content PATCH paths; changeKey is never converted into an ETag.
    etag: typeof item["@odata.etag"] === "string" ? item["@odata.etag"] : null,
    status: "active",
    providerState: microsoftEventState(item),
    creationOperationID: typeof item.transactionId === "string" ? item.transactionId : undefined,
    title: item.subject ?? "(untitled)",
    start,
    end,
    isAllDay,
    description: item.body?.content?.trim() || null,
    location: item.location?.displayName?.trim() || null,
    organizer: item.organizer?.emailAddress?.address ?? null,
    recurrence: null,
    // NOT webLink — that's just "open in Outlook" noise on every event.
    url: item.onlineMeeting?.joinUrl ?? item.onlineMeetingUrl ?? null,
  };
}

// Musubi Event -> Graph event JSON
export function toGraphEvent(event: Event) {
  // Pull never produces recurrence for this provider (see toNormalized), so
  // this only triggers for Musubi-native recurring events pushed into an
  // Outlook mirror. Graph models recurrence as structured patterns + per-
  // occurrence exceptions — no iCal RRULE/EXDATE round-trip exists.
  // ponytail: reject instead of silently dropping the recurrence; upgrade
  // path is an RRULE→patternedRecurrence converter + master-echo dedup.
  if (event.recurrence) {
    throw new Error(
      "Outlook calendars don't support recurring events created in Musubi yet.",
    );
  }
  return {
    subject: event.title,
    body: { contentType: "text", content: event.description ?? "" },
    location: { displayName: event.location ?? "" },
    isAllDay: event.isAllDay,
    // All-day needs midnight-to-midnight and an exclusive end (+1 day).
    start: {
      dateTime: event.isAllDay
        ? event.start.toISOString().slice(0, 10) + "T00:00:00"
        : event.start.toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: event.isAllDay
        ? new Date(event.end.getTime() + DAY_MS).toISOString().slice(0, 10) +
          "T00:00:00"
        : event.end.toISOString(),
      timeZone: "UTC",
    },
  };
}

/** Graph event-update documents omission preservation, not event If-Match CAS.
 * The personal-content transport below enables only its separately proven field
 * subset. Do not round-trip rich omitted data or infer safe DELETE from PATCH.
 */
export function toGraphEventPatch(event: Event, patch: Partial<Event>) {
  const full = toGraphEvent({ ...event, recurrence: null });
  const result: Record<string, unknown> = {};
  if (patch.title !== undefined) result.subject = full.subject;
  if (patch.description !== undefined) result.body = full.body;
  if (patch.location !== undefined) result.location = full.location;
  if (patch.isAllDay !== undefined) result.isAllDay = full.isAllDay;
  if (patch.start !== undefined || patch.isAllDay !== undefined) result.start = full.start;
  if (patch.end !== undefined || patch.isAllDay !== undefined) result.end = full.end;
  if (patch.recurrence !== undefined) {
    throw new EventWriteError("recurrence", "unsupported", "Outlook recurrence changes are not supported yet. No changes were saved.");
  }
  return result;
}

function graphTaskDate(value: any) {
  return typeof value?.dateTime === "string"
    ? parseGraphDate(value.dateTime)
    : null;
}

function graphTaskStatus(status: string | undefined): TaskStatus {
  if (status === "completed") return "completed";
  if (status === "inProgress") return "in-process";
  return "needs-action";
}

export function toNormalizedMicrosoftTask(item: any): NormalizedTask {
  const status = graphTaskStatus(item.status);
  return {
    completedAt: graphTaskDate(item.completedDateTime),
    deleted: Boolean(item["@removed"]),
    description: item.body?.content?.trim() || null,
    due: graphTaskDate(item.dueDateTime),
    etag: item["@odata.etag"] ?? null,
    externalId: item.id,
    icalUid: null,
    isAllDay: false,
    percentComplete: status === "completed" ? 100 : 0,
    priority:
      item.importance === "high" ? 1 : item.importance === "low" ? 9 : 0,
    recurrence: null,
    relatedTo: null,
    sequence: 0,
    start: graphTaskDate(item.startDateTime),
    status,
    title: item.title ?? "(untitled)",
    url:
      item.linkedResources?.find((resource: any) => resource?.webUrl)?.webUrl ??
      null,
  };
}

function toGraphTaskDate(date: Date | null | undefined) {
  return date
    ? { dateTime: date.toISOString().replace(/Z$/, ""), timeZone: "UTC" }
    : null;
}

export function toGraphTask(task: Task) {
  return {
    body: { content: task.description ?? "", contentType: "text" },
    dueDateTime: toGraphTaskDate(task.due),
    importance:
      task.priority === 0
        ? "normal"
        : task.priority < 5
          ? "high"
          : task.priority > 5
            ? "low"
            : "normal",
    startDateTime: toGraphTaskDate(task.start),
    status:
      task.status === "completed"
        ? "completed"
        : task.status === "in-process"
          ? "inProgress"
          : "notStarted",
    title: task.title,
  };
}

type MicrosoftTaskRequestOptions = {
  fetchImpl?: typeof fetch;
  graphBase?: string;
  beforeMutation?: () => Promise<void>;
  patch?: Record<string, unknown>;
};

function microsoftTaskPath(taskListId: string, taskId?: string) {
  const list = encodeURIComponent(taskListId);
  return `/me/todo/lists/${list}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
}

// Some Graph task collections reject delta even with valid Tasks consent.
// Fetch every page before returning a full snapshot so a partial response can
// never trigger the engine's missing-task sweep. Retry delta on the next sync.
async function fetchMicrosoftTaskSnapshot(
  accessToken: string,
  initialUrl: string,
  fetchImpl: typeof fetch,
): Promise<FetchChangesResult> {
  const changes: NormalizedChange[] = [];
  const visited = new Set<string>();
  let url: string | null = initialUrl;
  while (url) {
    if (visited.has(url)) throw new Error("Outlook task pagination repeated a page");
    visited.add(url);
    const res = await graphGet(accessToken, url, fetchImpl);
    if (!res.ok) throw await graphError(res);
    const data = await res.json();
    if (!Array.isArray(data.value) || data.value.some((item: any) => !item || typeof item.id !== "string" || !item.id)) {
      throw new Error("Outlook task snapshot is incomplete");
    }
    if (data["@odata.nextLink"] != null && (typeof data["@odata.nextLink"] !== "string" || !data["@odata.nextLink"])) {
      throw new Error("Outlook task pagination is invalid");
    }
    for (const item of data.value) {
      changes.push({ kind: "task", data: toNormalizedMicrosoftTask(item) });
    }
    url = data["@odata.nextLink"] ?? null;
  }
  return { changes, nextCursor: null, reset: true };
}

export async function fetchMicrosoftTaskChanges(
  accessToken: string,
  taskListId: string,
  cursor: string | null,
  options: MicrosoftTaskRequestOptions = {},
): Promise<FetchChangesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  const initialUrl = `${graphBase}${microsoftTaskPath(taskListId)}/delta?$top=${PAGE_SIZE}`;
  const changes: NormalizedChange[] = [];
  let reset = !cursor;
  let url = cursor ?? initialUrl;
  let deltaLink: string | null = null;

  while (!deltaLink) {
    const res = await graphGet(accessToken, url, fetchImpl);
    if (res.status === 410 && url !== initialUrl) {
      changes.length = 0;
      reset = true;
      url = initialUrl;
      continue;
    }
    if (res.status === 400) {
      const detail = await res.clone().json().catch(() => null);
      if (typeof detail?.error?.message === "string" && /delta query is not supported by this resource/i.test(detail.error.message)) {
        return fetchMicrosoftTaskSnapshot(
          accessToken,
          `${graphBase}${microsoftTaskPath(taskListId)}?$top=${PAGE_SIZE}`,
          fetchImpl,
        );
      }
    }
    if (!res.ok) throw await graphError(res);
    const data = await res.json();
    for (const item of data.value ?? []) {
      changes.push({ kind: "task", data: toNormalizedMicrosoftTask(item) });
    }
    if (data["@odata.nextLink"]) url = data["@odata.nextLink"];
    else deltaLink = data["@odata.deltaLink"] ?? url;
  }

  return { changes, nextCursor: deltaLink, reset };
}

export async function createMicrosoftTask(
  accessToken: string,
  taskListId: string,
  task: Task,
  options: MicrosoftTaskRequestOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  await options.beforeMutation?.();
  const res = await fetchImpl(`${graphBase}${microsoftTaskPath(taskListId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(toGraphTask(task)),
  });
  assertTaskMutationResponse(res);
  const created = await res.json();
  if (typeof created.id !== "string" || !created.id) throw new ProviderTaskWriteError("task-write-failed", "unconfirmed");
  return {
    etag: created["@odata.etag"] ?? null,
    externalTaskId: created.id,
    icalUid: null,
  };
}

export async function updateMicrosoftTask(
  accessToken: string,
  taskListId: string,
  externalTaskId: string,
  task: Task,
  etag: string | null | undefined,
  options: MicrosoftTaskRequestOptions = {},
) {
  if (!etag) throw new Error("Microsoft task update requires an ETag");
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  await options.beforeMutation?.();
  const res = await fetchImpl(
    `${graphBase}${microsoftTaskPath(taskListId, externalTaskId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify(options.patch ?? toGraphTask(task)),
    },
  );
  assertTaskMutationResponse(res);
  const updated = await res.json();
  return { etag: updated["@odata.etag"] ?? null, icalUid: null };
}

export async function deleteMicrosoftTask(
  accessToken: string,
  taskListId: string,
  externalTaskId: string,
  etag: string | null | undefined,
  options: MicrosoftTaskRequestOptions = {},
) {
  if (!etag) throw new Error("Microsoft task delete requires an ETag");
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  await options.beforeMutation?.();
  const res = await fetchImpl(
    `${graphBase}${microsoftTaskPath(taskListId, externalTaskId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "If-Match": etag,
      },
    },
  );
  if (res.status !== 404 && res.status !== 410) assertTaskMutationResponse(res);
}

export function toExternalMicrosoftTaskList(list: any): ExternalCalendarInfo {
  return {
    color: DEFAULT_CALENDAR_COLOR,
    externalId: microsoftTaskListExternalId(list.id),
    name: list.displayName ?? "Tasks",
    readOnly: list.isOwner !== true,
    supportsEvents: false,
    supportsTasks: true,
  };
}

async function listMicrosoftTaskLists(accessToken: string) {
  const lists: any[] = [];
  let url: string | null = `${GRAPH}/me/todo/lists?$top=${PAGE_SIZE}`;
  while (url) {
    const res = await graphGet(accessToken, url);
    if (!res.ok) throw await graphError(res);
    const data = await res.json();
    lists.push(...(data.value ?? []));
    url = data["@odata.nextLink"] ?? null;
  }
  return lists;
}

// The cursor stores the deltaLink AND the window's future edge so we know when
// to re-window. Old plain-URL cursors (or garbage) parse as "no cursor".
export function parseCursor(
  cursor: string | null,
): { link: string; windowEnd: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor);
    if (
      typeof parsed?.link === "string" &&
      typeof parsed?.windowEnd === "number"
    )
      return parsed;
  } catch {
    /* treat as no cursor */
  }
  return null;
}

async function graphGet(
  accessToken: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: PREFER },
  });
}

// calendarView/delta returns recurring-series OCCURRENCES as lightweight stubs:
// only id/start/end/seriesMasterId — no subject, isAllDay, body, etc. Those live
// on the series master, which is usually outside the sync window (its start is
// the first-ever instance), so it isn't in the delta stream. Fetch it by id and
// cache per sync run so a holiday calendar costs one extra GET per series.
async function fetchSeriesMaster(
  accessToken: string,
  externalCalendarId: string,
  id: string,
  cache: Map<string, any>,
  fetchImpl: typeof fetch = fetch,
  graphBase = GRAPH,
): Promise<any> {
  if (cache.has(id)) return cache.get(id);
  const res = await graphGet(
    accessToken,
    `${graphBase}${microsoftEventPath(externalCalendarId, id)}`,
    fetchImpl,
  );
  // Even 404/410 on an active occurrence's dependency is ambiguous. Only
  // explicit delta @removed entries authorize removal; never advance past an
  // incomplete hydration or cache an error as a successful empty master.
  if (!res.ok) throw await graphError(res);
  const master = await res.json();
  if (!master || master.id !== id || master["@removed"]) {
    throw new Error("Outlook returned an invalid series master");
  }
  cache.set(id, master);
  return master;
}

export async function fetchMicrosoftChanges(
  accessToken: string,
  externalCalendarId: string,
  cursor: string | null,
  options: {
    fetchImpl?: typeof fetch;
    graphBase?: string;
    now?: number;
    timeModels?: boolean;
    rsvpOccurrences?: boolean;
    organizerEventIDs?: readonly string[];
    excludedEventIDs?: readonly string[];
    excludedSeriesIDs?: readonly string[];
  } = {},
): Promise<FetchChangesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  const now = options.now ?? Date.now();
  const changes: NormalizedChange[] = [];
  const excludedEvents = new Set(options.excludedEventIDs ?? []);
  const excludedSeries = new Set(options.excludedSeriesIDs ?? []);

  let parsed = parseCursor(cursor);
  // Window edge approaching → start over with a fresh window.
  if (parsed && parsed.windowEnd - now < WINDOW_RENEW_MARGIN_DAYS * DAY_MS)
    parsed = null;

  let reset = !parsed && (!!cursor || !!options.timeModels); // had a cursor but can't continue from it → wipe
  let windowEnd = parsed?.windowEnd ?? now + WINDOW_FUTURE_DAYS * DAY_MS;
  let url =
    parsed?.link ??
    initialDeltaUrl(externalCalendarId, windowEnd, now, graphBase);
  let deltaLink: string | null = null;
  const seriesMasters = new Map<string, any>();
  let restarted = false;

  while (!deltaLink) {
    const res = await graphGet(accessToken, url, fetchImpl);

    // Delta token expired → discard partial incremental pages and restart as a
    // full set. The engine sweeps mappings missing from the completed result.
    if (res.status === 410) {
      if (restarted || !parsed) throw new Error("Outlook rejected the initial calendar window.");
      restarted = true;
      reset = true;
      changes.length = 0;
      seriesMasters.clear();
      windowEnd = now + WINDOW_FUTURE_DAYS * DAY_MS;
      url = initialDeltaUrl(externalCalendarId, windowEnd, now, graphBase);
      continue;
    }
    if (!res.ok) throw await graphError(res);

    const data = await res.json();
    for (let item of data.value ?? []) {
      // A complete native family is reconciled separately. Filter before
      // hydration, including stale/removed IDs and the flag-off read path.
      if (excludedEvents.has(item.id) || excludedSeries.has(item.seriesMasterId)) continue;
      if (item.type === "seriesMaster") continue; // definition only; occurrences carry the instances
      // Occurrences/exceptions inherit subject, isAllDay, body, … from their
      // master; backfill them (the occurrence's own start/end/id win on spread).
      if (item.seriesMasterId && !item["@removed"]) {
        const master = await fetchSeriesMaster(
          accessToken,
          externalCalendarId,
          item.seriesMasterId,
          seriesMasters,
          fetchImpl,
          graphBase,
        );
        if (options.timeModels || options.rsvpOccurrences) {
          if (!item.originalStart || item.type === "exception") {
            // Graph can omit originalStart even from an unprojected instance
            // GET. Select it explicitly while retaining the default fields so
            // exception overrides and the instance validator remain available.
            const response = await graphGet(accessToken, `${graphBase}${microsoftEventPath(externalCalendarId, item.id)}?$select=*,originalStart`, fetchImpl);
            if (!response.ok) throw await graphError(response);
            const instance = await response.json();
            if (instance.id !== item.id || instance.seriesMasterId !== item.seriesMasterId || instance["@removed"])
              throw new Error("Outlook returned an invalid occurrence dependency.");
            item = { ...item, ...instance };
          }
          if (typeof item.originalStart !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(item.originalStart) || /\.\d{3}\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/i.test(item.originalStart))
            throw new Error("Outlook occurrence identity requires an exact millisecond UTC instant.");
          const originalStart = OccurrenceStartSchema.parse({ kind: "instant", value: parseGraphDate(item.originalStart).toISOString() });
          const providerOccurrence = { externalSeriesID: item.seriesMasterId, originalStart };
          // A master validator never authorizes a conditional instance write.
          item = { ...master, ...item, "@odata.etag": item["@odata.etag"] ?? null, providerOccurrence };
        } else item = { ...master, ...item };
      }
      const event = toNormalized(item);
      if (options.organizerEventIDs?.includes(item.id) && !item["@removed"]) {
        const time = graphRsvpTime({ ...item, isCancelled: false });
        event.start = time.start; event.end = time.end; event.isAllDay = time.isAllDay; event.timeModel = time.timeModel;
        if (item.isCancelled) event.status = "cancelled";
      }
      // Keep the native parent address even with time editing disabled. A
      // family may be accepted after this fetch captured its exclusions.
      if (item.seriesMasterId != null) {
        if (typeof item.seriesMasterId !== "string" || !item.seriesMasterId.trim() || item.seriesMasterId.trim() !== item.seriesMasterId || item.seriesMasterId === item.id)
          throw new Error("Outlook returned an invalid source series address.");
        event.sourceSeriesID = item.seriesMasterId;
      }
      if ((options.timeModels || options.rsvpOccurrences) && !item["@removed"]) {
        event.providerOccurrence = item.providerOccurrence;
        // The provider expands this bounded view. Never attach its recurrence
        // to local instances, which would generate the series a second time.
        if (item.isCancelled) event.status = "cancelled";
      }
      changes.push({ kind: "event", data: event });
    }

    if (data["@odata.nextLink"]) {
      url = data["@odata.nextLink"];
    } else {
      deltaLink = data["@odata.deltaLink"] ?? url;
    }
  }

  return {
    changes,
    nextCursor: JSON.stringify({ link: deltaLink, windowEnd }),
    reset,
  };
}

type GraphCalendar = {
  isDefaultCalendar?: boolean;
  id: string;
  name: string;
  hexColor?: string | null;
  canEdit?: boolean;
  canViewPrivateItems?: boolean;
};

export function microsoftEventPath(
  externalCalendarId: string,
  externalEventId: string,
) {
  return `/me/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(externalEventId)}`;
}

export function toExternalCalendar(c: GraphCalendar): ExternalCalendarInfo {
  return {
    externalId: c.id,
    providerDefaultCalendar: typeof c.isDefaultCalendar === "boolean" ? c.isDefaultCalendar : null,
    name: c.name,
    // Graph must explicitly grant writes. Missing permission data is not a safe
    // reason to expose actions that can only fail later.
    readOnly: c.canEdit !== true,
    microsoftAccess: { canEdit: typeof c.canEdit === "boolean" ? c.canEdit : null, canViewPrivateItems: typeof c.canViewPrivateItems === "boolean" ? c.canViewPrivateItems : null },
    // hexColor is "" when the calendar uses the "auto" preset
    color: c.hexColor || "#0078D4",
    supportsEvents: true,
    supportsTasks: false,
  };
}

export const microsoftAdapter: CalendarAdapter = {
  microsoftOrganizer: microsoftOrganizerTransport(getAccessToken),
  async observeGraphSeriesContent(context, signal) { return observeGraphSeriesContent(await getAccessToken(context.address.actorID, context.link.accountID), context, signal); },
  async prepareGraphSeriesContent(context, request, signal) { return prepareGraphSeriesContent(await getAccessToken(context.address.actorID, context.link.accountID), context, request, signal); },
  async observeGraphOccurrenceContent(context, signal) { return observeGraphOccurrenceContent(await getAccessToken(context.address.actorID, context.link.accountID), context, signal); },
  async prepareGraphOccurrenceContent(context, request, signal) { return prepareGraphOccurrenceContent(await getAccessToken(context.address.actorID, context.link.accountID), context, request, signal); },
  async updateGraphOccurrenceContent(saved, mark, accepted, signal) { return updateGraphOccurrenceContent(await getAccessToken(saved.context.address.actorID, saved.context.link.accountID), saved, mark, accepted, signal); },
  async observeGraphMeetingCancellation(context, signal) { return observeGraphMeetingCancellation(await getAccessToken(context.address.actorID, context.link.accountID), context, signal); },
  async prepareGraphMeetingCancellation(context, request, signal) { return prepareGraphMeetingCancellation(await getAccessToken(context.address.actorID, context.link.accountID), context, request, signal); },
  async cancelGraphMeeting(saved, mark, accepted, signal) { return cancelGraphMeeting(await getAccessToken(saved.context.address.actorID, saved.context.link.accountID), saved, mark, accepted, signal); },
  provider: "microsoft",
  projectEvent(event) { return toNormalized({ ...toGraphEvent(event), id: event.id }); },

  async listAccounts(
    userID: string,
    accountId?: string,
  ): Promise<{ id: string; label: string }[]> {
    const ids = await getOAuthAccountIDs(userID, "microsoft", accountId);
    return Promise.all(
      ids.map(async (id) => {
        let label = id;
        try {
          const accessToken = await getAccessToken(userID, id);
          const res = await fetch(`${GRAPH}/me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (res.ok) {
            const d = await res.json();
            label = d.mail ?? d.userPrincipalName ?? id;
          }
        } catch {
          /* fall back to id */
        }
        return { id, label };
      }),
    );
  },

  async listCalendars(
    userID: string,
    accountId: string,
  ): Promise<CalendarDiscoveryResult> {
    const accessToken = await getAccessToken(userID, accountId);
    const calendars: ExternalCalendarInfo[] = [];
    let url: string | null =
      `${GRAPH}/me/calendars?$select=id,name,hexColor,canEdit,canViewPrivateItems,isDefaultCalendar&$top=${PAGE_SIZE}`;
    while (url) {
      const res = await graphGet(accessToken, url);
      if (!res.ok) throw await graphError(res);
      const data = await res.json();
      for (const c of data.value ?? []) calendars.push(toExternalCalendar(c));
      url = data["@odata.nextLink"] ?? null;
    }
    if (!(await hasOAuthTaskScope(userID, "microsoft", accountId))) {
      return { calendars, taskListsComplete: false };
    }
    try {
      const taskLists = await listMicrosoftTaskLists(accessToken);
      return {
        calendars: [
          ...calendars,
          ...taskLists.map(toExternalMicrosoftTaskList),
        ],
        taskListsComplete: true,
      };
    } catch (error) {
      if (!isOptionalTaskError(error)) throw error;
      logger.warn("sync.tasks.discovery_unavailable", {
        provider: "microsoft",
        userId: userID,
        accountId,
      });
      return { calendars, taskListsComplete: false };
    }
  },

  async fetchChanges(
    userID,
    accountId,
    externalCalendarId,
    cursor,
    options,
  ): Promise<FetchChangesResult> {
    const exclusions = { excludedEventIDs: [...(options?.excludedEventIDs ?? [])], excludedSeriesIDs: [...(options?.excludedSeriesIDs ?? [])] };
    const accessToken = await getAccessToken(userID, accountId);
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (
      taskListId &&
      !(await hasOAuthTaskScope(userID, "microsoft", accountId))
    )
      throw new TaskScopeMissingError();
    return taskListId
      ? fetchMicrosoftTaskChanges(accessToken, taskListId, cursor)
      : fetchMicrosoftChanges(accessToken, externalCalendarId, cursor, { timeModels: config.api.eventTimeEditsEnabled, rsvpOccurrences: config.api.providerRsvpEditsEnabled, organizerEventIDs: await getOrganizerTimeEventIDs(userID, accountId, externalCalendarId, "microsoft"), ...exclusions });
  },

  async createGraphFamily(userID, accountId, externalCalendarId, event, identity, state) {
    const accessToken = await getAccessToken(userID, accountId);
    const created = await createGraphSeries(accessToken, externalCalendarId, event, identity, state);
    let family;
    try {
      family = await readGraphSeriesFamily(accessToken, externalCalendarId, event, created.ref, identity.signal);
    } catch (error) {
      // An incomplete or changing family observation is not a confirmed saved
      // intent conflict. Recover the existing transaction and retry the read.
      throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined, error instanceof ProviderEventWriteError ? error.retryAfterMs : undefined);
    }
    if (family.master.externalId !== created.ref.externalEventId || family.master.icalUid !== created.ref.icalUid || family.master.creationOperationID !== identity.operationID)
      throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
    return family;
  },

  async readMicrosoftRsvp(user, account, calendar, ref, response, signal, occurrence, series) {
    if (!config.api.providerRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const token = await getAccessToken(user, account);
    await assertOAuthEventWriteGrant(user, "microsoft", account);
    const { graphRsvpSession } = await import("./microsoft_rsvp_delivery");
    const evidence = await (await graphRsvpSession(token, account, calendar, signal)).read(ref.externalEventId, response, occurrence, series);
    if (!evidence || evidence.etag !== ref.etag || evidence.native.iCalUId !== ref.icalUid) throw new ProviderEventWriteError("provider-conflict");
    return evidence;
  },
  async writeMicrosoftRsvp(user, account, calendar, evidence, dispatched, signal, beforeDispatch, accepted) {
    if (!config.api.providerRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const token = await getAccessToken(user, account);
    await assertOAuthEventWriteGrant(user, "microsoft", account);
    const { graphRsvpSession } = await import("./microsoft_rsvp_delivery");
    const session = await graphRsvpSession(token, account, calendar, signal);
    return session.write(evidence, dispatched, async () => {
      if (!config.api.providerRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported");
      await assertOAuthEventWriteGrant(user, "microsoft", account);
      if (!(await getOAuthAccountIDs(user, "microsoft", account)).includes(account)) throw new ProviderEventWriteError("provider-conflict");
      await beforeDispatch();
    }, accepted);
  },
  async readGraphCreateAdoption(userID, accountID, calendarID, event, identity) {
    if (!config.api.eventTimeEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const accessToken = await getAccessToken(userID, accountID);
    if (!calendarID || calendarID.trim() !== calendarID || [".", ".."].includes(calendarID)) throw new ProviderEventWriteError("provider-conflict");
    const permission = await fetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarID)}?$select=id,canEdit`, { headers: { Authorization: `Bearer ${accessToken}`, "Cache-Control": "no-cache" }, redirect: "error", signal: identity.signal });
    assertCompleteEventReadResponse(permission);
    const calendar = await permission.json();
    if (calendar.id !== calendarID) throw new ProviderEventWriteError("provider-conflict");
    assertEventWriteEvidence(calendar.canEdit, "event-write");
    const found = await findGraphCreatedSeriesAdoption(accessToken, calendarID, event, identity);
    if (!found) return null;
    const family = await readGraphSeriesFamily(accessToken, calendarID, found.candidate, found.evidence.ref, identity.signal);
    if (family.master.creationOperationID !== identity.operationID || family.cancelled.length || family.instances.some(value => value.providerState?.eventType !== "occurrence")) throw new ProviderEventWriteError("provider-conflict");
    const again = await findGraphCreatedSeriesAdoption(accessToken, calendarID, event, identity);
    if (!again || !isDeepStrictEqual(found, again)) throw new ProviderEventWriteError("provider-conflict");
    return family;
  },

  async prepareGraphDeletion(context, request, signal) {
    await assertOAuthEventWriteGrant(context.address.userID, "microsoft", context.link.accountID);
    return prepareGraphSeriesDeletion(await getAccessToken(context.address.userID, context.link.accountID), context, request, signal);
  },
  async deleteGraphSeries(saved, reconciling, beforeWrite, signal) {
    await assertOAuthEventWriteGrant(saved.context.address.userID, "microsoft", saved.context.link.accountID);
    return deleteGraphSeries(await getAccessToken(saved.context.address.userID, saved.context.link.accountID), saved, reconciling, beforeWrite, signal);
  },
  async readGraphFamily(userID, accountId, externalCalendarId, template, ref, signal) {
    const timeout = AbortSignal.timeout(60_000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return readGraphSeriesFamilyOrMissing(await getAccessToken(userID, accountId), externalCalendarId, template, ref, bounded);
  },

  async assertEventWrite(userID, accountId, externalCalendarId, operation) {
    if (
      (operation.action === "create" && operation.event.recurrence) ||
      (operation.action !== "create" &&
        (operation.event.recurrence || operation.previous?.recurrence))
    ) {
      throw new EventWriteError(
        "recurrence", "unsupported",
        "Manage recurring events in Outlook. No changes were saved.",
      );
    }
    if (operation.action === "update" && operation.external) microsoftPersonalContentPatch(operation.patch);
    const accessToken = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    if (operation.action !== "create" && operation.external) {
      await assertMicrosoftPersonalContent({ token: accessToken, calendarID: externalCalendarId, eventID: operation.external.externalEventId, etag: operation.external.etag, signal: operation.signal }, operation.action);
      return;
    }
    const headers = { Authorization: `Bearer ${accessToken}` };
    const response = await fetch(
      `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}?$select=canEdit`,
      { headers, signal: operation.signal },
    );
    assertEventWriteResponse(response);
    const calendar = await response.json();
    assertEventWriteEvidence(calendar.canEdit, "event-write");
  },

  async findCreatedEvent(userID, accountId, externalCalendarId, identity) {
    const operationID = eventCreateOperationID(identity);
    const accessToken = await getAccessToken(userID, accountId);
    const base = new URL(
      `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}/events`,
    );
    let next: string | null =
      `${base}?$select=id,transactionId,subject,start,end,isAllDay,isCancelled,body,location,organizer,recurrence,onlineMeeting,onlineMeetingUrl&$top=100`;
    const visited = new Set<string>();
    let found: Record<string, any> | undefined;
    // Do not assume transactionId supports $filter or has unlimited server-side
    // retention. Inspect the complete scoped listing; missing is NOT retry proof.
    while (next) {
      const url: URL = new URL(next);
      if (
        url.origin !== base.origin ||
        url.pathname !== base.pathname ||
        url.username ||
        url.password ||
        visited.has(url.href) ||
        visited.size >= 1000
      )
        throw new ProviderEventWriteError("provider-write-failed");
      visited.add(url.href);
      const response: Response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.timezone="UTC"',
          "Cache-Control": "no-cache",
        },
        redirect: "error",
        signal: identity?.signal,
      });
      assertCompleteEventReadResponse(response);
      const data: { value: unknown; "@odata.nextLink"?: string } =
        await response.json();
      if (
        !Array.isArray(data.value) ||
        (data["@odata.nextLink"] !== undefined &&
          (typeof data["@odata.nextLink"] !== "string" || !data["@odata.nextLink"] || data["@odata.nextLink"].trim() !== data["@odata.nextLink"]))
      )
        throw new ProviderEventWriteError("provider-write-failed");
      for (const item of data.value)
        if (item.transactionId === operationID) {
          if (found || typeof item.id !== "string" || !item.id)
            throw new ProviderEventWriteError("provider-conflict");
          found = item;
        }
      next = data["@odata.nextLink"] ?? null;
    }
    if (!found) return null;
    if (found.isCancelled || found.recurrence)
      throw new ProviderEventWriteError("provider-conflict");
    const event = assertCreatedEventEvidence(toNormalized(found));
    return {
      ref: { externalEventId: found.id, etag: event.etag ?? null },
      event,
    };
  },

  async pushCreate(
    userID,
    accountId,
    externalCalendarId,
    event: Event,
    identity,
  ) {
    if (event.recurrence) {
      throw new EventWriteError(
        "recurrence",
        "unsupported",
        "Outlook recurrence creation is not supported yet. No changes were saved.",
      );
    }
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...toGraphEvent(event),
          ...(identity
            ? { transactionId: eventCreateOperationID(identity) }
            : {}),
        }),
        redirect: "error",
        signal: identity?.signal,
      },
    );
    assertProviderEventMutationResponse(res);
    const data = await res.json().catch(() => null);
    if (typeof data?.id !== "string" || !data.id)
      throw new ProviderEventWriteError(
        "provider-write-failed",
        "unconfirmed",
        res.status,
      );
    return {
      externalEventId: data.id,
      etag:
        typeof data["@odata.etag"] === "string" ? data["@odata.etag"] : null,
    };
  },

  async readEvent(userID, accountId, externalCalendarId, ref, signal) {
    const token = await getAccessToken(userID, accountId);
    const response = await fetch(`${GRAPH}${microsoftEventPath(externalCalendarId, ref.externalEventId)}`, {
      headers: { Authorization: `Bearer ${token}`, Prefer: PREFER, "Cache-Control": "no-cache" }, redirect: "error", signal,
    });
    if (response.status === 404) return null;
    assertCompleteEventReadResponse(response);
    const data = await response.json();
    if (data?.id !== ref.externalEventId) throw new ProviderEventWriteError("provider-conflict");
    const event = assertCreatedEventEvidence(toNormalized(data));
    return { event, ref: { externalEventId: data.id, etag: microsoftEventVersion(data["@odata.etag"]) } };
  },

  async pushUpdate(userID, accountId, externalCalendarId, externalEventId, _event, ref, patch, signal) {
    microsoftPersonalContentPatch(patch);
    if (!ref || ref.externalEventId !== externalEventId || !microsoftEventVersion(ref.etag)) throw new ProviderEventWriteError("provider-version-unavailable");
    const token = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    return updateMicrosoftPersonalContent({ token, calendarID: externalCalendarId, eventID: externalEventId, etag: ref.etag, signal }, patch);
  },

  async pushDelete(userID, accountId, externalCalendarId, externalEventId, ref, signal) {
    if (!ref || ref.externalEventId !== externalEventId || !microsoftEventVersion(ref.etag)) throw new ProviderEventWriteError("provider-version-unavailable");
    const token = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    await deleteMicrosoftPersonalEvent({ token, calendarID: externalCalendarId, eventID: externalEventId, etag: ref.etag, signal });
  },

  projectTask: toGraphTask,

  async readTask(userID, accountId, externalCalendarId, ref) {
    const list = microsoftTaskListId(externalCalendarId);
    if (!list) throw new ProviderTaskWriteError("task-source-read-only");
    const response = await graphGet(await getAccessToken(userID, accountId, true), `${GRAPH}${microsoftTaskPath(list, ref.externalTaskId)}`);
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw await graphError(response);
    const value = await response.json();
    if (value.id !== ref.externalTaskId || typeof value.title !== "string") throw new ProviderTaskWriteError("task-projection-unavailable");
    return { ref: { externalTaskId: value.id, etag: value["@odata.etag"] ?? null, icalUid: null }, projection: toGraphTask({ ...toNormalizedMicrosoftTask(value), id: value.id, creatorID: userID, calendarID: "" }) };
  },

  async assertTaskWrite(userID, accountId, externalCalendarId, operation) {
    const list = microsoftTaskListId(externalCalendarId);
    if (!list) throw new ProviderTaskWriteError("task-source-read-only");
    const response = await graphGet(await getAccessToken(userID, accountId, true), `${GRAPH}/me/todo/lists/${encodeURIComponent(list)}`);
    if (!response.ok) throw await graphError(response);
    const nativeList = await response.json();
    if (nativeList.id !== list) throw new ProviderTaskWriteError("task-projection-unavailable");
    if (operation.secondary && nativeList.isOwner !== true) throw new ProviderTaskWriteError("task-source-read-only");
    // To Do exposes weak @odata.etag, but its v1.0 update/delete contract does
    // not document a conditional-write guarantee. New fanout must not mistake
    // preflight for CAS; existing legacy single-source methods stay separate.
    if (operation.secondary && operation.action !== "create") throw new ProviderTaskWriteError("task-conditional-write-unsupported");
    if (operation.action !== "create") {
      if (!operation.external?.etag) throw new ProviderTaskWriteError("task-version-unavailable");
      const current = await microsoftAdapter.readTask!(userID, accountId, externalCalendarId, operation.external);
      if (!current && operation.action === "delete") return;
      if (!current || current.ref.etag !== operation.external.etag) throw new ProviderTaskWriteError("task-provider-conflict");
    }
  },

  async pushTaskCreate(userID, accountId, externalCalendarId, task, beforeMutation) {
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (!taskListId)
      throw new Error("Microsoft task write requires a task list");
    return createMicrosoftTask(
      await getAccessToken(userID, accountId, true),
      taskListId,
      task,
      { beforeMutation },
    );
  },

  async pushTaskUpdate(
    userID,
    accountId,
    externalCalendarId,
    externalTaskId,
    task,
    ref,
    patch,
  ) {
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (!taskListId)
      throw new Error("Microsoft task write requires a task list");
    return updateMicrosoftTask(
      await getAccessToken(userID, accountId, true),
      taskListId,
      externalTaskId,
      task,
      ref?.etag,
      { patch, beforeMutation: ref?.beforeMutation },
    );
  },

  async pushTaskDelete(
    userID,
    accountId,
    externalCalendarId,
    externalTaskId,
    ref,
  ) {
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (!taskListId)
      throw new Error("Microsoft task write requires a task list");
    await deleteMicrosoftTask(
      await getAccessToken(userID, accountId, true),
      taskListId,
      externalTaskId,
      ref?.etag,
      { beforeMutation: ref?.beforeMutation },
    );
  },

  async createCalendar(userID, accountId, { name, color }) {
    // Graph only accepts preset color names (hexColor is read-only) — map to
    // the nearest preset. The client offers exactly these presets for Outlook
    // calendars, so this is normally an exact match.
    const accessToken = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    const res = await fetch(`${GRAPH}/me/calendars`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        color: nearestMicrosoftCalendarColor(color).name,
      }),
    });
    if (!res.ok) throw await graphError(res);
    const data = await res.json();
    return { externalId: data.id };
  },

  async updateCalendar(userID, accountId, externalCalendarId, { name, color }) {
    const accessToken = await getAccessToken(userID, accountId);
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (
      taskListId &&
      !(await hasOAuthTaskScope(userID, "microsoft", accountId))
    )
      throw new TaskScopeMissingError();
    if (taskListId) {
      const res = await fetch(
        `${GRAPH}/me/todo/lists/${encodeURIComponent(taskListId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: name }),
        },
      );
      if (!res.ok) throw await graphError(res);
      return;
    }
    const metadata = await graphGet(accessToken, `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}?$select=isDefaultCalendar`);
    if (!metadata.ok) throw await graphError(metadata);
    if ((await metadata.json()).isDefaultCalendar !== false) {
      throw new Error("The default Outlook calendar's name and color cannot be changed in Musubi.");
    }
    const res = await fetch(
      `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          color: nearestMicrosoftCalendarColor(color).name,
        }),
      },
    );
    if (!res.ok) throw await graphError(res);
  },

  async deleteCalendar(userID, accountId, externalCalendarId) {
    const accessToken = await getAccessToken(userID, accountId);
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (
      taskListId &&
      !(await hasOAuthTaskScope(userID, "microsoft", accountId))
    )
      throw new TaskScopeMissingError();
    const res = await fetch(
      taskListId
        ? `${GRAPH}/me/todo/lists/${encodeURIComponent(taskListId)}`
        : `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    // 404/410 = already gone = success; the default calendar comes back as an
    // error and bubbles up.
    if (!res.ok && res.status !== 404 && res.status !== 410)
      throw await graphError(res);
  },
};

function initialDeltaUrl(
  externalCalendarId: string,
  windowEnd: number,
  now = Date.now(),
  graphBase = GRAPH,
): string {
  const start = new Date(now - WINDOW_PAST_DAYS * DAY_MS).toISOString();
  const end = new Date(windowEnd).toISOString();
  return `${graphBase}/me/calendars/${encodeURIComponent(externalCalendarId)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
}
