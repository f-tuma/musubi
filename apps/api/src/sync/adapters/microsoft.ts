import { observeGraphSeriesContent, prepareGraphSeriesContent } from "./microsoft_series_content";
import type { NativeWritePlanV1 } from "@musubi/sync-codec";
import { pinnedJsonBodyV1 } from "../pinned_write";
import { observeGraphOccurrenceContent, prepareGraphOccurrenceContent, updateGraphOccurrenceContent } from "./microsoft_occurrence_content";
import { prepareGraphSeriesDeletion, deleteGraphSeries } from "./microsoft_series_delete";
import { assertMicrosoftPersonalContent, assertMicrosoftPersonalContentPatch, microsoftEventVersion, updateMicrosoftPersonalContent, deleteMicrosoftPersonalEvent } from "./microsoft_event_content";
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
import { assertTaskMutationResponse, assertTaskReadResponse, ProviderTaskWriteError } from "../task_write";
import { observedProviderFetch, observedProviderRequest } from "../provider_http_metrics";
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
import { graphCalendarDiscoveryHttpError, isMicrosoftEventMailboxUnavailable, type GraphCalendarDiscoveryPhase } from "./microsoft_calendar_discovery_error";
import { graphTaskListDiscoveryHttpError, type GraphTaskListDiscoveryPhase } from "./microsoft_task_list_discovery_error";
import { graphDiscoveryInventory, MICROSOFT_TASK_LIST_PREFIX as TASK_LIST_PREFIX, type TaskListItem } from "./microsoft_discovery_inventory";
import { graphTaskReadFailureKind, graphTaskReadHttpError, type GraphTaskReadPhase } from "./microsoft_task_read_error";
import { GraphTaskReadResponseError, graphTaskReadPage, graphTaskReadTraversal } from "./microsoft_task_read_page";
import { assertEventWriteEvidence, assertEventWriteResponse, assertOAuthEventWriteGrant, assertProviderEventMutationResponse, ProviderEventWriteError } from "../event_write";
import { assertCompleteEventReadResponse, assertCreatedEventEvidence, eventCreateOperationID } from "../event_create_identity";

