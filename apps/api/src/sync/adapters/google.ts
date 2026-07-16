import { config } from "@musubi/config";
import {
  getGoogleAccountIDs,
  getGoogleOAuthCredentials,
  markGoogleAccountReconnectRequired,
  updateGoogleOAuthTokens,
} from "@musubi/db";
import { Event } from "@musubi/types";
import {
  CalendarAdapter,
  ExternalCalendarInfo,
  FetchChangesResult,
  NormalizedEvent,
} from "../adapter";
import { ProviderAuthError } from "../errors";

const GCAL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Error with Google's own message when available ("Cannot delete primary
// calendar", …) — status text alone is useless to the user.
async function googleError(res: Response): Promise<Error> {
  let detail = res.statusText;
  try { detail = (await res.json())?.error?.message ?? detail; } catch { /* keep statusText */ }
  return new Error(`Google ${res.status}: ${detail}`);
}

// Calendar color lives on the per-user calendarList entry, not the calendar
// resource itself; colorRgbFormat=true accepts plain hex.
async function patchCalendarColor(accessToken: string, calendarId: string, color: string) {
  const res = await fetch(
    `${GCAL}/users/me/calendarList/${encodeURIComponent(calendarId)}?colorRgbFormat=true`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ backgroundColor: color, foregroundColor: "#000000" }),
    },
  );
  if (!res.ok) throw await googleError(res);
}

async function getAccessToken(userID: string, accountId: string) {
  const credentials = await getGoogleOAuthCredentials(userID, accountId);
  if (!credentials) {
    throw new ProviderAuthError("google", "account_not_found", undefined, false);
  }
  if (credentials.syncStatus === "reconnect_required") {
    throw new ProviderAuthError(
      "google",
      credentials.syncErrorCode ?? "reconnect_required",
      credentials.syncErrorSubtype ?? undefined,
      true,
    );
  }

  const expiresAt = credentials.accessTokenExpiresAt?.getTime();
  if (credentials.accessToken && expiresAt && expiresAt - Date.now() >= 5_000) {
    return credentials.accessToken;
  }

  if (!credentials.refreshToken) {
    await markGoogleAccountReconnectRequired(userID, accountId, "missing_refresh_token");
    throw new ProviderAuthError("google", "missing_refresh_token", undefined, true);
  }

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: config.social.googleWebClientID,
        client_secret: config.social.googleClientSecret,
      }),
    });
  } catch {
    throw new ProviderAuthError("google", "token_endpoint_unreachable", undefined, false);
  }

  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: unknown;
    error_subtype?: unknown;
  };

  if (!response.ok) {
    const code = safeOAuthCode(payload.error) ?? `http_${response.status}`;
    const subtype = safeOAuthCode(payload.error_subtype);
    const reconnectRequired = code === "invalid_grant";
    if (reconnectRequired) {
      await markGoogleAccountReconnectRequired(userID, accountId, code, subtype);
    }
    throw new ProviderAuthError("google", code, subtype, reconnectRequired);
  }

  if (!payload.access_token) {
    throw new ProviderAuthError("google", "invalid_token_response", undefined, false);
  }

  const accessTokenExpiresAt = new Date(Date.now() + validExpiresIn(payload.expires_in) * 1_000);
  await updateGoogleOAuthTokens(userID, accountId, {
    accessToken: payload.access_token,
    accessTokenExpiresAt,
    refreshToken: payload.refresh_token,
  });
  return payload.access_token;
}

function safeOAuthCode(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined;
}

function validExpiresIn(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 3_600;
}

// "What UTC instant is <local wall-clock time> in <tz>?" — via Intl, no tz lib.
// ponytail: single-iteration approximation; can be 1h off in the hour around a
// DST transition. Good enough for exception stamps.
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const wallAtGuess = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(guess - (wallAtGuess - guess));
}

const toICalUTC = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

// Normalize Google's recurrence lines into what our expansion (rrule lib)
// provably handles — verified empirically:
//  - EXDATE;TZID=…  → silently IGNORED by rrule → convert to UTC EXDATE here
//  - EXDATE;VALUE=DATE:… → works (all-day, UTC-midnight anchors) → keep
//  - FREQ=YEARLY;BYMONTHDAY without BYMONTH → RFC expands monthly → anchor month
function sanitizeRecurrence(recurrence: string, start: Date): string {
  return recurrence.split("\n").filter(Boolean).map((line) => {
    if (/^(RRULE:)?FREQ=/.test(line)) {
      if (/FREQ=YEARLY/.test(line) && /BYMONTHDAY=/.test(line) && !/BYMONTH=/.test(line)) {
        return `${line};BYMONTH=${start.getUTCMonth() + 1}`;
      }
      return line;
    }
    const m = line.match(/^EXDATE;TZID=([^:;]+):(.+)$/i);
    if (m) {
      const [, tz, vals] = m;
      const utc = vals.split(",").map((v) => {
        const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
        return t ? toICalUTC(zonedToUtc(+t[1], +t[2], +t[3], +t[4], +t[5], +t[6], tz)) : v;
      });
      return `EXDATE:${utc.join(",")}`;
    }
    return line;
  }).join("\n");
}

