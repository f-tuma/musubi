import { auth } from "@musubi/auth";


export async function getGoogleCalendarList(accessToken: string) {
  const { body, status, statusText } = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
    }
  });

  if (status !== 200) {
    console.log(`STATUS: ${status} : ${statusText}`);
  } else {
    console.log(JSON.stringify(body));
  }
}


export async function getGoogleAccessToken(userID: string) {
  const { accessToken } = await auth.api.getAccessToken({
    body: { providerId: "google", userId: userID },
  });

  return accessToken;
}
