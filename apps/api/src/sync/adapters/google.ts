import { googleOrganizerTransport } from "./google_organizer_delivery";
import { googleReminderInstanceTransport } from "./google_reminder_instance";
import { googleRsvpMethods } from "./google_rsvp_delivery";
import { googleOccurrenceMethods } from "./google_occurrence";
import { googleEventState } from "./provider_event_state";
import { normalizeGoogleTime } from "./google_time";
import { config, logger } from "@musubi/config";
import {
  getOAuthAccountIDs,
  getGoogleOrganizerTimeEventIDs,
  hasOAuthTaskScope,
  type EventContentPatch,
} from "@musubi/db";
import { EventWriteError, GoogleReminderWriteSchema, DEFAULT_CALENDAR_COLOR } from "@musubi/types";
import type { Event, Task } from "@musubi/types";
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
import { assertCompleteEventReadResponse, assertCreatedEventEvidence, eventCreateOperationID, googleEventCreateID } from "../event_create_identity";
import { isOptionalTaskError, ProviderAuthError, TaskScopeMissingError } from "../errors";
import {
  assertEventWriteEvidence,
  assertEventWriteResponse,
  assertOAuthEventWriteGrant,
  assertAcceptedEventEtag,
  assertProviderEventMutationResponse,
  requireEventEtag,
  requireEventPatch,
  strongEventEtag,
  ProviderEventWriteError,
} from "../event_write";

const GCAL = "https://www.googleapis.com/calendar/v3";
const GTASKS = "https://tasks.googleapis.com/tasks/v1";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TASK_LIST_PREFIX = "musubi-google-task-list:";

export function googleTaskListExternalId(taskListId: string) {
  return `${TASK_LIST_PREFIX}${taskListId}`;
}

function googleTaskListId(externalCalendarId: string) {
  return externalCalendarId.startsWith(TASK_LIST_PREFIX)
    ? externalCalendarId.slice(TASK_LIST_PREFIX.length)
    : null;
}

// Error with Google's own message when available ("Cannot delete primary
// calendar", …) — status text alone is useless to the user.
async function googleError(res: Response): Promise<Error> {
  let detail = res.statusText;
  try {
    detail = (await res.json())?.error?.message ?? detail;
  } catch {
    /* keep statusText */
  }
  return new Error(`Google ${res.status}: ${detail}`);
}

