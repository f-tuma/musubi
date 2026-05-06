import { Calendar, Event, Invite, Settings } from "@/constants/types";
import { authClient } from "./auth-client";
import { apiUrl } from "@/constants/url";


export const api = {
  async createCalendar(calendar: Calendar) {
    const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/calendars`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(calendar),
    });

    if (error) throw new Error(error.message ?? error.statusText);


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
    const { error, data } = await authClient.$fetch<Calendar[]>(`${apiUrl}/api/calendars`, {
      method: "GET",
    });

    if (error) throw new Error(error.message ?? error.statusText);
    return data;
  },

  async getCalendar(calendarID: string) {
    const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/calendars/${calendarID}`, {
      method: "GET",
    });

    if (error) throw new Error(error.message ?? error.statusText);
    return data;
  },

  async getCalendarFromToken(token: string) {
    const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/calendars/tokens/${token}`, {
      method: "GET",
    });

    if (error) throw new Error(error.message ?? error.statusText);
    return data;
  },

  async createEvent(event: Event) {
    const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    if (error) throw new Error(error.message ?? error.statusText);


    const newEvent: Event = {
      title: data.title,
      color: data.color,
      id: data.id,
      creatorID: data.creatorID,
      start: new Date(data.start),
      end: new Date(data.end),
      calendars: data.calendars,
    }

    return newEvent;
  },

  async updateCalendar(calendar: Calendar) {
    const { error, data } = await authClient.$fetch<Calendar>(`${apiUrl}/api/calendars`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(calendar),
    });
    if (error) throw new Error(error.message ?? error.statusText);

    return data;
  },

  async removeCalendar(calendar: Calendar) {
    const { error, data } = await authClient.$fetch<{ id: string }>(`${apiUrl}/api/calendars`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },

      body: JSON.stringify(calendar),
    });
    if (error) throw new Error(error.message ?? error.statusText);

    return data.id;
  },

  async updateEvent(event: Event) {
    const { error, data } = await authClient.$fetch<Event>(`${apiUrl}/api/events`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
    if (error) throw new Error(error.message ?? error.statusText);

    return data;
  },

  async removeEvent(event: Event) {
    const { error, data } = await authClient.$fetch<{ id: string }>(`${apiUrl}/api/events`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },

      body: JSON.stringify(event),
    });
    if (error) throw new Error(error.message ?? error.statusText);

    return data.id;
  },

  async getEvents() {
    const { error, data } = await authClient.$fetch<{ events: Event[] }>(`${apiUrl}/api/events`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
      },
    });

    if (error) throw new Error(error.message ?? error.statusText);

    return data.events;
  },

  async createInvite(invite: Invite) {
    const { error, data } = await authClient.$fetch<Invite>(`${apiUrl}/api/calendars/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(invite),
    });

    if (error) throw new Error(error.message ?? error.statusText);

    return data;
  },

  async acceptInvite(calendarID: string) {
    const { error, data } = await authClient.$fetch<Invite>(`${apiUrl}/api/calendars/members/${calendarID}`, {
      method: "POST",
    });

    if (error) throw new Error(error.message ?? error.statusText);

    return data;
  },

  async leaveCalendar(calendarID: string) {
    const { error } = await authClient.$fetch(`${apiUrl}/api/calendars/members/${calendarID}`, {
      method: "DELETE",
    });

    if (error) throw new Error(error.message ?? error.statusText);

    return true;
  },

  async getSettings() {
    const { data, error } = await authClient.$fetch<Settings>(`${apiUrl}/api/users/settings`, {
      method: "GET",
    });

    if (error) throw new Error(error.message ?? error.statusText);

    return data;
  },

  async saveSettings(settings: Settings) {
    console.log(settings);
    const { error } = await authClient.$fetch(`${apiUrl}/api/users/settings`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    if (error) throw new Error(error.message ?? error.statusText);

    return true;
  },
};
