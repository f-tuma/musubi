import { auth } from "@musubi/auth";
import { doesGoogleCalIDExistsForUser, importGoogleCalendar } from "@musubi/db";


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
}


export async function getGoogleAccessToken(userID: string) {
  const { accessToken } = await auth.api.getAccessToken({
    body: { providerId: "google", userId: userID },
  });

  return accessToken;
}