const GRAPH = "https://graph.microsoft.com/v1.0";

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
// fresh window. Neither missing window entries nor @removed prove deletion:
// Graph also returns @removed for events changed outside the date range.
// https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0
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
  signal?: AbortSignal,
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
    { signal },
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
    throw new Error("Outlook window removal is not a deletion proof.");
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
  nativePlan?: NativeWritePlanV1;
  fetchImpl?: typeof fetch;
  graphBase?: string;
  beforeMutation?: () => Promise<void>;
  patch?: Record<string, unknown>;
  signal?: AbortSignal;
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
  graphBase: string,
  traversal: ReturnType<typeof graphTaskReadTraversal>,
): Promise<FetchChangesResult> {
  const changes: NormalizedChange[] = [];
  let url: string | null = initialUrl;
  let requestPhase: GraphTaskReadPhase = "initial";
  while (url) {
    traversal.visit(url, "snapshot");
    const res = await graphGet(accessToken, url, fetchImpl);
    if (!res.ok) throw await graphTaskReadHttpError(res, { readKind: "snapshot", requestPhase, url });
    const page = await graphTaskReadPage(res, "snapshot", graphBase);
    try {
      for (const item of page.items) changes.push({ kind: "task", data: toNormalizedMicrosoftTask(item) });
    } catch {
      throw new GraphTaskReadResponseError("snapshot", "normalization", res.status);
    }
    url = page.nextLink;
    requestPhase = "next-page";
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
  const traversal = graphTaskReadTraversal(graphBase);
  let reset = cursor === null;
  let url = cursor ?? initialUrl;
  let requestPhase: GraphTaskReadPhase = cursor == null ? "initial" : "saved-cursor";
  let deltaLink: string | null = null;

  while (!deltaLink) {
    traversal.visit(url, "delta");
    const res = await graphGet(accessToken, url, fetchImpl);
    if (res.status === 410 && url !== initialUrl) {
      changes.length = 0;
      traversal.clearVisited();
      reset = true;
      url = initialUrl;
      requestPhase = "recovery-initial";
      continue;
    }
    if (res.status === 400) {
      const detail = await res.clone().json().catch(() => null);
      const reason = graphTaskReadFailureKind(detail);
      const missingInitialPageState = reason === "missing-page-state" &&
        (requestPhase === "initial" || requestPhase === "recovery-initial") && url === initialUrl;
      if (reason === "delta-unsupported" || missingInitialPageState) {
        const fields = { provider: "microsoft", mode: "snapshot", requestPhase, reason };
        logger.info("sync.tasks.snapshot_fallback_selected", fields);
        const result = await fetchMicrosoftTaskSnapshot(
          accessToken,
          `${graphBase}${microsoftTaskPath(taskListId)}?$top=${PAGE_SIZE}`,
          fetchImpl,
          graphBase,
          traversal,
        );
        // This proves a complete adapter read only. Persistence and checkpoint
        // commit remain the host's independently fenced responsibility.
        logger.info("sync.tasks.snapshot_read_completed", { ...fields, taskCount: result.changes.length });
        return result;
      }
    }
    if (!res.ok) throw await graphTaskReadHttpError(res, { readKind: "delta", requestPhase, url });
    const page = await graphTaskReadPage(res, "delta", graphBase);
    try {
      for (const item of page.items) changes.push({ kind: "task", data: toNormalizedMicrosoftTask(item) });
    } catch {
      throw new GraphTaskReadResponseError("delta", "normalization", res.status);
    }
    if (page.nextLink !== null) {
      url = page.nextLink;
      requestPhase = "next-page";
    } else deltaLink = page.deltaLink;
  }

  return { changes, nextCursor: deltaLink, reset };
}

export async function createMicrosoftTask(
  accessToken: string,
  taskListId: string,
  task: Task,
  options: MicrosoftTaskRequestOptions = {},
) {
  options.signal?.throwIfAborted();
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  await options.beforeMutation?.();
  options.signal?.throwIfAborted();
  const res = await observedProviderRequest(fetchImpl, `${graphBase}${microsoftTaskPath(taskListId)}`, {
    method: "POST",
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.nativePlan ? pinnedJsonBodyV1(options.nativePlan) : toGraphTask(task)),
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
  options.signal?.throwIfAborted();
  if (!etag) throw new Error("Microsoft task update requires an ETag");
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  await options.beforeMutation?.();
  options.signal?.throwIfAborted();
  const res = await observedProviderRequest(fetchImpl,
    `${graphBase}${microsoftTaskPath(taskListId, externalTaskId)}`,
    {
      method: "PATCH",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify(options.nativePlan ? pinnedJsonBodyV1(options.nativePlan, Object.keys(options.patch ?? {})) : options.patch ?? toGraphTask(task)),
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
  options.signal?.throwIfAborted();
  if (!etag) throw new Error("Microsoft task delete requires an ETag");
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  await options.beforeMutation?.();
  options.signal?.throwIfAborted();
  const res = await observedProviderRequest(fetchImpl,
    `${graphBase}${microsoftTaskPath(taskListId, externalTaskId)}`,
    {
      method: "DELETE",
      signal: options.signal,
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

export async function fetchMicrosoftTaskLists(accessToken: string, fetchImpl?: typeof fetch) {
  const lists: TaskListItem[] = [];
  let url: string | null = `${GRAPH}/me/todo/lists?$top=${PAGE_SIZE}`;
  const inventory = graphDiscoveryInventory("tasks", url);
  let requestPhase: GraphTaskListDiscoveryPhase = "initial";
  while (url) {
    const res = await graphGet(accessToken, inventory.visit(url), fetchImpl);
    if (!res.ok) throw await graphTaskListDiscoveryHttpError(res, requestPhase);
    const page = await inventory.page(res);
    lists.push(...page.items);
    url = page.nextLink;
    requestPhase = "next-page";
  }
  return lists;
}

export type MicrosoftWindowCursor = {
  version: 2;
  calendarId: string;
  link: string;
  windowStart: number;
  windowEnd: number;
};

// Older cursors did not preserve the exact start bound. Never guess that bound
// or certify inventory from an old token: renew as a nondestructive window.
export function parseCursor(
  cursor: string | null,
): MicrosoftWindowCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor);
    if (
      parsed?.version === 2 && Object.keys(parsed).length === 5 && validGraphId(parsed.calendarId) &&
      typeof parsed.link === "string" && parsed.link.length > 0 &&
      Number.isSafeInteger(parsed.windowStart) && Number.isSafeInteger(parsed.windowEnd) &&
      parsed.windowStart < parsed.windowEnd &&
      Number.isFinite(new Date(parsed.windowStart).getTime()) &&
      Number.isFinite(new Date(parsed.windowEnd).getTime())
    )
      return parsed;
  } catch {
    /* treat as no cursor */
  }
  return null;
}

function validGraphId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value);
}

async function assertCompleteGraphRead(response: Response) {
  // A read failure cannot have dispatched a write. Preserve Graph's typed
  // status/Retry-After error rather than labelling it an uncertain mutation.
  if (!response.ok) throw await graphError(response);
  assertCompleteEventReadResponse(response);
  if (response.status !== 200 || response.redirected) {
    throw new Error("Outlook returned an incomplete read response.");
  }
}

function assertDeltaLink(
  link: unknown,
  calendarID: string,
  graphBase: string,
  linkKind: "cursor" | "request" | "next" | "delta",
): string {
  const invalid = () => Object.assign(new Error("Outlook returned an invalid delta link."), {
    cause: { code: "graph-delta-link-invalid", linkKind },
  });
  if (typeof link !== "string" || !link || link.trim() !== link || /[\u0000-\u001f\u007f]/.test(link)) {
    throw invalid();
  }
  const expected = new URL(`${graphBase}/me/calendars/${encodeURIComponent(calendarID)}/calendarView/delta`);
  let parsed: URL;
  try { parsed = new URL(link); } catch { throw invalid(); }
  const prefix = new URL(`${graphBase}/me/calendars/`).pathname;
  const suffix = "/calendarView/delta";
  const pathPrefixMatches = parsed.pathname.startsWith(prefix);
  const pathSuffixMatches = parsed.pathname.endsWith(suffix);
  const segment = pathPrefixMatches && pathSuffixMatches
    ? parsed.pathname.slice(prefix.length, -suffix.length) : null;
  const calendarSegmentCount = segment === null ? null : segment ? segment.split("/").length : 0;
  let calendarEncodingValid = false;
  let calendarIdMatches = false;
  if (calendarSegmentCount === 1) {
    try {
      // Only this opaque ID segment has equivalent spellings (e.g. =/%3D).
      // Static routes and other identities cannot be authorized by decoding.
      calendarIdMatches = decodeURIComponent(segment!) === calendarID;
      calendarEncodingValid = true;
    } catch { /* Never retain a URI error or its potentially private input. */ }
  }
  // URL parsing repairs dot segments, backslashes and malformed authorities.
  // Reject repaired paths; do not rebuild the opaque continuation or its query.
  const raw = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/.exec(link);
  const pathUnmodified = raw !== null && raw[2] === parsed.pathname;
  const sameOrigin = parsed.origin === expected.origin;
  const sameProtocol = parsed.protocol === expected.protocol;
  const hasCredentials = Boolean(parsed.username || parsed.password || raw?.[1]?.includes("@"));
  const hasFragment = link.includes("#");
  if (!sameOrigin || !sameProtocol || !["https:", "http:"].includes(expected.protocol) ||
    hasCredentials || hasFragment || !pathUnmodified || !calendarIdMatches) {
    const route = sameOrigin && sameProtocol && ["https:", "http:"].includes(expected.protocol) &&
      !hasCredentials && !hasFragment && pathUnmodified
      ? graphRejectedDeltaRoute(link, calendarID, graphBase)
      : { canonicalCandidateRoute: "unknown", canonicalCandidateOwnerKind: "unknown" };
    throw Object.assign(new Error("Outlook returned a delta link outside the calendar read scope."), {
      // Fixed fields only: no URL, token, calendar/account ID or caught error.
      cause: { code: "graph-delta-link-scope-invalid", linkKind, sameOrigin, sameProtocol,
        pathPrefixMatches, pathSuffixMatches, calendarSegmentCount, calendarEncodingValid,
        calendarIdMatches, rawPathEqual: parsed.pathname === expected.pathname,
        pathUnmodified, hasCredentials, hasFragment, ...route },
    });
  }
  return link;
}

type GraphCanonicalCalendarBinding = {
  prefix: string;
  suffix: string;
  owner: string;
  ownerKey: string | null;
  calendarKey: string;
  ownerKind: "me" | "users-segment" | "users-odata";
  keyStyle: "segment" | "odata";
};

type GraphIdentityDiagnostics = {
  canonicalMetadataState: "not-evaluated" | "absent" | "null" | "non-string" | "empty" | "present";
  canonicalMetadataFailure: "not-evaluated" | "none" | "not-absolute" | "unsafe-url" | "origin" | "protocol" | "version" | "unsupported-route" | "calendar-key-mismatch";
  canonicalProofOwnerKind: GraphCanonicalCalendarBinding["ownerKind"] | "unknown";
  canonicalProofKeyStyle: GraphCanonicalCalendarBinding["keyStyle"] | "unknown";
};
type GraphCalendarIdentityProof = {
  binding: GraphCanonicalCalendarBinding | null;
  diagnostics: GraphIdentityDiagnostics;
  contradictory: boolean;
};

class GraphCalendarIdentityError extends Error {
  readonly cause: {
    code: "graph-calendar-identity-unverified";
    reason: "request" | "response" | "body" | "canonical-resource" | "principal-request" | "principal-response" | "principal-body";
    status?: number;
  };
  constructor(reason: GraphCalendarIdentityError["cause"]["reason"], status?: number) {
    // Only a real failed proof HTTP response supplies this fixed status prefix
    // to the transient classifier. Keep denials and identity/body failures out
    // of its optional-Tasks status handling; never retain provider error text.
    const transientResponse = (reason === "response" || reason === "principal-response") &&
      typeof status === "number" && Number.isInteger(status) &&
      (status === 408 || status === 429 || (status >= 500 && status <= 599));
    super(transientResponse ? `Outlook ${status}: delta link identity could not be verified.`
      : "Outlook delta link identity could not be verified.");
    this.name = "GraphCalendarIdentityError";
    // Provider errors, malformed JSON and URI errors can contain private input.
    // Retain only this fixed classification, never the caught error or body.
    this.cause = { code: "graph-calendar-identity-unverified", reason,
      ...(status === undefined ? {} : { status }) };
  }
}

function graphCanonicalCalendarBinding(
  link: unknown,
  calendarID: string | null,
  graphBase: string,
  kind: "resource" | "delta",
): GraphCanonicalCalendarBinding | null {
  if (typeof link !== "string" || !link || link.trim() !== link || /[\u0000-\u001f\u007f]/.test(link)) return null;
  try {
    const parsed = new URL(link);
    const base = new URL(`${graphBase}/`);
    const raw = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/.exec(link);
    if (parsed.origin !== base.origin || parsed.protocol !== base.protocol ||
      !["https:", "http:"].includes(base.protocol) || !raw || raw[2] !== parsed.pathname ||
      parsed.username || parsed.password || raw[1]!.includes("@") || link.includes("#") ||
      (kind === "resource" && link.includes("?"))) return null;
    const deltaSuffix = "/calendarView/delta";
    if (kind === "delta" && !parsed.pathname.endsWith(deltaSuffix)) return null;
    const path = kind === "delta" ? parsed.pathname.slice(0, -deltaSuffix.length) : parsed.pathname;
    if (!path.startsWith(base.pathname)) return null;
    const parts = path.slice(base.pathname.length).split("/");
    const decodeKey = (value: string, odata = false): string | null => {
      const decoded = decodeURIComponent(value);
      // OData string keys escape one quote as two, after URI decoding once.
      if (odata && !/^(?:[^']|'')*$/.test(decoded)) return null;
      const key = odata ? decoded.replace(/''/g, "'") : decoded;
      return validGraphId(key) ? key : null;
    };
    const odataKey = (segment: string, collection: string) => {
      const prefix = `${collection}('`;
      return segment.startsWith(prefix) && segment.endsWith("')")
        ? decodeKey(segment.slice(prefix.length, -2), true) : null;
    };
    let ownerParts: number;
    let ownerKind: GraphCanonicalCalendarBinding["ownerKind"];
    let ownerKey: string | null;
    if (parts[0] === "me") { ownerParts = 1; ownerKind = "me"; ownerKey = null; }
    else if (parts[0] === "users" && parts[1] && decodeKey(parts[1]) !== null) {
      ownerParts = 2; ownerKind = "users-segment"; ownerKey = decodeKey(parts[1]);
    }
    else if (parts[0] && odataKey(parts[0], "users") !== null) {
      ownerParts = 1; ownerKind = "users-odata"; ownerKey = odataKey(parts[0], "users");
    }
    else return null;
    const owner = `${base.pathname}${parts.slice(0, ownerParts).join("/")}/`;
    const calendar = parts.slice(ownerParts);
    if (calendar.length === 2 && calendar[0] === "calendars" && calendar[1]) {
      const calendarKey = decodeKey(calendar[1]);
      if (calendarKey !== null && (calendarID === null || calendarKey === calendarID)) {
        return { prefix: `${owner}calendars/`, suffix: "", owner, ownerKey, calendarKey, ownerKind, keyStyle: "segment" };
      }
    }
    if (calendar.length === 1 && calendar[0]) {
      const calendarKey = odataKey(calendar[0], "calendars");
      if (calendarKey !== null && (calendarID === null || calendarKey === calendarID)) {
        return { prefix: `${owner}calendars('`, suffix: "')", owner, ownerKey, calendarKey, ownerKind, keyStyle: "odata" };
      }
    }
    // Default-calendar paths and unknown aliases have no explicit native key.
    return null;
  } catch { return null; }
}

function graphCalendarMetadataProof(value: unknown, calendarID: string, graphBase: string): GraphCalendarIdentityProof {
  const diagnostics: GraphIdentityDiagnostics = {
    canonicalMetadataState: value === undefined ? "absent" : value === null ? "null" :
      typeof value !== "string" ? "non-string" : value.length === 0 ? "empty" : "present",
    canonicalMetadataFailure: "none", canonicalProofOwnerKind: "unknown", canonicalProofKeyStyle: "unknown",
  };
  const result: GraphCalendarIdentityProof = { binding: null, diagnostics, contradictory: false };
  if (typeof value !== "string" || !value) return result;
  try {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { diagnostics.canonicalMetadataFailure = "not-absolute"; return result; }
    const base = new URL(`${graphBase}/`);
    const raw = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/.exec(value);
    if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value) || !raw || raw[2] !== parsed.pathname ||
      parsed.username || parsed.password || raw[1]!.includes("@") || value.includes("#") || value.includes("?")) {
      diagnostics.canonicalMetadataFailure = "unsafe-url"; return result;
    }
    if (parsed.protocol !== base.protocol) { diagnostics.canonicalMetadataFailure = "protocol"; return result; }
    if (parsed.origin !== base.origin) { diagnostics.canonicalMetadataFailure = "origin"; return result; }
    if (!parsed.pathname.startsWith(base.pathname)) { diagnostics.canonicalMetadataFailure = "version"; return result; }
    const binding = graphCanonicalCalendarBinding(value, null, graphBase, "resource");
    if (!binding) { diagnostics.canonicalMetadataFailure = "unsupported-route"; return result; }
    diagnostics.canonicalProofOwnerKind = binding.ownerKind;
    diagnostics.canonicalProofKeyStyle = binding.keyStyle;
    if (binding.calendarKey !== calendarID) {
      diagnostics.canonicalMetadataFailure = "calendar-key-mismatch";
      result.contradictory = true;
    } else result.binding = binding;
    return result;
  } catch { diagnostics.canonicalMetadataFailure = "unsupported-route"; return result; }
}

// Rejection-only diagnostics. A default-calendar route lacks the bound native
// key and remains unauthorized; this classification never decides acceptance.
function graphRejectedDeltaRoute(link: string, calendarID: string, graphBase: string): {
  canonicalCandidateRoute: "explicit-calendar" | "default-calendar" | "unknown";
  canonicalCandidateOwnerKind: GraphCanonicalCalendarBinding["ownerKind"] | "unknown";
} {
  const unknown = { canonicalCandidateRoute: "unknown", canonicalCandidateOwnerKind: "unknown" } as const;
  const explicit = graphCanonicalCalendarBinding(link, calendarID, graphBase, "delta");
  if (explicit) return { canonicalCandidateRoute: "explicit-calendar", canonicalCandidateOwnerKind: explicit.ownerKind };
  try {
    const path = new URL(link).pathname;
    const prefix = new URL(`${graphBase}/`).pathname;
    const suffix = "/calendarView/delta";
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return unknown;
    let owner = path.slice(prefix.length, -suffix.length);
    if (owner.endsWith("/calendar")) owner = owner.slice(0, -"/calendar".length);
    if (owner === "me") return { canonicalCandidateRoute: "default-calendar", canonicalCandidateOwnerKind: "me" };
    const parts = owner.split("/");
    if (parts.length === 2 && parts[0] === "users" && validGraphId(decodeURIComponent(parts[1]!))) {
      return { canonicalCandidateRoute: "default-calendar", canonicalCandidateOwnerKind: "users-segment" };
    }
    if (parts.length === 1 && owner.startsWith("users('") && owner.endsWith("')")) {
      const key = decodeURIComponent(owner.slice("users('".length, -2));
      if (/^(?:[^']|'')*$/.test(key) && validGraphId(key.replace(/''/g, "'"))) {
        return { canonicalCandidateRoute: "default-calendar", canonicalCandidateOwnerKind: "users-odata" };
      }
    }
    return unknown;
  } catch { return unknown; }
}

async function readGraphCalendarIdentityProof(
  accessToken: string,
  calendarID: string,
  graphBase: string,
  fetchImpl: typeof fetch,
): Promise<GraphCalendarIdentityProof> {
  let response: Response;
  try {
    // Only this constructed, bound-calendar address can supply identity proof.
    // Never probe a rejected continuation or derive a user key from OAuth sub.
    response = await observedProviderRequest(fetchImpl,
      `${graphBase}/me/calendars/${encodeURIComponent(calendarID)}`, {
        method: "GET", redirect: "error",
        headers: { Authorization: `Bearer ${accessToken}`, Prefer: PREFER,
          Accept: "application/json;odata.metadata=full", "Cache-Control": "no-cache" },
      });
  } catch { throw new GraphCalendarIdentityError("request"); }
  if (response.status !== 200 || response.redirected) throw new GraphCalendarIdentityError("response", response.status);
  try { assertCompleteEventReadResponse(response); }
  catch { throw new GraphCalendarIdentityError("response", response.status); }
  let data: any;
  try { data = await response.json(); }
  catch { throw new GraphCalendarIdentityError("body", response.status); }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.id !== calendarID ||
    data.value !== undefined || data["@removed"] !== undefined || data["@odata.nextLink"] !== undefined ||
    data["@odata.deltaLink"] !== undefined ||
    (data["@odata.type"] !== undefined && data["@odata.type"] !== "#microsoft.graph.calendar")) {
    throw new GraphCalendarIdentityError("body", response.status);
  }
  const proof = graphCalendarMetadataProof(data["@odata.id"], calendarID, graphBase);
  if (proof.contradictory) {
    const error = new GraphCalendarIdentityError("canonical-resource", response.status);
    Object.assign(error.cause, proof.diagnostics);
    throw error;
  }
  return proof;
}

async function readGraphPrincipalID(accessToken: string, graphBase: string, fetchImpl: typeof fetch): Promise<string> {
  let response: Response;
  try {
    // A fresh authenticated /me response supplies the Graph key. OAuth sub,
    // tenant guesses, email labels and rejected user URLs are never probes.
    response = await observedProviderRequest(fetchImpl, `${graphBase}/me?$select=id`, {
      method: "GET", redirect: "error",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "Cache-Control": "no-cache" },
    });
  } catch { throw new GraphCalendarIdentityError("principal-request"); }
  if (response.status !== 200 || response.redirected) throw new GraphCalendarIdentityError("principal-response", response.status);
  try { assertCompleteEventReadResponse(response); }
  catch { throw new GraphCalendarIdentityError("principal-response", response.status); }
  let data: any;
  try { data = await response.json(); }
  catch { throw new GraphCalendarIdentityError("principal-body", response.status); }
  if (!data || typeof data !== "object" || Array.isArray(data) || !validGraphId(data.id) ||
    data.value !== undefined || data["@removed"] !== undefined || data["@odata.nextLink"] !== undefined ||
    data["@odata.deltaLink"] !== undefined ||
    (data["@odata.type"] !== undefined && data["@odata.type"] !== "#microsoft.graph.user")) {
    throw new GraphCalendarIdentityError("principal-body", response.status);
  }
  return data.id;
}

function assertActiveGraphItem(item: any, expectedID?: string) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !validGraphId(item.id) ||
    (expectedID !== undefined && item.id !== expectedID) || item["@removed"] ||
    item["@odata.nextLink"] !== undefined || item["@odata.deltaLink"] !== undefined ||
    !validGraphDateTime(item.start?.dateTime) || !validGraphDateTime(item.end?.dateTime) ||
    (item.isAllDay ? parseGraphDate(item.start.dateTime) >= parseGraphDate(item.end.dateTime)
      : parseGraphDate(item.start.dateTime) > parseGraphDate(item.end.dateTime))) {
    throw new Error("Outlook returned an invalid event read.");
  }
}

function validGraphDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/i.exec(value);
  if (!parts || !Number.isFinite(parseGraphDate(value).getTime())) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  calendar.setUTCHours(hour!, minute!, second!, 0);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month &&
    calendar.getUTCDate() === day && calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute && calendar.getUTCSeconds() === second;
}

