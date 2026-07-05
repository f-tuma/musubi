import { createDAVClient } from "tsdav";

// Builds a CalDAV client (Basic auth). tsdav handles principal / calendar-home
// discovery (incl. iCloud partition hosts) on the first request.
export function createCaldavClient(serverUrl: string, username: string, password: string) {
  return createDAVClient({
    serverUrl,
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
}