// Calendar color lives on the per-user calendarList entry, not the calendar
// resource itself; colorRgbFormat=true accepts plain hex.
async function patchCalendarColor(
  accessToken: string,
  calendarId: string,
  color: string,
) {
  const res = await fetch(
    `${GCAL}/users/me/calendarList/${encodeURIComponent(calendarId)}?colorRgbFormat=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        backgroundColor: color,
        foregroundColor: "#000000",
      }),
    },
  );
  if (!res.ok) throw await googleError(res);
}

export async function getGoogleAccessToken(
  userID: string,
  accountId: string,
  requireTasks = false,
  rejectedAccessToken?: string,
) {
  const accessToken = await getOAuthAccessToken("google", userID, accountId, {
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    clientId: config.social.googleWebClientID,
    clientSecret: config.social.googleClientSecret,
    subtypeKey: "error_subtype",
  }, { rejectedAccessToken });
  // Refresh may return a narrower grant. Check after minting, before any Tasks
  // endpoint, including task writes that bypass discovery.
  if (requireTasks && !(await hasOAuthTaskScope(userID, "google", accountId)))
    throw new TaskScopeMissingError();
  return accessToken;
}

// Recover the concrete rejected read once. Never wrap a mutation: a retry of
// POST/PATCH/DELETE could duplicate an effect whose outcome was not observed.
function googleReadFetch(userID: string, accountId: string, initialToken: string, requireTasks = false): typeof fetch {
  let accessToken = initialToken;
  return async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new Error("Google authentication recovery only supports GET");
    const request = () => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return fetch(input, { ...init, headers });
    };
    const response = await request();
    if (response.status !== 401) return response;
    await response.body?.cancel();
    accessToken = await getGoogleAccessToken(userID, accountId, requireTasks, accessToken);
    const retried = await request();
    if (retried.status !== 401) return retried;
    await retried.body?.cancel();
    // Invalid access alone does not prove the refresh grant is revoked.
    throw new ProviderAuthError("google", "resource_401", undefined, false);
  };
}

// "What UTC instant is <local wall-clock time> in <tz>?" — via Intl, no tz lib.
// ponytail: single-iteration approximation; can be 1h off in the hour around a
// DST transition. Good enough for exception stamps.
function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(guess)).map((x) => [x.type, x.value]),
  );
  const wallAtGuess = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +p.hour % 24,
    +p.minute,
    +p.second,
  );
  return new Date(guess - (wallAtGuess - guess));
}

const toICalUTC = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

// Normalize Google's recurrence lines into what our expansion (rrule lib)
// provably handles — verified empirically:
//  - EXDATE;TZID=…  → silently IGNORED by rrule → convert to UTC EXDATE here
//  - EXDATE;VALUE=DATE:… → works (all-day, UTC-midnight anchors) → keep
//  - FREQ=YEARLY;BYMONTHDAY without BYMONTH → RFC expands monthly → anchor month
function sanitizeRecurrence(recurrence: string, start: Date): string {
  return recurrence
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (/^(RRULE:)?FREQ=/.test(line)) {
        if (
          /FREQ=YEARLY/.test(line) &&
          /BYMONTHDAY=/.test(line) &&
          !/BYMONTH=/.test(line)
        ) {
          return `${line};BYMONTH=${start.getUTCMonth() + 1}`;
        }
        return line;
      }
      const m = line.match(/^EXDATE;TZID=([^:;]+):(.+)$/i);
      if (m) {
        const [, tz, vals] = m;
        const utc = vals.split(",").map((v) => {
          const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
          return t
            ? toICalUTC(
                zonedToUtc(+t[1], +t[2], +t[3], +t[4], +t[5], +t[6], tz),
              )
            : v;
        });
        return `EXDATE:${utc.join(",")}`;
      }
      return line;
    })
    .join("\n");
}

// Google event JSON -> NormalizedEvent
function toNormalized(item: any, observedAccessRole?: string): NormalizedEvent {
  if (item.status === "cancelled") {
    return {
      externalId: item.id,
      etag: strongEventEtag(item.etag),
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

  const isAllDay = !item.start.dateTime;
  const start = new Date(item.start.dateTime ?? item.start.date);
  const end = isAllDay
    ? new Date(new Date(item.end.date).getTime() - 86400000) // -1 day, Google end.date is exclusive
    : new Date(item.end.dateTime);

  return {
    externalId: item.id,
    etag: strongEventEtag(item.etag),
    status: "active",
    providerState: googleEventState(item),
    creationOperationID: typeof item.extendedProperties?.private?.musubiOperationID === "string" ? item.extendedProperties.private.musubiOperationID : undefined,
    // An Events.list restricted private shell has no title or organizer. Keep
    // ordinary untitled events unchanged, including full-grant/private reads.
    title: item.summary ?? (
      (observedAccessRole === "reader" || observedAccessRole === "writerWithoutPrivateAccess") &&
      item.visibility === "private" && item.organizer == null ? "Busy" : "(untitled)"
    ),
    start,
    end,
    isAllDay,
    description: item.description ?? null,
    location: item.location ?? null,
    organizer: item.organizer?.email ?? null,
    recurrence: item.recurrence
      ? sanitizeRecurrence(item.recurrence.join("\n"), start)
      : null,
    // NOT htmlLink — that's just "open in Google Calendar" noise on every event.
    // Meet link / source url are actual event URLs.
    url: item.hangoutLink ?? item.source?.url ?? null,
  };
}

// Google wants iCal lines with prefixes; our bare "FREQ=..." needs one.
// All-day series use DATE-typed dtstart, so EXDATE/UNTIL must be dates too
// (RFC 5545: exception/until value type must match DTSTART's).
function toGoogleRecurrence(recurrence: string, isAllDay: boolean): string[] {
  return recurrence
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (!/^(RRULE|EXDATE|RDATE|EXRULE)/.test(line)) line = `RRULE:${line}`;
      if (!isAllDay) return line;
      if (/^EXDATE:/.test(line)) {
        const dates = line
          .slice("EXDATE:".length)
          .split(",")
          .map((v) => v.slice(0, 8));
        return `EXDATE;VALUE=DATE:${dates.join(",")}`;
      }
      return line.replace(/UNTIL=(\d{8})T\d{6}Z?/, "UNTIL=$1");
    });
}

// Musubi Event -> Google event JSON
function toGoogleEvent(event: Event) {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    // null (not undefined) so a removed recurrence clears on PATCH.
    recurrence: event.recurrence
      ? toGoogleRecurrence(event.recurrence, event.isAllDay)
      : null,
    start: event.isAllDay
      ? { date: event.start.toISOString().slice(0, 10) }
      : { dateTime: event.start.toISOString() },
    end: event.isAllDay
      ? {
          date: new Date(event.end.getTime() + 86400000)
            .toISOString()
            .slice(0, 10),
        } // +1 day, Google exclusive
      : { dateTime: event.end.toISOString() },
  };
}

/** Calendar PATCH preserves omitted properties (including HTML and rich provider state). */
function toGoogleEventPatch(
  event: Event,
  patch: EventContentPatch | undefined,
) {
  const diff = requireEventPatch(patch);
  const next = { ...event, ...diff };
  const full = toGoogleEvent(next);
  const result: Record<string, unknown> = {};
  for (const [field, property] of [
    ["title", "summary"],
    ["description", "description"],
    ["location", "location"],
    ["recurrence", "recurrence"],
    ["start", "start"],
    ["end", "end"],
  ] as const) {
    if (diff[field] !== undefined) result[property] = full[property];
  }
  if (diff.isAllDay !== undefined) {
    result.start = full.start;
    result.end = full.end;
    if (next.recurrence) result.recurrence = full.recurrence;
  }
  return result;
}

function googleTaskDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toNormalizedGoogleTask(item: any): NormalizedTask {
  const completed = item.status === "completed";
  return {
    completedAt: googleTaskDate(item.completed),
    deleted: item.deleted === true,
    description: item.notes ?? null,
    due: googleTaskDate(item.due),
    etag: item.etag ?? null,
    externalId: item.id,
    icalUid: null,
    isAllDay: Boolean(item.due),
    percentComplete: completed ? 100 : 0,
    priority: 0,
    recurrence: null,
    relatedTo: item.parent ?? null,
    sequence: 0,
    start: null,
    status: completed ? "completed" : "needs-action",
    title: item.title ?? "(untitled)",
    url: item.links?.find((link: any) => link?.link)?.link ?? null,
  };
}

export function toGoogleTask(task: Task) {
  return {
    due: task.due?.toISOString() ?? null,
    notes: task.description ?? null,
    status: task.status === "completed" ? "completed" : "needsAction",
    title: task.title,
  };
}

type GoogleTaskRequestOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export async function createGoogleTask(
  accessToken: string,
  taskListId: string,
  task: Task,
  options: GoogleTaskRequestOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GTASKS;
  const res = await fetchImpl(
    `${baseUrl}/lists/${encodeURIComponent(taskListId)}/tasks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(toGoogleTask(task)),
    },
  );
  if (!res.ok) throw await googleError(res);
  const created = await res.json();
  return {
    etag: created.etag ?? null,
    externalTaskId: created.id,
    icalUid: null,
  };
}

