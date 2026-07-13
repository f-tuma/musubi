import { Calendar, CalendarWithEvents, Event, Invite, Settings, GoogleCheck } from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { apiVersion } from "@/constants/url";
import { fedFetch, remoteForCalendar } from "@/services/federation";
import { notifySessionExpired } from "@/lib/signOut";

// Federation: calendars shared from another Musubi server live at that server.
// Calendar-scoped calls check the registry and, when the calendar is remote,
// run against its origin with our member token — same endpoints, same shapes.
const remoteOf = (calendarID: string | null | undefined) => remoteForCalendar(calendarID);
const eventHome = (event: Event) => event.originCalendarID ?? event.calendars?.[0];

// Names + avatars only — the API deliberately sends no attendee emails.
export type Attendee = { id: string; name: string; image?: string | null };

// Every endpoint below did the same check inline; keep it in one place.
// `asserts error is null` preserves the narrowing the inline `if (error) throw`
// gave — after the call, TS knows `data` is non-null.
function throwOnError(error: { status?: number | string; message?: string; statusText?: string } | null): asserts error is null {
  if (error) {
    // Dead session — hand off to the recovery flow (registered by the signed-in
    // layout; a no-op on auth screens). Still throws so the caller fails loudly.
    if (error.status === 401) notifySessionExpired();
    console.error("API error", error);
    throw new Error(`${error.status}: ${error.message ?? error.statusText}`);
  }
}

