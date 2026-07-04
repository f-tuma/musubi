import { Calendar, CalendarWithEvents, Event, Invite, Settings, GoogleCheck } from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { apiVersion } from "@/constants/url";


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

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }


      const newCalendar: Calendar = {
        name: data.name,
        color: data.color,
        id: data.id,
        creatorID: data.creatorID,
        members: data.members,
        invite: "WIP",
      }

      return newCalendar;
    },

    async getCalendars() {
      const { error, data } = await authClient.$fetch<Calendar[]>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
      return data;
    },

    async getCalendar(calendarID: string) {
      const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/${apiVersion}/calendars/${calendarID}`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
      return data;
    },

    async getCalendarFromToken(token: string) {
      const { error, data } = await authClient.$fetch<CalendarWithEvents>(`${apiUrl}/api/${apiVersion}/calendars/tokens/${token}`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
      return data;
    },

    async createEvent(event: Event) {
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }


      const newEvent: Event = {
        ...data,
        start: new Date(data.start),
        end: new Date(data.end),
      }

      return newEvent;
    },

    async linkEvent(eventID: string, calendarID: string) {
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events/${eventID}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calendarID }),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return { ...data, start: new Date(data.start), end: new Date(data.end) } as Event;
    },

    async forkEvent(eventID: string, calendarID: string) {
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events/${eventID}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calendarID }),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return { ...data, start: new Date(data.start), end: new Date(data.end) } as Event;
    },

    async updateCalendar(calendar: Calendar) {
      const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(calendar),
      });
      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data;
    },

    async removeCalendar(calendar: Calendar) {
      const { error, data } = await authClient.$fetch<{ id: string }>(`${apiUrl}/api/${apiVersion}/calendars`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },

        body: JSON.stringify(calendar),
      });
      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data.id;
    },

    async updateEvent(event: Event) {
      const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/${apiVersion}/events`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
      });
      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data;
    },

    async removeEvent(event: Event, unlinkCalendarID?: string) {
      const { error, data } = await authClient.$fetch<{ id: string; calendars: string[]; removed: boolean }>(`${apiUrl}/api/${apiVersion}/events`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },

        body: JSON.stringify({ ...event, unlinkCalendarID }),
      });
      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data;
    },

    async getEvents(since?: Date) {
      const qs = since ? `?since=${encodeURIComponent(since.toISOString())}` : "";

      const { error, data } = await authClient.$fetch<{ events: Event[]; deletedIds: string[]; serverTime: string }>(`${apiUrl}/api/${apiVersion}/events${qs}`, {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data; // { events, deletedIds, serverTime }
    },

    async createInvite(invite: Invite) {
      const { error, data } = await authClient.$fetch<Invite>(`${apiUrl}/api/${apiVersion}/calendars/invites`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(invite),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data;
    },

    async acceptInvite(calendarID: string, token: string) {
      const { error, data } = await authClient.$fetch<Invite>(`${apiUrl}/api/${apiVersion}/calendars/members/${calendarID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data;
    },

    async leaveCalendar(calendarID: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/calendars/members/${calendarID}`, {
        method: "DELETE",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return true;
    },

    async getCalendarMembers(calendarID: string) {
      const { data, error } = await authClient.$fetch<{ id: string; name: string; email: string; image?: string | null; role: string }[]>(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members`,
        { method: "GET" },
      );

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data ?? [];
    },

    async setMemberRole(calendarID: string, userID: string, role: "viewer" | "editor" | "owner") {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
        { method: "PUT", body: { role } },
      );

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return true;
    },

    async removeMember(calendarID: string, userID: string) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
        { method: "DELETE" },
      );

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return true;
    },

    async getSettings() {
      const { data, error } = await authClient.$fetch<Settings>(`${apiUrl}/api/${apiVersion}/users/settings`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

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

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return true;
    },

    async deleteUser() {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users`, {
        method: "DELETE",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return true;
    },

    async checkGoogleStatus() {
      const { error, data } = await authClient.$fetch<GoogleCheck>(`${apiUrl}/api/${apiVersion}/users/connections/google`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data;
    },

    async revokeGoogleConnection() {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/google/revoke`, {
        method: "POST",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      const data = await this.checkGoogleStatus();

      return data;
    },

    async getGoogleCalendars() {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/calendars/google`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
    },

    async connectCaldav(serverUrl: string, username: string, password: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverUrl, username, password }),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
    },

    async getCaldavAccounts() {
      const { error, data } = await authClient.$fetch<{ accounts: { id: string; serverUrl: string; username: string }[] }>(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "GET",
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }

      return data.accounts;
    },

    async disconnectCaldav(accountId: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
    },

    async disconnectAccount(provider: string, accountId: string) {
      const { error } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/users/connections/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, accountId }),
      });

      if (error) { console.error("API error", error); throw new Error(`${error.status}: ${error.message ?? error.statusText}`); }
    }
  }
};
