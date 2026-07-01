import { auth } from "@musubi/auth";
import { applyGoogleEvent, clearGoogleCalendarEvents, doesGoogleCalIDExistsForUser, getGoogleEventID, getGoogleRefreshToken, getUserGoogleCalendars, importGoogleCalendar, importGoogleEvent, setGoogleSyncToken } from "@musubi/db";
import { Event } from "@musubi/types";


export async function syncGoogleCalendarList(userID: string) {
  const accessToken = await getGoogleAccessToken(userID);

  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    }
  });

  if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`)

  const data = await res.json();

  for (const cal of data.items) {
    if (!(await doesGoogleCalIDExistsForUser(userID, cal.id))) {
      await importGoogleCalendar(userID, cal)
    }
  }

  for (const cal of (await getUserGoogleCalendars(userID))) {
    await pullGoogleCalendar(userID, cal);
  }
}


export async function getGoogleAccessToken(userID: string) {
  const { accessToken } = await auth.api.getAccessToken({
    body: { providerId: "google", userId: userID },
  });

  return accessToken;
}


const GCAL = "https://www.googleapis.com/calendar/v3/calendars";

export async function pullGoogleCalendar(
  userID: string,
  link: {
    calendarID: string, googleCalendarID: string; syncToken: string | null, calColor: string
  }) {
  const accessToken = await getGoogleAccessToken(userID);
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const params = new URLSearchParams();
    if (link.syncToken) params.set("syncToken", link.syncToken);
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${GCAL}/${encodeURIComponent(link.googleCalendarID)}/events?${params}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      }
    });

    if (res.status === 410) {
      await clearGoogleCalendarEvents(link.calendarID);
      await setGoogleSyncToken(link.calendarID, null);
      return pullGoogleCalendar(userID, { ...link, syncToken: null });
    }

    if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);

    const data = await res.json();
    for (const item of data.items ?? []) {
      await applyGoogleEvent(userID, item, link.calendarID, link.googleCalendarID, link.calColor);
    }
    pageToken = data.nextPageToken;
    nextSyncToken = data.nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) await setGoogleSyncToken(link.calendarID, nextSyncToken);
}

export function toGoogleEvent(event: Event) {
  const googleEvent = {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: event.isAllDay ?
      { "date": event.start.toISOString().slice(0, 10) } :
      { "dateTime": event.start.toISOString() },
    end: event.isAllDay ?
      { "date": event.end.toISOString().slice(0, 10) } :
      { "dateTime": event.end.toISOString() },
  };

  return googleEvent;
}

export async function pushEventCreateToGoogle(
  userID: string,
  googleCalendarID: string,
  event: Event,
) {
  const accessToken = await getGoogleAccessToken(userID);

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleCalendarID)}/events`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(toGoogleEvent(event))
  });

  if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);

  const data = await res.json();

  await importGoogleEvent(userID, event.id, googleCalendarID, data.id);
}

export async function pushEventUpdateToGoogle(
  userID: string,
  googleCalendarID: string,
  event: Event,
) {
  const accessToken = await getGoogleAccessToken(userID);
  const googleEventID = await getGoogleEventID(event.id, googleCalendarID);

  if (!googleEventID) return; // TODO: If event added after created, create new google event

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleCalendarID)}/events/${encodeURIComponent(googleEventID)}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(toGoogleEvent(event))
  });

  if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);
}

export async function pushEventDeleteToGoogle(
  userID: string,
  googleCalendarID: string,
  googleEventID: string
) {
  const accessToken = await getGoogleAccessToken(userID);

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(googleCalendarID)}/events/${encodeURIComponent(googleEventID)}`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google ${res.status} ${res.statusText}`);
}