export async function updateGoogleTask(
  accessToken: string,
  taskListId: string,
  externalTaskId: string,
  task: Task,
  etag: string | null | undefined,
  options: GoogleTaskRequestOptions = {},
) {
  if (!etag) throw new Error("Google task update requires an ETag");
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GTASKS;
  const res = await fetchImpl(
    `${baseUrl}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(externalTaskId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify(toGoogleTask(task)),
    },
  );
  if (!res.ok) throw await googleError(res);
  const updated = await res.json();
  return { etag: updated.etag ?? null, icalUid: null };
}

export async function deleteGoogleTask(
  accessToken: string,
  taskListId: string,
  externalTaskId: string,
  etag: string | null | undefined,
  options: GoogleTaskRequestOptions = {},
) {
  if (!etag) throw new Error("Google task delete requires an ETag");
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GTASKS;
  const res = await fetchImpl(
    `${baseUrl}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(externalTaskId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "If-Match": etag,
      },
    },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw await googleError(res);
  }
}

export async function fetchGoogleTaskChanges(
  accessToken: string,
  taskListId: string,
  options: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<FetchChangesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GTASKS;
  const changes: NormalizedChange[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      maxResults: "100",
      showCompleted: "true",
      showDeleted: "true",
      showHidden: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchImpl(
      `${baseUrl}/lists/${encodeURIComponent(taskListId)}/tasks?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok)
      throw new Error(`Google Tasks ${res.status} ${res.statusText}`);
    const data = await res.json();
    for (const item of data.items ?? []) {
      changes.push({ kind: "task", data: toNormalizedGoogleTask(item) });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Google Tasks has no collection sync token. A complete, paginated read is
  // the only safe way to notice removals that have aged out of its tombstones.
  return { changes, nextCursor: null, reset: true };
}

export function toExternalGoogleTaskList(list: any): ExternalCalendarInfo {
  return {
    color: DEFAULT_CALENDAR_COLOR,
    externalId: googleTaskListExternalId(list.id),
    name: list.title ?? "Tasks",
    supportsEvents: false,
    supportsTasks: true,
  };
}

async function listGoogleTaskLists(accessToken: string, fetchImpl: typeof fetch = fetch) {
  const lists: any[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchImpl(`${GTASKS}/users/@me/lists?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw await googleError(res);
    const data = await res.json();
    lists.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return lists;
}

export async function fetchGoogleChanges(
  accessToken: string,
  externalCalendarId: string,
  cursor: string | null,
  options: {
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    timeModels?: boolean;
    organizerTimeEventIDs?: ReadonlySet<string>;
    reminderEvidence?: boolean;
    rsvpEvidence?: boolean;
  } = {},
): Promise<FetchChangesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GCAL;
  const changes: NormalizedChange[] = [];
  const items: any[] = [];
  const observedRoles = new WeakMap<object, string>();
  let currentCursor = cursor;
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let reset = options.timeModels === true && cursor === null;
  let done = false;

  while (!done) {
    const params = new URLSearchParams();
    if (options.timeModels) params.set("showDeleted", "true");
    if (currentCursor) params.set("syncToken", currentCursor);
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetchImpl(
      `${baseUrl}/calendars/${encodeURIComponent(externalCalendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    // Cursor expired → discard any partial incremental pages and restart as a
    // full set. The engine will sweep provider mappings absent from that set.
    if (res.status === 410) {
      if (!currentCursor) throw new Error("Google full event listing returned 410.");
      reset = true;
      currentCursor = null;
      pageToken = undefined;
      changes.length = 0;
      items.length = 0;
      continue;
    }
    if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);

    const data = await res.json();
    for (const item of data.items ?? []) {
      items.push(item);
      if (item && typeof item === "object" && typeof data.accessRole === "string") observedRoles.set(item, data.accessRole);
    }

    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
    } else {
      nextSyncToken = data.nextSyncToken;
      done = true;
    }
  }

  const masters = new Map(items.filter(item => !item.recurringEventId).map(item => [item.id, item]));
  if (options.timeModels) {
    for (const item of items) {
      if (!item.recurringEventId || masters.has(item.recurringEventId)) continue;
      const response = await fetchImpl(`${baseUrl}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(item.recurringEventId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`Google series hydration ${response.status}`);
      const master = await response.json();
      if (master.id !== item.recurringEventId) throw new Error("Google series hydration returned another identity.");
      masters.set(master.id, master);
      items.push(master);
    }
  }
  for (const item of items.filter(item => !options.timeModels || !item.recurringEventId || masters.get(item.recurringEventId)?.status !== "cancelled")) changes.push({ kind: "event", data: options.timeModels ? normalizeGoogleTime(item, toNormalized({ ...item, recurrence: undefined }, observedRoles.get(item)), masters.get(item.recurringEventId)) : toNormalized(item, observedRoles.get(item)) });
  if (options.organizerTimeEventIDs?.size && !options.timeModels) {
    for (const change of changes) {
      if (change.kind !== "event") continue;
      const item = masters.get(change.data.externalId);
      if (!item || item.status === "cancelled" || !options.organizerTimeEventIDs.has(item.id) || item.recurringEventId || item.originalStartTime || item.recurrence?.length) continue;
      // Only exact persisted organizer sources carry this continuation proof.
      // Never upgrade unrelated personal/secondary events merely because the
      // organizer feature is enabled.
      change.data = normalizeGoogleTime(item, change.data);
    }
  }
  if ((options.reminderEvidence || options.rsvpEvidence) && !options.timeModels) {
    for (const change of changes) {
      if (change.kind !== "event") continue;
      const item = masters.get(change.data.externalId);
      if (!item || item.status === "cancelled" || item.recurringEventId || item.originalStartTime || item.recurrence?.length) continue;
      try { change.data.reminderTimeEvidence = normalizeGoogleTime(item, change.data).timeModel; }
      catch (error) {
        // RSVP comparison fails closed without native time evidence. A valid
        // unsupported time shape must not prevent ordinary legacy ingestion.
        if (options.reminderEvidence) throw error;
      }
    }
  }
  if (options.timeModels) changes.sort((a, b) => Number(a.kind === "event" && !!a.data.externalSeriesID) - Number(b.kind === "event" && !!b.data.externalSeriesID));
  return { changes, nextCursor: nextSyncToken ?? currentCursor, reset };
}

/** The local explicit model has one zone for both endpoints. Do not erase
 * Google's independently specified end zone when proving a reminder ACK. */
export function googleReminderEventEvidence(data: any) {
  if (data.end?.timeZone != null && data.end.timeZone !== data.start?.timeZone)
    throw new EventWriteError("event-write", "unsupported");
  return assertCreatedEventEvidence(normalizeGoogleTime(data, toNormalized(data)));
}

export const googleAdapter: CalendarAdapter = {
  provider: "google",
  organizer: googleOrganizerTransport(async (user, account) => { const token = await getGoogleAccessToken(user, account); await assertOAuthEventWriteGrant(user, "google", account); return token; }),
  ...googleOccurrenceMethods(getGoogleAccessToken, toNormalized),
  ...googleRsvpMethods(async (user, account) => {
    const token = await getGoogleAccessToken(user, account);
    await assertOAuthEventWriteGrant(user, "google", account);
    return token;
  }),
  reminderInstance: googleReminderInstanceTransport(async (user, account) => {
    const token = await getGoogleAccessToken(user, account);
    await assertOAuthEventWriteGrant(user, "google", account);
    return token;
  }),
  projectEvent(event) { return toNormalized({ ...toGoogleEvent(event), id: event.id }); },

  async listAccounts(
    userID: string,
    accountId?: string,
  ): Promise<{ id: string; label: string }[]> {
    const ids = await getOAuthAccountIDs(userID, "google", accountId);
    return Promise.all(
      ids.map(async (id) => {
        let label = id;
        try {
          const accessToken = await getGoogleAccessToken(userID, id);
          const res = await fetch(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          );
          if (res.ok) {
            const d = await res.json();
            label = d.email ?? d.name ?? id;
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
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const readFetch = googleReadFetch(userID, accountId, accessToken);
    const calendars: ExternalCalendarInfo[] = [];
    const availabilityCalendars: { externalId: string; name: string }[] = [];
    let pageToken: string | undefined;
    // The engine sweeps absent mirrors only after this complete discovery.
    do {
      const params = new URLSearchParams();
      if (pageToken) params.set("pageToken", pageToken);
      const res = await readFetch(`${GCAL}/users/me/calendarList?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw await googleError(res);
      const data = await res.json();
      if (!Array.isArray(data.items)) throw new Error("Incomplete Google calendar discovery");
      for (const c of data.items) {
        // An Events mirror cannot represent a free/busy-only grant. Exclude it
        // from the authoritative detail-calendar set so a downgraded mirror is
        // removed before any (possibly failing) event fetch retains old details.
        // Busy interval reads require the separate Freebusy API/model.
        if (c.accessRole === "freeBusyReader") {
          if (typeof c.id !== "string" || !c.id) throw new Error("Incomplete Google availability discovery");
          availabilityCalendars.push({ externalId: c.id, name: typeof c.summary === "string" ? c.summary : "Google availability" });
          continue;
        }
        calendars.push({
          externalId: c.id,
          name: c.summary,
          color: c.backgroundColor,
          readOnly: c.accessRole !== "owner" && c.accessRole !== "writer",
          googleAccessRole: ["owner", "writer", "reader", "writerWithoutPrivateAccess"].includes(c.accessRole) ? c.accessRole : "unknown",
          supportsEvents: true,
          supportsTasks: false,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    if (!(await hasOAuthTaskScope(userID, "google", accountId))) {
      return { calendars, availabilityCalendars, taskListsComplete: false };
    }
    try {
      const taskLists = await listGoogleTaskLists(accessToken, googleReadFetch(userID, accountId, accessToken, true));
      return {
        availabilityCalendars,
        calendars: [...calendars, ...taskLists.map(toExternalGoogleTaskList)],
        taskListsComplete: true,
      };
    } catch (error) {
      if (!isOptionalTaskError(error)) throw error;
      logger.warn("sync.tasks.discovery_unavailable", {
        provider: "google",
        userId: userID,
        accountId,
      });
      return { calendars, availabilityCalendars, taskListsComplete: false };
    }
  },

  async fetchChanges(
    userID,
    accountId,
    externalCalendarId,
    cursor,
  ): Promise<FetchChangesResult> {
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const taskListId = googleTaskListId(externalCalendarId);
    if (taskListId && !(await hasOAuthTaskScope(userID, "google", accountId)))
      throw new TaskScopeMissingError();
    return taskListId
      ? fetchGoogleTaskChanges(accessToken, taskListId, { fetchImpl: googleReadFetch(userID, accountId, accessToken, true) })
      : fetchGoogleChanges(accessToken, externalCalendarId, cursor, { fetchImpl: googleReadFetch(userID, accountId, accessToken), timeModels: config.api.eventTimeEditsEnabled, organizerTimeEventIDs: new Set(await getGoogleOrganizerTimeEventIDs(userID, accountId, externalCalendarId)), reminderEvidence: config.api.providerReminderEditsEnabled, rsvpEvidence: config.api.providerRsvpEditsEnabled });
  },

  async assertEventWrite(userID, accountId, externalCalendarId, operation) {
    const accessToken = await getGoogleAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "google", accountId);
    const headers = { Authorization: `Bearer ${accessToken}` };
    const response = await fetch(
      `${GCAL}/users/me/calendarList/${encodeURIComponent(externalCalendarId)}`,
      { headers, signal: operation.signal },
    );
    assertEventWriteResponse(response);
    const calendar = await response.json();
    assertEventWriteEvidence(
      typeof calendar.accessRole === "string"
        ? ["owner", "writer"].includes(calendar.accessRole)
        : undefined,
      "event-write",
    );
    // A calendar grant does not make an invited copy an organizer's meeting.
    // DELETE can cancel an organizer copy, but only removes an attendee copy.
    if (operation.action !== "create" && operation.external) {
      requireEventEtag(operation.external.etag);
      if (operation.action === "update")
        toGoogleEventPatch(operation.event, operation.patch);
      const response = await fetch(
        `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(operation.external.externalEventId)}`,
        { headers, signal: operation.signal },
      );
      if (operation.action === "delete" && [404, 410].includes(response.status))
        return;
      assertEventWriteResponse(response);
      const current = await response.json();
      assertAcceptedEventEtag(operation.external.etag, current.etag);
      // Google documents self=false as the default on an organizer object.
      // An absent organizer object is not evidence of that default.
      const self =
        typeof current.organizer?.self === "boolean"
          ? current.organizer.self
          : typeof current.organizer?.email === "string" &&
              current.organizer.email
            ? false
            : undefined;
      if (self === true && Array.isArray(current.attendees) && current.attendees.some((guest: { self?: boolean; organizer?: boolean }) => !guest.self && !guest.organizer)) throw new EventWriteError("organizer", "unsupported", "Use the explicit Google organizer action to notify guests.");
      assertEventWriteEvidence(
        operation.action === "delete" && self === false ? true : self,
        "organizer",
      );
    }
  },

  async readReminderState(userID, accountId, externalCalendarId, ref, signal) {
    const response = await fetch(`${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(ref.externalEventId)}`, { headers: { Authorization: `Bearer ${await getGoogleAccessToken(userID, accountId)}`, "Cache-Control": "no-cache" }, redirect: "error", signal });
    if ([404, 410].includes(response.status)) return null;
    assertCompleteEventReadResponse(response);
    const data = await response.json();
    if (data.id !== ref.externalEventId) throw new ProviderEventWriteError("provider-conflict");
    if (data.status === "cancelled") return null;
    if (data.recurringEventId || data.originalStartTime || data.recurrence?.length)
      throw new EventWriteError("event-write", "unsupported");
    return { ref: { externalEventId: data.id, etag: requireEventEtag(strongEventEtag(data.etag)) }, state: googleEventState(data), event: googleReminderEventEvidence(data) };
  },

  async writeReminders(userID, accountId, externalCalendarId, ref, input, signal, beforeWrite) {
    if (!beforeWrite) throw new EventWriteError("event-write", "unsupported");
    if (!config.api.providerReminderEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const reminders = GoogleReminderWriteSchema.parse(input);
    await assertOAuthEventWriteGrant(userID, "google", accountId);
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const calendarResponse = await fetch(`${GCAL}/users/me/calendarList/${encodeURIComponent(externalCalendarId)}`, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error", signal });
    assertEventWriteResponse(calendarResponse);
    const calendar = await calendarResponse.json();
    assertEventWriteEvidence(typeof calendar.accessRole === "string" ? ["owner", "writer"].includes(calendar.accessRole) : undefined, "event-write");
    const baseline = await googleAdapter.readReminderState!(userID, accountId, externalCalendarId, ref, signal);
    if (!baseline) throw new ProviderEventWriteError("provider-conflict");
    assertAcceptedEventEtag(ref.etag, baseline.ref.etag);
    await beforeWrite();
    signal?.throwIfAborted();
    // Only this authenticated copy's reminders change, never participants/time.
    const response = await fetch(`${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(ref.externalEventId)}?sendUpdates=none`, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "If-Match": requireEventEtag(ref.etag) }, body: JSON.stringify({ reminders }), redirect: "error", signal });
    assertProviderEventMutationResponse(response);
    const data = await response.json().catch(() => null);
    if (data?.id !== ref.externalEventId) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", response.status);
    const etag = strongEventEtag(data.etag);
    if (!etag) throw new ProviderEventWriteError("provider-version-unavailable", "unconfirmed", response.status);
    try {
      if (data.recurringEventId || data.originalStartTime || data.recurrence?.length)
        throw new Error("Unsupported recurring reminder evidence");
      return { ref: { externalEventId: data.id, etag }, state: googleEventState(data), event: googleReminderEventEvidence(data) };
    } catch {
      throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", response.status);
    }
  },

  async readEvent(userID, accountId, externalCalendarId, ref, signal) {
    const response = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(ref.externalEventId)}`,
      { headers: { Authorization: `Bearer ${await getGoogleAccessToken(userID, accountId)}`, "Cache-Control": "no-cache" }, redirect: "error", signal },
    );
    if ([404, 410].includes(response.status)) return null;
    assertCompleteEventReadResponse(response);
    const data = await response.json();
    if (data.id !== ref.externalEventId) throw new ProviderEventWriteError("provider-conflict");
    if (data.status === "cancelled") return null;
    const event = assertCreatedEventEvidence(toNormalized(data));
    return { ref: { externalEventId: data.id, etag: strongEventEtag(data.etag) }, event };
  },

  async findCreatedEvent(userID, accountId, externalCalendarId, identity) {
    const id = googleEventCreateID(identity);
    const response = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${id}`,
      {
        headers: {
          Authorization: `Bearer ${await getGoogleAccessToken(userID, accountId)}`,
          "Cache-Control": "no-cache",
        },
        redirect: "error",
        signal: identity?.signal,
      },
    );
    if (response.status === 404) return null;
    if (response.status === 410)
      throw new ProviderEventWriteError("provider-conflict");
    assertCompleteEventReadResponse(response);
    const data = await response.json();
    if (
      data.id !== id ||
      data.extendedProperties?.private?.musubiOperationID !==
        eventCreateOperationID(identity)
    )
      throw new ProviderEventWriteError("provider-conflict");
    const event = assertCreatedEventEvidence(toNormalized(data));
    return {
      ref: { externalEventId: id, etag: strongEventEtag(data.etag) },
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
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...toGoogleEvent(event),
          ...(identity
            ? {
                id: googleEventCreateID(identity),
                extendedProperties: {
                  private: {
                    musubiOperationID: eventCreateOperationID(identity),
                  },
                },
              }
            : {}),
        }),
        redirect: "error",
        signal: identity?.signal,
      },
    );
    assertProviderEventMutationResponse(res);
    const data = await res.json().catch(() => null);
    if (
      typeof data?.id !== "string" ||
      !data.id ||
      (identity && data.id !== googleEventCreateID(identity))
    ) {
      throw new ProviderEventWriteError(
        "provider-write-failed",
        "unconfirmed",
        res.status,
      );
    }
    return { externalEventId: data.id, etag: strongEventEtag(data.etag) };
  },

  async pushUpdate(
    userID,
    accountId,
    externalCalendarId,
    externalEventId,
    event: Event,
    ref,
    patch,
    signal,
  ) {
    const etag = requireEventEtag(ref?.etag);
    const payload = toGoogleEventPatch(event, patch);
    if (Object.keys(payload).length === 0) return; // Known local-only/no-op diff, no write.
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(externalEventId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "If-Match": etag,
        },
        body: JSON.stringify(payload),
        signal,
        redirect: "error", // Never turn a conditional mutation into a redirected GET.
      },
    );
    assertProviderEventMutationResponse(res);
    // A missing/malformed success body cannot authorize another write. Never
    // adopt a later GET's version without accepting its content through sync.
    const data = await res.json().catch(() => null);
    return { etag: strongEventEtag(data?.etag) };
  },

  async pushDelete(
    userID,
    accountId,
    externalCalendarId,
    externalEventId,
    ref,
    signal,
  ) {
    const etag = requireEventEtag(ref?.etag);
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(externalEventId)}`,
      {
        method: "DELETE",
        signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${accessToken}`, "If-Match": etag },
      },
    );
    // 404/410 = already gone = success (idempotent)
    if (res.status !== 404 && res.status !== 410) {
      assertProviderEventMutationResponse(res);
    }
  },

  async pushTaskCreate(userID, accountId, externalCalendarId, task) {
    const taskListId = googleTaskListId(externalCalendarId);
    if (!taskListId) throw new Error("Google task write requires a task list");
    return createGoogleTask(
      await getGoogleAccessToken(userID, accountId, true),
      taskListId,
      task,
    );
  },

  async pushTaskUpdate(
    userID,
    accountId,
    externalCalendarId,
    externalTaskId,
    task,
    ref,
  ) {
    const taskListId = googleTaskListId(externalCalendarId);
    if (!taskListId) throw new Error("Google task write requires a task list");
    return updateGoogleTask(
      await getGoogleAccessToken(userID, accountId, true),
      taskListId,
      externalTaskId,
      task,
      ref?.etag,
    );
  },

  async pushTaskDelete(
    userID,
    accountId,
    externalCalendarId,
    externalTaskId,
    ref,
  ) {
    const taskListId = googleTaskListId(externalCalendarId);
    if (!taskListId) throw new Error("Google task write requires a task list");
    await deleteGoogleTask(
      await getGoogleAccessToken(userID, accountId, true),
      taskListId,
      externalTaskId,
      ref?.etag,
    );
  },

  async createCalendar(userID, accountId, { name, color }) {
    const accessToken = await getGoogleAccessToken(userID, accountId);
    await assertOAuthEventWriteGrant(userID, "google", accountId);
    const res = await fetch(`${GCAL}/calendars`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ summary: name }),
    });
    if (!res.ok) throw await googleError(res);
    const data = await res.json();
    await patchCalendarColor(accessToken!, data.id, color);
    return { externalId: data.id };
  },

  async updateCalendar(userID, accountId, externalCalendarId, { name, color }) {
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const taskListId = googleTaskListId(externalCalendarId);
    if (taskListId && !(await hasOAuthTaskScope(userID, "google", accountId)))
      throw new TaskScopeMissingError();
    if (taskListId) {
      const res = await fetch(
        `${GTASKS}/users/@me/lists/${encodeURIComponent(taskListId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: name }),
        },
      );
      if (!res.ok) throw await googleError(res);
      return;
    }
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ summary: name }),
      },
    );
    if (!res.ok) throw await googleError(res);
    await patchCalendarColor(accessToken!, externalCalendarId, color);
  },

  async deleteCalendar(userID, accountId, externalCalendarId) {
    const accessToken = await getGoogleAccessToken(userID, accountId);
    const taskListId = googleTaskListId(externalCalendarId);
    if (taskListId && !(await hasOAuthTaskScope(userID, "google", accountId)))
      throw new TaskScopeMissingError();
    const res = await fetch(
      taskListId
        ? `${GTASKS}/users/@me/lists/${encodeURIComponent(taskListId)}`
        : `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    // 404/410 = already gone = success; primary calendars come back as 400 and bubble up.
    if (!res.ok && res.status !== 404 && res.status !== 410)
      throw await googleError(res);
  },
};
