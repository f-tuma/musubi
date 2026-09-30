import { isCalendarTask } from "@musubi/calendar";
import {
  can,
  EventMutationError,
  providerDisplayName,
  type Calendar,
  type Event,
} from "@musubi/types";
import { ApiError, ApiResponseError } from "~/api/http";

export function getEditableCalendars(calendars: Calendar[]) {
  return calendars.filter(
    (calendar) =>
      calendar.supportsEvents !== false && can(calendar.role, "editEvents"),
  );
}

export function getEditableTaskCalendars(calendars: Calendar[]) {
  return calendars.filter(
    (calendar) =>
      calendar.supportsTasks !== false && can(calendar.role, "editTasks"),
  );
}

export function canEditEvent(event: Event, calendars: Calendar[]) {
  if (isCalendarTask(event)) return false;
  if (event.originCalendarID) {
    return can(
      calendars.find((calendar) => calendar.id === event.originCalendarID)
        ?.role,
      "editEvents",
    );
  }

  return event.calendars.some((calendarId) =>
    can(
      calendars.find((calendar) => calendar.id === calendarId)?.role,
      "editEvents",
    ),
  );
}

export function canRemoveEvent(event: Event, calendars: Calendar[]) {
  if (isCalendarTask(event)) return false;
  return event.calendars.some((calendarId) =>
    can(
      calendars.find((calendar) => calendar.id === calendarId)?.role,
      "editEvents",
    ),
  );
}

/**
 * The calendar an event belongs to, as opposed to the ones it also appears in.
 *
 * One definition, because everything that shows an event has to agree on it: the
 * colour it takes, the star on its pill, and where a write is routed. Falling
 * back to the first membership covers events created before the field existed.
 */
export function eventHomeCalendarId(event: Event): string | undefined {
  return event.originCalendarID ?? event.calendars[0];
}

export function getEventHomeCalendar(event: Event, calendars: Calendar[]) {
  const homeId = eventHomeCalendarId(event);
  return calendars.find((calendar) => calendar.id === homeId);
}

type MutationAction = "create" | "delete" | "update";

const actionCopy: Record<MutationAction, string> = {
  create: "create",
  delete: "delete",
  update: "save",
};

export function getEventMutationError(
  error: unknown,
  action: MutationAction,
  calendar?: Calendar,
) {
  if (error instanceof EventMutationError) return { message: error.message };
  const requestId =
    error instanceof ApiError || error instanceof ApiResponseError
      ? error.requestId
      : undefined;

  if (error instanceof ApiError && error.reason) {
    return { message: error.message, requestId };
  }

  if (error instanceof ApiError && error.status === 403) {
    return {
      message:
        "Your calendar access changed. Reload before trying this action again.",
      requestId,
    };
  }

  if (calendar?.provider) {
    return {
      message: `${providerDisplayName(
        calendar,
      )} did not confirm this change. Refresh the calendar before retrying to avoid a duplicate.`,
      requestId,
    };
  }

  if (error instanceof DOMException || error instanceof TypeError) {
    return {
      message:
        "Musubi could not be reached. Check your connection and try again.",
      requestId,
    };
  }

  return {
    message: `Musubi could not ${actionCopy[action]} this event. ${
      error instanceof Error ? error.message : "Try again."
    }`,
    requestId,
  };
}

export function isQuickEditableEvent(event: Event) {
  if (event.recurrence) {
    return false;
  }

  if (!event.isAllDay) {
    return true;
  }

  return event.end.getTime() - event.start.getTime() <= 86_400_000;
}
