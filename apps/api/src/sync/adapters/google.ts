import { auth } from "@musubi/auth";
import { getGoogleAccountIDs } from "@musubi/db";
import { Event } from "@musubi/types";
import {
  CalendarAdapter,
  ExternalCalendarInfo,
  FetchChangesResult,
  NormalizedEvent,
} from "../adapter";

const GCAL = "https://www.googleapis.com/calendar/v3";

async function getAccessToken(userID: string, accountId: string) {
  const { accessToken } = await auth.api.getAccessToken({
    body: { providerId: "google", userId: userID, accountId },
  });
  return accessToken;
}

// Google sometimes sends FREQ=YEARLY;BYMONTHDAY=X without BYMONTH → RFC 5545
// expands that to monthly. Anchor it to the start month so it stays annual.
function sanitizeRecurrence(rrule: string, start: Date): string {
  if (/FREQ=YEARLY/.test(rrule) && /BYMONTHDAY=/.test(rrule) && !/BYMONTH=/.test(rrule)) {
    return `${rrule};BYMONTH=${start.getUTCMonth() + 1}`;
  }
  return rrule;
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
    url: item.htmlLink ?? null,
  };
}

// Musubi Event -> Google event JSON
function toGoogleEvent(event: Event) {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
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
};