export function useApi() {

  const { authClient, apiUrl } = useServer();

  return {
    async createCalendar(calendar: Calendar) {
      const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(calendar),
      });

      throwOnError(error);


      // Pass the server response through whole — rebuilding the object here
      // silently dropped `role: "owner"`, so the creator didn't get owner
      // actions (invite, roles) until the next full sync.
      return { ...data, invite: "WIP" };
    },

    async getCalendars() {
      const { error, data } = await authClient.$fetch<Calendar[]>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: "GET",
      });

      throwOnError(error);
      return data;
    },

    async getCalendar(calendarID: string) {
      const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/${apiVersion}/calendars/${calendarID}`, {
        method: "GET",
      });

      throwOnError(error);
      return data;
    },

    async getCalendarFromToken(token: string) {
      const { error, data } = await authClient.$fetch<CalendarWithEvents>(`${apiUrl}/api/${apiVersion}/calendars/tokens/${token}`, {
        method: "GET",
      });

      throwOnError(error);
      return data;
    },

    async createEvent(event: Event) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        const data = await fedFetch<Event>(remote, `/api/${apiVersion}/events`, {
          method: "POST", body: JSON.stringify(event),
        });
        return { ...data, start: new Date(data.start), end: new Date(data.end) };
      }
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      });

      throwOnError(error);


      const newEvent: Event = {
        ...data,
        start: new Date(data.start),
        end: new Date(data.end),
      }

      return newEvent;
    },

    async linkEvent(eventID: string, calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        const data = await fedFetch<Event>(remote, `/api/${apiVersion}/events/${eventID}/link`, {
          method: "POST", body: JSON.stringify({ calendarID }),
        });
        return { ...data, start: new Date(data.start), end: new Date(data.end) } as Event;
      }
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events/${eventID}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calendarID }),
      });

      throwOnError(error);

      return { ...data, start: new Date(data.start), end: new Date(data.end) } as Event;
    },

    async forkEvent(eventID: string, calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        const data = await fedFetch<Event>(remote, `/api/${apiVersion}/events/${eventID}/fork`, {
          method: "POST", body: JSON.stringify({ calendarID }),
        });
        return { ...data, start: new Date(data.start), end: new Date(data.end) } as Event;
      }
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events/${eventID}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calendarID }),
      });

      throwOnError(error);

      return { ...data, start: new Date(data.start), end: new Date(data.end) } as Event;
    },

    async updateCalendar(calendar: Calendar) {
      const remote = remoteOf(calendar.id);
      if (remote) {
        return fedFetch<Calendar>(remote, `/api/${apiVersion}/calendars`, {
          method: "PUT", body: JSON.stringify(calendar),
        });
      }
      const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(calendar),
      });
      throwOnError(error);

      return data;
    },

    async removeCalendar(calendar: Calendar) {
      const remote = remoteOf(calendar.id);
      if (remote) {
        const data = await fedFetch<{ id: string }>(remote, `/api/${apiVersion}/calendars`, {
          method: "DELETE", body: JSON.stringify(calendar),
        });
        return data.id;
      }
      const { error, data } = await authClient.$fetch<{ id: string }>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },

        body: JSON.stringify(calendar),
      });
      throwOnError(error);

      return data.id;
    },

    async updateEvent(event: Event) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return fedFetch<Event>(remote, `/api/${apiVersion}/events`, {
          method: "PUT", body: JSON.stringify(event),
        });
      }
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      });
      throwOnError(error);

      return data;
    },

    async removeEvent(event: Event, unlinkCalendarID?: string) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return fedFetch<{ id: string; calendars: string[]; removed: boolean }>(remote, `/api/${apiVersion}/events`, {
          method: "DELETE", body: JSON.stringify({ ...event, unlinkCalendarID }),
        });
      }
      const { error, data } = await authClient.$fetch<{ id: string; calendars: string[]; removed: boolean }>(`${apiUrl}/api/${apiVersion}/events`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },

        body: JSON.stringify({ ...event, unlinkCalendarID }),
      });
      throwOnError(error);

      return data;
    },

    async getEventAttendees(event: Event) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return (await fedFetch<Attendee[]>(remote, `/api/${apiVersion}/events/${event.id}/attendees`, { method: "GET" })) ?? [];
      }
      const { error, data } = await authClient.$fetch<Attendee[]>(`${apiUrl}/api/${apiVersion}/events/${event.id}/attendees`, {
        method: "GET",
      });

      throwOnError(error);

      return data ?? [];
    },

    async setAttendance(event: Event, attending: boolean) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return (await fedFetch<Attendee[]>(remote, `/api/${apiVersion}/events/${event.id}/attendance`, {
          method: "PUT", body: JSON.stringify({ attending }),
        })) ?? [];
      }
      const { error, data } = await authClient.$fetch<Attendee[]>(`${apiUrl}/api/${apiVersion}/events/${event.id}/attendance`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attending }),
      });

      throwOnError(error);

      return data ?? [];
    },

    async getEvents(since?: Date) {
      const qs = since ? `?since=${encodeURIComponent(since.toISOString())}` : "";

      const { error, data } = await authClient.$fetch<{ events: Event[]; deletedIds: string[]; serverTime: string }>(`${apiUrl}/api/${apiVersion}/events${qs}`, {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
      });

      throwOnError(error);

      return data; // { events, deletedIds, serverTime }
    },

    async createInvite(invite: Invite) {
      const remote = remoteOf(invite.calendarID);
      if (remote) {
        return fedFetch<Invite>(remote, `/api/${apiVersion}/calendars/invites`, {
          method: "POST", body: JSON.stringify(invite),
        });
      }
      const { error, data } = await authClient.$fetch<Invite>(`${apiUrl}/api/${apiVersion}/calendars/invites`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(invite),
      });

      throwOnError(error);

      return data;
    },

    async getInvites(calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        return (await fedFetch<Invite[]>(remote, `/api/${apiVersion}/calendars/${calendarID}/invites`, { method: "GET" })) ?? [];
      }
      const { error, data } = await authClient.$fetch<Invite[]>(`${apiUrl}/api/${apiVersion}/calendars/${calendarID}/invites`, {
        method: "GET",
      });

      throwOnError(error);

      return data ?? [];
    },

    async revokeInvite(calendarID: string, inviteID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(remote, `/api/${apiVersion}/calendars/invites/${inviteID}`, { method: "DELETE" });
        return true;
      }
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/calendars/invites/${inviteID}`, {
        method: "DELETE",
      });

      throwOnError(error);

      return true;
    },

    async acceptInvite(calendarID: string, token: string) {
      const { error, data } = await authClient.$fetch<Invite>(`${apiUrl}/api/${apiVersion}/calendars/members/${calendarID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });

      throwOnError(error);

      return data;
    },

    async uploadAvatar(base64: string) {
      const { error, data } = await authClient.$fetch<{ url: string }>(`${apiUrl}/api/${apiVersion}/users/avatar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: base64 }),
      });

      throwOnError(error);
      return data.url;
    },

    async leaveCalendar(calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(remote, `/api/${apiVersion}/calendars/members/${calendarID}`, { method: "DELETE" });
        return true;
      }
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/calendars/members/${calendarID}`, {
        method: "DELETE",
      });

      throwOnError(error);

      return true;
    },

    async getCalendarMembers(calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        return (await fedFetch<{ id: string; name: string; email: string; image?: string | null; role: string }[]>(
          remote, `/api/${apiVersion}/calendars/${calendarID}/members`, { method: "GET" })) ?? [];
      }
      const { data, error } = await authClient.$fetch<{ id: string; name: string; email: string; image?: string | null; role: string }[]>(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members`,
        { method: "GET" },
      );

      throwOnError(error);

      return data ?? [];
    },

    async setMemberRole(calendarID: string, userID: string, role: "viewer" | "editor" | "owner") {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(remote, `/api/${apiVersion}/calendars/${calendarID}/members/${userID}`, {
          method: "PUT", body: JSON.stringify({ role }),
        });
        return true;
      }
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
        { method: "PUT", body: { role } },
      );

      throwOnError(error);

      return true;
    },

    async removeMember(calendarID: string, userID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(remote, `/api/${apiVersion}/calendars/${calendarID}/members/${userID}`, { method: "DELETE" });
        return true;
      }
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
        { method: "DELETE" },
      );

      throwOnError(error);

      return true;
    },

    async getSettings() {
      const { data, error } = await authClient.$fetch<Settings>(`${apiUrl}/api/${apiVersion}/users/settings`, {
        method: "GET",
      });

      throwOnError(error);

      return data;
    },

    async saveSettings(settings: Settings) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/settings`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(settings),
      });

      throwOnError(error);

      return true;
    },

    async deleteUser() {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users`, {
        method: "DELETE",
      });

      throwOnError(error);

      return true;
    },

    async checkGoogleStatus() {
      const { error, data } = await authClient.$fetch<GoogleCheck>(`${apiUrl}/api/${apiVersion}/users/connections/google`, {
        method: "GET",
      });

      throwOnError(error);

      return data;
    },

    async revokeGoogleConnection() {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/google/revoke`, {
        method: "POST",
      });

      throwOnError(error);

      const data = await this.checkGoogleStatus();

      return data;
    },

    async getGoogleCalendars() {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/calendars/google`, {
        method: "GET",
      });

      throwOnError(error);
    },

    async connectCaldav(serverUrl: string, username: string, password: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverUrl, username, password }),
      });

      throwOnError(error);
    },

    async getCaldavAccounts() {
      const { error, data } = await authClient.$fetch<{ accounts: { id: string; serverUrl: string; username: string }[] }>(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "GET",
      });

      throwOnError(error);

      return data.accounts;
    },

    async disconnectCaldav(accountId: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });

      throwOnError(error);
    },

    // Federated Musubi connections live on the HOME server (encrypted at rest)
    // so they roam across devices — always home-routed, never federated.
    async getMusubiAccounts() {
      const { error, data } = await authClient.$fetch<{ accounts: { server: string; userID: string; token: string }[] }>(
        `${apiUrl}/api/${apiVersion}/users/connections/musubi`, { method: "GET" });
      throwOnError(error);
      return data.accounts;
    },

    async saveMusubiAccount(account: { server: string; userID: string; token: string }) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/musubi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account),
      });
      throwOnError(error);
      return true;
    },

    async deleteMusubiAccount(server: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/musubi`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server }),
      });
      throwOnError(error);
      return true;
    },

    async disconnectAccount(provider: string, accountId: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, accountId }),
      });

      throwOnError(error);
    }
  }
};
