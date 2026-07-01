import { auth } from "@musubi/auth";
import { applyEvent, clearGoogleCalendarEvents, doesGoogleCalIDExistsForUser, getGoogleRefreshToken, getUserGoogleCalendars, importGoogleCalendar, setSyncToken, user } from "@musubi/db";


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
    console.log(cal.googleCalendarID);
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

export async function pullGoogleCalendar(userID: string, link: {
  calendarID: string,
  googleCalendarID: string; syncToken: string | null
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
      await setSyncToken(link.calendarID, null);
      return pullGoogleCalendar(userID, { ...link, syncToken: null });
    }

    if (!res.ok) throw new Error(`Google ${res.status} ${res.statusText}`);

    const data = await res.json();
    for (const item of data.items ?? []) {
      await applyEvent(item, link.calendarID);
    }
    pageToken = data.nextPageToken;
    nextSyncToken = data.nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) await setSyncToken(link.calendarID, nextSyncToken);
}