async function assertExactGraphMissing(response: Response) {
  if (response.status !== 404 || response.headers.has("content-range") || response.redirected) {
    throw new Error("Outlook event absence could not be verified.");
  }
  const error = await response.json();
  // Unknown/masked error codes remain ambiguous even when HTTP says 404.
  if (!error || typeof error !== "object" || error.error?.code !== "ErrorItemNotFound") {
    throw new Error("Outlook event absence could not be verified.");
  }
}

async function graphGet(
  accessToken: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Response> {
  return observedProviderRequest(fetchImpl, url, {
    signal,
    redirect: "error",
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
  // Even 404/410 on an active occurrence's dependency is ambiguous. Never
  // advance past an
  // incomplete hydration or cache an error as a successful empty master.
  await assertCompleteGraphRead(res);
  const master = await res.json();
  if (!master || master.id !== id || master["@removed"] || master["@odata.nextLink"]) {
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
    knownEventIDs?: readonly string[];
    microsoftReadAuthorityVerified?: boolean;
  } = {},
): Promise<FetchChangesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphBase = options.graphBase ?? GRAPH;
  const now = options.now ?? Date.now();
  if (!validGraphId(externalCalendarId) || !Number.isSafeInteger(now))
    throw new Error("Outlook returned an invalid calendar read scope.");
  const changes: NormalizedChange[] = [];
  const excludedEvents = new Set(options.excludedEventIDs ?? []);
  const excludedSeries = new Set(options.excludedSeriesIDs ?? []);
  const knownEvents = new Set(options.knownEventIDs ?? []);
  let calendarIdentityProof: Promise<GraphCalendarIdentityProof> | undefined;
  let principalIdentity: Promise<string> | undefined;
  const assertReadDeltaLink = async (link: unknown, kind: "cursor" | "request" | "next" | "delta") => {
    try { return assertDeltaLink(link, externalCalendarId, graphBase, kind); }
    catch (error) {
      const candidate = graphCanonicalCalendarBinding(link, externalCalendarId, graphBase, "delta");
      if (!candidate) throw error;
      // Fresh for each reader invocation and the same token/source generation.
      // This binds only the calendar address, never private-read/deletion rights.
      let proof: GraphCalendarIdentityProof | undefined;
      let principalMatches: boolean | null = null;
      try {
        proof = await (calendarIdentityProof ??= readGraphCalendarIdentityProof(
          accessToken, externalCalendarId, graphBase, fetchImpl));
        // This constructed read directly proves the same token's /me key.
        // Optional canonical metadata contributes no authority to this rule.
        if (candidate.ownerKind === "me") return link as string;
        const proven = proof.binding;
        if (proven && candidate.prefix === proven.prefix && candidate.suffix === proven.suffix) return link as string;
        const principal = await (principalIdentity ??= readGraphPrincipalID(accessToken, graphBase, fetchImpl));
        principalMatches = candidate.ownerKey === principal;
        if (principalMatches) return link as string;
        const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
        if (cause && typeof cause === "object") Object.assign(cause, {
          ...proof.diagnostics, canonicalCandidateOwnerKind: candidate.ownerKind,
          canonicalCandidateKeyStyle: candidate.keyStyle, principalMatches,
          canonicalOwnerMatches: proven ? candidate.owner === proven.owner : null,
          canonicalKeyStyleMatches: proven ? candidate.keyStyle === proven.keyStyle : null,
        });
        throw error;
      } catch (identityError) {
        if (identityError instanceof GraphCalendarIdentityError) {
          // Fixed classifications survive every failed proof, including before
          // optional metadata is available. Never attach the URI or provider ID.
          Object.assign(identityError.cause, proof?.diagnostics ?? {
            canonicalMetadataState: "not-evaluated", canonicalMetadataFailure: "not-evaluated",
            canonicalProofOwnerKind: "unknown", canonicalProofKeyStyle: "unknown",
            ...identityError.cause,
          }, { canonicalCandidateRoute: "explicit-calendar", canonicalCandidateOwnerKind: candidate.ownerKind,
            canonicalCandidateKeyStyle: candidate.keyStyle, principalMatches });
        }
        throw identityError;
      }
    }
  };

  let parsed = parseCursor(cursor);
  if (parsed && parsed.calendarId !== externalCalendarId) parsed = null;
  if (parsed && parsed.windowEnd - now < WINDOW_RENEW_MARGIN_DAYS * DAY_MS) parsed = null;
  // Unsafe cursors are never fetched. Canonical cursors require a fresh proof
  // from the constructed bound-calendar endpoint before sending credentials.
  if (parsed) {
    try { await assertReadDeltaLink(parsed.link, "cursor"); }
    catch (error) {
      // Unavailable proof is a failed read, not permission to replace a window.
      if (error instanceof GraphCalendarIdentityError) throw error;
      parsed = null;
    }
  }
  let reset = !parsed;
  let windowStart = parsed?.windowStart ?? now - WINDOW_PAST_DAYS * DAY_MS;
  let windowEnd = parsed?.windowEnd ?? now + WINDOW_FUTURE_DAYS * DAY_MS;
  let url = parsed?.link ?? initialDeltaUrl(externalCalendarId, windowStart, windowEnd, graphBase);
  let deltaLink: string | null = null;
  const seriesMasters = new Map<string, any>();
  const visited = new Set<string>();
  let restarted = false;
  let pages = 0;

  const normalize = async (input: any, forceOccurrenceIdentity = false): Promise<NormalizedEvent> => {
    let item = input;
    assertActiveGraphItem(item);
    if (item.seriesMasterId != null) {
      if (!validGraphId(item.seriesMasterId) || item.seriesMasterId === item.id)
        throw new Error("Outlook returned an invalid source series address.");
      const master = await fetchSeriesMaster(accessToken, externalCalendarId, item.seriesMasterId,
        seriesMasters, fetchImpl, graphBase);
      if (options.timeModels || options.rsvpOccurrences || forceOccurrenceIdentity) {
        if (!item.originalStart || item.type === "exception") {
          const response = await graphGet(accessToken,
            `${graphBase}${microsoftEventPath(externalCalendarId, item.id)}?$select=*,originalStart`, fetchImpl);
          await assertCompleteGraphRead(response);
          const instance = await response.json();
          assertActiveGraphItem(instance, item.id);
          if (instance.seriesMasterId !== item.seriesMasterId)
            throw new Error("Outlook returned an invalid occurrence dependency.");
          item = { ...item, ...instance };
        }
        if (!validGraphDateTime(item.originalStart) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(item.originalStart) ||
          /\.\d{3}\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/i.test(item.originalStart))
          throw new Error("Outlook occurrence identity requires an exact millisecond UTC instant.");
        const originalStart = OccurrenceStartSchema.parse({ kind: "instant", value: parseGraphDate(item.originalStart).toISOString() });
        item = { ...master, ...item, "@odata.etag": item["@odata.etag"] ?? null,
          providerOccurrence: { externalSeriesID: item.seriesMasterId, originalStart } };
      } else {
        // A master validator never authorizes an instance write, even with edits disabled.
        item = { ...master, ...item, "@odata.etag": item["@odata.etag"] ?? null };
      }
    }
    const event = toNormalized(item);
    if (options.organizerEventIDs?.includes(item.id)) {
      const time = graphRsvpTime({ ...item, isCancelled: false });
      event.start = time.start; event.end = time.end; event.isAllDay = time.isAllDay; event.timeModel = time.timeModel;
      if (item.isCancelled) event.status = "cancelled";
    }
    if (item.seriesMasterId != null) event.sourceSeriesID = item.seriesMasterId;
    if (options.timeModels || options.rsvpOccurrences || forceOccurrenceIdentity) {
      event.providerOccurrence = item.providerOccurrence;
      if (item.isCancelled) event.status = "cancelled";
    }
    return event;
  };

  const removal = async (id: string): Promise<NormalizedChange> => {
    const absence: NormalizedChange = { kind: "event-absence", externalId: id, reason: "window-removal" };
    // A grant restricted to basic/private-redacted data cannot prove that a
    // previously visible item was deleted. Preserve its binding and intents.
    if (!knownEvents.has(id) || options.microsoftReadAuthorityVerified !== true) return absence;
    const eventURL = `${graphBase}${microsoftEventPath(externalCalendarId, id)}`;
    const first = await graphGet(accessToken, eventURL, fetchImpl);
    if (first.status !== 404) {
      await assertCompleteGraphRead(first);
      const event = await first.json();
      assertActiveGraphItem(event, id);
      // A definition is not a single expanded instance. A separately tracked
      // full-family reader owns it; never flatten its RRULE on point recovery.
      if (event.type === "seriesMaster") return absence;
      return { kind: "event", data: await normalize(event, true) };
    }
    await assertExactGraphMissing(first);
    const calendarResponse = await graphGet(accessToken,
      `${graphBase}/me/calendars/${encodeURIComponent(externalCalendarId)}?$select=id,canViewPrivateItems`, fetchImpl);
    await assertCompleteGraphRead(calendarResponse);
    const calendar = await calendarResponse.json();
    if (!calendar || calendar.id !== externalCalendarId || calendar.canViewPrivateItems !== true || calendar["@removed"] !== undefined ||
      calendar["@odata.nextLink"] !== undefined || calendar["@odata.deltaLink"] !== undefined)
      throw new Error("Outlook calendar read authority could not be verified.");
    await assertExactGraphMissing(await graphGet(accessToken, eventURL, fetchImpl));
    return { ...absence, deletionEvidence: { kind: "scoped-native-absence", responseStatus: 404,
      readAuthorityVerified: true, nativeReadProfile: "graph-event-double-404-calendar-v1" } };
  };

  while (!deltaLink) {
    await assertReadDeltaLink(url, "request");
    const key = new URL(url).href;
    if (visited.has(key) || ++pages > 1000) throw new Error("Outlook returned a cyclic or excessive delta page set.");
    visited.add(key);
    const res = await graphGet(accessToken, url, fetchImpl);
    if (res.status === 410) {
      if (restarted || !parsed) throw new Error("Outlook rejected the initial calendar window.");
      restarted = true;
      reset = true;
      changes.length = 0;
      seriesMasters.clear();
      visited.clear();
      windowStart = now - WINDOW_PAST_DAYS * DAY_MS;
      windowEnd = now + WINDOW_FUTURE_DAYS * DAY_MS;
      url = initialDeltaUrl(externalCalendarId, windowStart, windowEnd, graphBase);
      continue;
    }
    await assertCompleteGraphRead(res);
    const data = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.value))
      throw new Error("Outlook returned an invalid delta page.");
    const hasNext = data["@odata.nextLink"] !== undefined;
    const hasDelta = data["@odata.deltaLink"] !== undefined;
    if (hasNext === hasDelta) throw new Error("Outlook returned an unfinished or ambiguous delta page.");
    const continuation = await assertReadDeltaLink(data[hasNext ? "@odata.nextLink" : "@odata.deltaLink"],
      hasNext ? "next" : "delta");
    for (const item of data.value) {
      if (!item || typeof item !== "object" || Array.isArray(item) || !validGraphId(item.id))
        throw new Error("Outlook returned an invalid delta event address.");
      // Full native families are reconciled separately, including their explicit missing proof.
      if (excludedEvents.has(item.id) || excludedSeries.has(item.seriesMasterId)) continue;
      if (item["@removed"] !== undefined) {
        if (!item["@removed"] || typeof item["@removed"] !== "object" || Array.isArray(item["@removed"]) ||
          item["@removed"].reason !== "deleted") throw new Error("Outlook returned an invalid window removal.");
        changes.push(await removal(item.id));
      } else if (item.type !== "seriesMaster") {
        changes.push({ kind: "event", data: await normalize(item) });
      }
    }
    if (hasNext) url = continuation;
    else deltaLink = continuation;
  }

  return {
    changes,
    nextCursor: JSON.stringify({ version: 2, calendarId: externalCalendarId, link: deltaLink, windowStart, windowEnd } satisfies MicrosoftWindowCursor),
    reset: false,
    cursorRestarted: reset,
    coverage: { kind: "window", fromInclusive: new Date(windowStart).toISOString(),
      untilExclusive: new Date(windowEnd).toISOString(), complete: true },
  };
}

