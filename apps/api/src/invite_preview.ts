import { expandRecurringEvents } from "@musubi/calendar";

const INVITE_PREVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type PreviewCalendar = {
  id: string;
  name: string;
  color: string;
};

type PreviewMember = {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
};

type PreviewEvent = {
  events: {
    id: string;
    title: string;
    color: string;
    start: Date;
    end: Date;
    isAllDay: boolean;
    recurrence?: string | null;
    deletedAt?: Date | null;
  };
};

/**
 * The invite token is a capability, but preview possession should reveal only
 * what the invite screen renders: public profile labels and a 30-day agenda.
 */
export function buildInvitePreview(
  calendar: PreviewCalendar,
  members: PreviewMember[],
  rows: PreviewEvent[],
  now = new Date(),
) {
  const previewEndsAt = new Date(now.getTime() + INVITE_PREVIEW_WINDOW_MS);
  const eventDefinitions = rows
    .map((row) => row.events)
    .filter((event) => !event.deletedAt)
    .map((event) => ({
      id: event.id,
      title: event.title,
      color: event.color,
      start: event.start,
      end: event.end,
      isAllDay: event.isAllDay,
      recurrence: event.recurrence ?? null,
    }));
  const events = expandRecurringEvents(eventDefinitions, now, previewEndsAt)
    // The recurrence helper deliberately falls back to the source event when
    // an RRULE is malformed; retain the privacy window even in that case.
    .filter((event) => event.end >= now && event.start <= previewEndsAt)
    .map((event) => ({
      ...event,
      // These are already concrete occurrences. Sending the rule would make
      // the client expand each occurrence a second time.
      recurrence: null,
    }));

  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.color,
    members: members.map(({ user }) => ({
      id: user.id,
      name: user.name,
      image: user.image ?? null,
    })),
    events,
  };
}
