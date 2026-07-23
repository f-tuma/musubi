import { config } from "@musubi/config";
import { getOAuthAccountIDs } from "@musubi/db";
import { Event, nearestMicrosoftCalendarColor } from "@musubi/types";
import {
  CalendarAdapter,
  ExternalCalendarInfo,
  FetchChangesResult,
  NormalizedEvent,
} from "../adapter";
import { getOAuthAccessToken } from "../oauth";

const GRAPH = "https://graph.microsoft.com/v1.0";

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
const WINDOW_RENEW_MARGIN_DAYS = 90;   // re-window when less future than this remains
const PAGE_SIZE = 100;

const DAY_MS = 86_400_000;

// Every request asks for UTC times and plain-text bodies up front — saves
// timezone/HTML conversion on our side.
const PREFER = `outlook.timezone="UTC", outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}`;

function getAccessToken(userID: string, accountId: string) {
  const tenant = config.social.microsoftTenantID;
  return getOAuthAccessToken("microsoft", userID, accountId, {
    tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    clientId: config.social.microsoftClientID,
    clientSecret: config.social.microsoftClientSecret,
    // Microsoft requires the scope again on refresh (and rotates the refresh
    // token — the shared helper persists the new one).
    extraParams: { scope: "openid User.Read Calendars.ReadWrite offline_access" },
    subtypeKey: "suberror",
  });
}

// Error with Graph's own message when available ("Cannot delete default
// calendar", …) — status text alone is useless to the user.
async function graphError(res: Response): Promise<Error> {
  let detail = res.statusText;
  try { detail = (await res.json())?.error?.message ?? detail; } catch { /* keep statusText */ }
  return new Error(`Outlook ${res.status}: ${detail}`);
}

// Graph dateTime comes as "2026-07-18T20:30:00.0000000" (no zone designator,
// zone is UTC via the Prefer header). Trim the 7-digit fraction and pin Z.
export function parseGraphDate(dateTime: string): Date {
  return new Date(dateTime.replace(/(\.\d{3})\d*$/, "$1") + "Z");
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

  return {
    externalId: item.id,
    status: "active",
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
    throw new Error("Outlook calendars don't support recurring events created in Musubi yet.");
  }
  return {
    subject: event.title,
    body: { contentType: "text", content: event.description ?? "" },
    location: { displayName: event.location ?? "" },
    isAllDay: event.isAllDay,
    // All-day needs midnight-to-midnight and an exclusive end (+1 day).
    start: {
      dateTime: event.isAllDay ? event.start.toISOString().slice(0, 10) + "T00:00:00" : event.start.toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: event.isAllDay
        ? new Date(event.end.getTime() + DAY_MS).toISOString().slice(0, 10) + "T00:00:00"
        : event.end.toISOString(),
      timeZone: "UTC",
    },
  };
}

// The cursor stores the deltaLink AND the window's future edge so we know when
// to re-window. Old plain-URL cursors (or garbage) parse as "no cursor".
export function parseCursor(cursor: string | null): { link: string; windowEnd: number } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor);
    if (typeof parsed?.link === "string" && typeof parsed?.windowEnd === "number") return parsed;
  } catch { /* treat as no cursor */ }
  return null;
}