type GraphCalendar = {
  isDefaultCalendar?: boolean | null;
  id: string;
  name: string;
  hexColor?: string | null;
  canEdit?: boolean | null;
  canViewPrivateItems?: boolean | null;
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

/** No inventory authority escapes until every page has completed validation. */
export async function fetchMicrosoftCalendars(
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<ExternalCalendarInfo[]> {
  const calendars: ExternalCalendarInfo[] = [];
  let url: string | null =
    `${GRAPH}/me/calendars?$select=id,name,hexColor,canEdit,canViewPrivateItems,isDefaultCalendar&$top=${PAGE_SIZE}`;
  let requestPhase: GraphCalendarDiscoveryPhase = "initial";
  const inventory = graphDiscoveryInventory("events", url);
  while (url) {
    const res = await graphGet(accessToken, inventory.visit(url), fetchImpl);
    if (!res.ok) throw await graphCalendarDiscoveryHttpError(res, requestPhase);
    const page = await inventory.page(res);
    for (const c of page.items) calendars.push(toExternalCalendar(c));
    url = page.nextLink;
    requestPhase = "next-page";
  }
  return calendars;
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
          const res = await observedProviderFetch(`${GRAPH}/me`, {
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
    let calendars: ExternalCalendarInfo[];
    let eventDiscovery: { eventCalendarsComplete: true } | { eventCalendarsComplete: false; eventCalendarDiscoveryError: Error } = { eventCalendarsComplete: true };
    try { calendars = await fetchMicrosoftCalendars(accessToken); }
    catch (error) {
      if (!isMicrosoftEventMailboxUnavailable(error)) throw error;
      calendars = [];
      eventDiscovery = { eventCalendarsComplete: false, eventCalendarDiscoveryError: error };
      logger.warn("sync.events.discovery_unavailable", { provider: "microsoft", userId: userID, accountId, error });
    }
    if (!(await hasOAuthTaskScope(userID, "microsoft", accountId))) {
      return { calendars, taskListsComplete: false, ...eventDiscovery };
    }
    try {
      const taskLists = await fetchMicrosoftTaskLists(accessToken);
      return {
        calendars: [
          ...calendars,
          ...taskLists.map(toExternalMicrosoftTaskList),
        ],
        taskListsComplete: true,
        ...eventDiscovery,
      };
    } catch (error) {
      if (!isOptionalTaskError(error)) throw error;
      logger.warn("sync.tasks.discovery_unavailable", {
        provider: "microsoft",
        userId: userID,
        accountId,
      });
      return { calendars, taskListsComplete: false, ...eventDiscovery };
    }
  },

  async fetchChanges(
    userID,
    accountId,
    externalCalendarId,
    cursor,
    options,
  ): Promise<FetchChangesResult> {
    const exclusions = {
      excludedEventIDs: [...(options?.excludedEventIDs ?? [])],
      excludedSeriesIDs: [...(options?.excludedSeriesIDs ?? [])],
      knownEventIDs: [...(options?.knownEventIDs ?? [])],
      microsoftReadAuthorityVerified: options?.microsoftReadAuthorityVerified,
    };
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
    const permission = await observedProviderFetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarID)}?$select=id,canEdit`, { headers: { Authorization: `Bearer ${accessToken}`, "Cache-Control": "no-cache" }, redirect: "error", signal: identity.signal });
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
    if (operation.action === "update" && operation.external) assertMicrosoftPersonalContentPatch(operation.patch);
    const accessToken = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    if (operation.action !== "create" && operation.external) {
      await assertMicrosoftPersonalContent({ token: accessToken, calendarID: externalCalendarId, eventID: operation.external.externalEventId, etag: operation.external.etag, signal: operation.signal }, operation.action);
      return;
    }
    const headers = { Authorization: `Bearer ${accessToken}` };
    const response = await observedProviderFetch(
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
      const response: Response = await observedProviderFetch(url, {
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
    nativePlan,
  ) {
    if (event.recurrence) {
      throw new EventWriteError(
        "recurrence",
        "unsupported",
        "Outlook recurrence creation is not supported yet. No changes were saved.",
      );
    }
    const accessToken = await getAccessToken(userID, accountId);
    const res = await observedProviderFetch(
      `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nativePlan ? pinnedJsonBodyV1(nativePlan) : {
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
    const response = await observedProviderFetch(`${GRAPH}${microsoftEventPath(externalCalendarId, ref.externalEventId)}`, {
      headers: { Authorization: `Bearer ${token}`, Prefer: PREFER, "Cache-Control": "no-cache" }, redirect: "error", signal,
    });
    if (response.status === 404) return null;
    assertCompleteEventReadResponse(response);
    const data = await response.json();
    if (data?.id !== ref.externalEventId) throw new ProviderEventWriteError("provider-conflict");
    const event = assertCreatedEventEvidence(toNormalized(data));
    return { event, ref: { externalEventId: data.id, etag: microsoftEventVersion(data["@odata.etag"]) } };
  },

  async pushUpdate(userID, accountId, externalCalendarId, externalEventId, _event, ref, patch, signal, nativePlan) {
    assertMicrosoftPersonalContentPatch(patch);
    if (!ref || ref.externalEventId !== externalEventId || !microsoftEventVersion(ref.etag)) throw new ProviderEventWriteError("provider-version-unavailable");
    const token = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    return updateMicrosoftPersonalContent({ token, calendarID: externalCalendarId, eventID: externalEventId, etag: ref.etag, signal }, patch,
      nativePlan ? pinnedJsonBodyV1(nativePlan) : undefined);
  },

  async pushDelete(userID, accountId, externalCalendarId, externalEventId, ref, signal) {
    if (!ref || ref.externalEventId !== externalEventId || !microsoftEventVersion(ref.etag)) throw new ProviderEventWriteError("provider-version-unavailable");
    const token = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    await deleteMicrosoftPersonalEvent({ token, calendarID: externalCalendarId, eventID: externalEventId, etag: ref.etag, signal });
  },

  projectTask: toGraphTask,

  async readTask(userID, accountId, externalCalendarId, ref, signal) {
    const list = microsoftTaskListId(externalCalendarId);
    if (!list) throw new ProviderTaskWriteError("task-source-read-only");
    const response = await graphGet(await getAccessToken(userID, accountId, true, signal), `${GRAPH}${microsoftTaskPath(list, ref.externalTaskId)}`, fetch, signal);
    if (response.status === 404 || response.status === 410) return null;
    assertTaskReadResponse(response);
    const value = await response.json();
    if (value.id !== ref.externalTaskId || typeof value.title !== "string") throw new ProviderTaskWriteError("task-projection-unavailable");
    return { ref: { externalTaskId: value.id, etag: value["@odata.etag"] ?? null, icalUid: null }, projection: toGraphTask({ ...toNormalizedMicrosoftTask(value), id: value.id, creatorID: userID, calendarID: "" }) };
  },

  async assertTaskWrite(userID, accountId, externalCalendarId, operation) {
    const list = microsoftTaskListId(externalCalendarId);
    if (!list) throw new ProviderTaskWriteError("task-source-read-only");
    const response = await graphGet(await getAccessToken(userID, accountId, true, operation.signal), `${GRAPH}/me/todo/lists/${encodeURIComponent(list)}`, fetch, operation.signal);
    assertTaskReadResponse(response);
    const nativeList = await response.json();
    if (nativeList.id !== list) throw new ProviderTaskWriteError("task-projection-unavailable");
    if (operation.secondary && nativeList.isOwner !== true) throw new ProviderTaskWriteError("task-source-read-only");
    // To Do exposes weak @odata.etag, but its v1.0 update/delete contract does
    // not document a conditional-write guarantee. New fanout must not mistake
    // preflight for CAS; existing legacy single-source methods stay separate.
    if (operation.secondary) throw new ProviderTaskWriteError("task-conditional-write-unsupported");
    if (operation.action !== "create") {
      if (!operation.external?.etag) throw new ProviderTaskWriteError("task-version-unavailable");
      const current = await microsoftAdapter.readTask!(userID, accountId, externalCalendarId, operation.external, operation.signal);
      if (!current && operation.action === "delete") return;
      if (!current || current.ref.etag !== operation.external.etag) throw new ProviderTaskWriteError("task-provider-conflict");
    }
  },

  async pushTaskCreate(userID, accountId, externalCalendarId, task, beforeMutation, signal, nativePlan) {
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (!taskListId)
      throw new Error("Microsoft task write requires a task list");
    return createMicrosoftTask(
      await getAccessToken(userID, accountId, true, signal),
      taskListId,
      task,
      { beforeMutation, signal, nativePlan },
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
    signal,
    nativePlan,
  ) {
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (!taskListId)
      throw new Error("Microsoft task write requires a task list");
    return updateMicrosoftTask(
      await getAccessToken(userID, accountId, true, signal),
      taskListId,
      externalTaskId,
      task,
      ref?.etag,
      { patch, beforeMutation: ref?.beforeMutation, signal, nativePlan },
    );
  },

  async pushTaskDelete(
    userID,
    accountId,
    externalCalendarId,
    externalTaskId,
    ref,
    signal,
  ) {
    const taskListId = microsoftTaskListId(externalCalendarId);
    if (!taskListId)
      throw new Error("Microsoft task write requires a task list");
    await deleteMicrosoftTask(
      await getAccessToken(userID, accountId, true, signal),
      taskListId,
      externalTaskId,
      ref?.etag,
      { beforeMutation: ref?.beforeMutation, signal },
    );
  },

  async createCalendar(userID, accountId, { name, color }) {
    // Graph only accepts preset color names (hexColor is read-only) — map to
    // the nearest preset. The client offers exactly these presets for Outlook
    // calendars, so this is normally an exact match.
    const accessToken = await getAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "microsoft", accountId);
    const res = await observedProviderFetch(`${GRAPH}/me/calendars`, {
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
      const res = await observedProviderFetch(
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
    const res = await observedProviderFetch(
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
    const res = await observedProviderFetch(
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
  windowStart: number,
  windowEnd: number,
  graphBase = GRAPH,
): string {
  const start = new Date(windowStart).toISOString();
  const end = new Date(windowEnd).toISOString();
  return `${graphBase}/me/calendars/${encodeURIComponent(externalCalendarId)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
}
