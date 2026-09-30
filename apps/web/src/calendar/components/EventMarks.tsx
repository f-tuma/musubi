import { TaskStatusIcon } from "./TaskStatusIcon";
import { isCalendarTask } from "@musubi/calendar";
import type { Event } from "@musubi/types";
import { Lock, Repeat, Users } from "lucide-react";

/** Inline after a title, in the ink of whatever it sits on. */
const MARKS = "ml-1 inline-flex items-center gap-0.5 align-middle opacity-85";

/**
 * The non-colour half of an event's identity (R9).
 *
 * The colour says which calendar; these say what kind of event it is. They are
 * `aria-hidden` because the button's label already spells everything out — this
 * is redundancy for people reading the pixels, not a second announcement.
 */
export function EventMarks({
  event,
  readOnly = false,
}: {
  event: Event;
  readOnly?: boolean;
}) {
  if (isCalendarTask(event)) {
    return (
      <span aria-hidden="true" className={MARKS} data-event-marks="">
        <TaskStatusIcon status={event.calendarTask.status} size={12} />
      </span>
    );
  }
  if (!event.recurrence && !event.hasAttendees && !readOnly) {
    return null;
  }

  return (
    <span aria-hidden="true" className={MARKS} data-event-marks="">
      {event.recurrence ? <Repeat size={11} strokeWidth={2} /> : null}
      {event.hasAttendees ? <Users size={11} strokeWidth={2} /> : null}
      {readOnly ? <Lock size={11} strokeWidth={2} /> : null}
    </span>
  );
}