async function graphGet(accessToken: string, url: string): Promise<Response> {
  return fetch(url, {
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
  id: string,
  cache: Map<string, any>,
): Promise<any> {
  if (cache.has(id)) return cache.get(id);
  const res = await graphGet(accessToken, `${GRAPH}/me/events/${encodeURIComponent(id)}`);
  const master = res.ok ? await res.json() : null;
  cache.set(id, master);
  return master;
}

export const microsoftAdapter: CalendarAdapter = {
  provider: "microsoft",

  async listAccounts(userID: string): Promise<{ id: string; label: string }[]> {
    const ids = await getOAuthAccountIDs(userID, "microsoft");
    return Promise.all(ids.map(async (id) => {
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
      } catch { /* fall back to id */ }
      return { id, label };
    }));
  },

  async listCalendars(userID: string, accountId: string): Promise<ExternalCalendarInfo[]> {
    const accessToken = await getAccessToken(userID, accountId);
    const calendars: ExternalCalendarInfo[] = [];
    let url: string | null = `${GRAPH}/me/calendars?$top=${PAGE_SIZE}`;
    while (url) {
      const res = await graphGet(accessToken, url);
      if (!res.ok) throw await graphError(res);
      const data = await res.json();
      for (const c of data.value ?? []) {
        calendars.push({
          externalId: c.id,
          name: c.name,
          // hexColor is "" when the calendar uses the "auto" preset
          color: c.hexColor || "#0078D4",
          readOnly: c.canEdit === false,
        });
      }
      url = data["@odata.nextLink"] ?? null;
    }
    return calendars;
  },

  async fetchChanges(userID, accountId, externalCalendarId, cursor): Promise<FetchChangesResult> {
    const accessToken = await getAccessToken(userID, accountId);
    const changes: NormalizedEvent[] = [];

    let parsed = parseCursor(cursor);
    // Window edge approaching → start over with a fresh window.
    if (parsed && parsed.windowEnd - Date.now() < WINDOW_RENEW_MARGIN_DAYS * DAY_MS) parsed = null;

    let reset = !parsed && !!cursor; // had a cursor but can't continue from it → wipe
    let windowEnd = parsed?.windowEnd ?? Date.now() + WINDOW_FUTURE_DAYS * DAY_MS;
    let url = parsed?.link ?? initialDeltaUrl(externalCalendarId, windowEnd);
    let deltaLink: string | null = null;
    const seriesMasters = new Map<string, any>();

    while (!deltaLink) {
      const res = await graphGet(accessToken, url);

      // delta token expired → restart as a full sync and tell core to wipe local first
      if (res.status === 410) {
        reset = true;
        changes.length = 0;
        windowEnd = Date.now() + WINDOW_FUTURE_DAYS * DAY_MS;
        url = initialDeltaUrl(externalCalendarId, windowEnd);
        continue;
      }
      if (!res.ok) throw await graphError(res);

      const data = await res.json();
      for (let item of data.value ?? []) {
        if (item.type === "seriesMaster") continue; // definition only; occurrences carry the instances
        // Occurrences/exceptions inherit subject, isAllDay, body, … from their
        // master; backfill them (the occurrence's own start/end/id win on spread).
        if (item.seriesMasterId && !item["@removed"]) {
          const master = await fetchSeriesMaster(accessToken, item.seriesMasterId, seriesMasters);
          if (master) item = { ...master, ...item };
        }
        changes.push(toNormalized(item));
      }

      if (data["@odata.nextLink"]) {
        url = data["@odata.nextLink"];
      } else {
        deltaLink = data["@odata.deltaLink"] ?? url;
      }
    }

    return { changes, nextCursor: JSON.stringify({ link: deltaLink, windowEnd }), reset };
  },

  async pushCreate(userID, accountId, externalCalendarId, event: Event) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}/events`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(toGraphEvent(event)),
      },
    );
    if (!res.ok) throw await graphError(res);
    const data = await res.json();
    return { externalEventId: data.id };
  },

  async pushUpdate(userID, accountId, externalCalendarId, externalEventId, event: Event) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GRAPH}/me/events/${encodeURIComponent(externalEventId)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(toGraphEvent(event)),
      },
    );
    if (!res.ok) throw await graphError(res);
  },

  async pushDelete(userID, accountId, externalCalendarId, externalEventId) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GRAPH}/me/events/${encodeURIComponent(externalEventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    // 404/410 = already gone = success (idempotent)
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw await graphError(res);
    }
  },

  async createCalendar(userID, accountId, { name, color }) {
    // Graph only accepts preset color names (hexColor is read-only) — map to
    // the nearest preset. The client offers exactly these presets for Outlook
    // calendars, so this is normally an exact match.
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GRAPH}/me/calendars`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: nearestMicrosoftCalendarColor(color).name }),
    });
    if (!res.ok) throw await graphError(res);
    const data = await res.json();
    return { externalId: data.id };
  },

  async updateCalendar(userID, accountId, externalCalendarId, { name, color }) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: nearestMicrosoftCalendarColor(color).name }),
    });
    if (!res.ok) throw await graphError(res);
  },

  async deleteCalendar(userID, accountId, externalCalendarId) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 404/410 = already gone = success; the default calendar comes back as an
    // error and bubbles up.
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await graphError(res);
  },
};

function initialDeltaUrl(externalCalendarId: string, windowEnd: number): string {
  const start = new Date(Date.now() - WINDOW_PAST_DAYS * DAY_MS).toISOString();
  const end = new Date(windowEnd).toISOString();
  return `${GRAPH}/me/calendars/${encodeURIComponent(externalCalendarId)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
}