// Google event JSON -> NormalizedEvent
function toNormalized(item: any): NormalizedEvent {
  if (item.status === "cancelled") {
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

  const isAllDay = !item.start.dateTime;
  const start = new Date(item.start.dateTime ?? item.start.date);
  const end = isAllDay
    ? new Date(new Date(item.end.date).getTime() - 86400000) // -1 day, Google end.date is exclusive
    : new Date(item.end.dateTime);

  return {
    externalId: item.id,
    status: "active",
    title: item.summary ?? "(untitled)",
    start,
    end,
    isAllDay,
    description: item.description ?? null,
    location: item.location ?? null,
    organizer: item.organizer?.email ?? null,
    recurrence: item.recurrence ? sanitizeRecurrence(item.recurrence.join("\n"), start) : null,
    // NOT htmlLink — that's just "open in Google Calendar" noise on every event.
    // Meet link / source url are actual event URLs.
    url: item.hangoutLink ?? item.source?.url ?? null,
  };
}

// Google wants iCal lines with prefixes; our bare "FREQ=..." needs one.
// All-day series use DATE-typed dtstart, so EXDATE/UNTIL must be dates too
// (RFC 5545: exception/until value type must match DTSTART's).
function toGoogleRecurrence(recurrence: string, isAllDay: boolean): string[] {
  return recurrence.split("\n").filter(Boolean).map((line) => {
    if (!/^(RRULE|EXDATE|RDATE|EXRULE)/.test(line)) line = `RRULE:${line}`;
    if (!isAllDay) return line;
    if (/^EXDATE:/.test(line)) {
      const dates = line.slice("EXDATE:".length).split(",").map((v) => v.slice(0, 8));
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
    recurrence: event.recurrence ? toGoogleRecurrence(event.recurrence, event.isAllDay) : null,
    start: event.isAllDay
      ? { date: event.start.toISOString().slice(0, 10) }
      : { dateTime: event.start.toISOString() },
    end: event.isAllDay
      ? { date: new Date(event.end.getTime() + 86400000).toISOString().slice(0, 10) } // +1 day, Google exclusive
      : { dateTime: event.end.toISOString() },
  };
}

export const googleAdapter: CalendarAdapter = {
  provider: "google",

  async listAccounts(userID: string): Promise<{ id: string; label: string }[]> {
    const ids = await getGoogleAccountIDs(userID);
    return Promise.all(ids.map(async (id) => {
      let label = id;
      try {
        const accessToken = await getAccessToken(userID, id);
        const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const d = await res.json();
          label = d.email ?? d.name ?? id;
        }
      } catch { /* fall back to id */ }
      return { id, label };
    }));
  },

  async listCalendars(userID: string, accountId: string): Promise<ExternalCalendarInfo[]> {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GCAL}/users/me/calendarList`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.items ?? []).map((c: any) => ({
      externalId: c.id,
      name: c.summary,
      color: c.backgroundColor,
      readOnly: c.accessRole !== "owner" && c.accessRole !== "writer",
    }));
  },

  async fetchChanges(userID, accountId, externalCalendarId, cursor): Promise<FetchChangesResult> {
    const accessToken = await getAccessToken(userID, accountId);
    const changes: NormalizedEvent[] = [];
    let currentCursor = cursor;
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let reset = false;
    let done = false;

    while (!done) {
      const params = new URLSearchParams();
      if (currentCursor) params.set("syncToken", currentCursor);
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetch(
        `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      // cursor expired → restart as a full sync and tell core to wipe local first
      if (res.status === 410) {
        reset = true;
        currentCursor = null;
        pageToken = undefined;
        changes.length = 0;
        continue;
      }
      if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);

      const data = await res.json();
      for (const item of data.items ?? []) changes.push(toNormalized(item));

      if (data.nextPageToken) {
        pageToken = data.nextPageToken;
      } else {
        nextSyncToken = data.nextSyncToken;
        done = true;
      }
    }

    return { changes, nextCursor: nextSyncToken ?? currentCursor, reset };
  },

  async pushCreate(userID, accountId, externalCalendarId, event: Event) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(toGoogleEvent(event)),
      },
    );
    if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { externalEventId: data.id };
  },

  async pushUpdate(userID, accountId, externalCalendarId, externalEventId, event: Event) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(externalEventId)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(toGoogleEvent(event)),
      },
    );
    if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);
  },

  async pushDelete(userID, accountId, externalCalendarId, externalEventId) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(
      `${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}/events/${encodeURIComponent(externalEventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    // 404/410 = already gone = success (idempotent)
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google ${res.status} ${res.statusText}`);
    }
  },

  async createCalendar(userID, accountId, { name, color }) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GCAL}/calendars`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summary: name }),
    });
    if (!res.ok) throw await googleError(res);
    const data = await res.json();
    await patchCalendarColor(accessToken!, data.id, color);
    return { externalId: data.id };
  },

  async updateCalendar(userID, accountId, externalCalendarId, { name, color }) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summary: name }),
    });
    if (!res.ok) throw await googleError(res);
    await patchCalendarColor(accessToken!, externalCalendarId, color);
  },

  async deleteCalendar(userID, accountId, externalCalendarId) {
    const accessToken = await getAccessToken(userID, accountId);
    const res = await fetch(`${GCAL}/calendars/${encodeURIComponent(externalCalendarId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 404/410 = already gone = success; primary calendars come back as 400 and bubble up.
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await googleError(res);
  },
};
