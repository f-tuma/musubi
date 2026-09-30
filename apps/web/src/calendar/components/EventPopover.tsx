import { isCalendarTask } from "@musubi/calendar";
import type { Calendar, Event, Settings } from "@musubi/types";
import {
  getEventDateLabel,
  getEventRangeLabel,
} from "../calendar-math";
import { getReadableEventTextColor } from "../event-color";
import {
  EventDetailsPopover,
  type EventActionHandlers,
} from "./EventDetailsPopover";
import { EventMarks } from "./EventMarks";
import { cn } from "~/lib/utils";

type ChipShape = { allDay: boolean; continuesAfter?: boolean; continuesBefore?: boolean; labelVisible?: boolean };

/**
 * A calendar chip: the event's pigment, its title in the ink that reads on it.
 * Exported so a drag preview draws the same block.
 *
 * The month root provides the geometry (`--month-chip-height`, `--event-bleed`,
 * `--bleed-one`, `--bleed-both`) and `group/month` with `data-compact` when the
 * grid is too narrow for times. A "+N more" list marks itself with
 * `data-event-list="overflow"`, where the chip becomes a full row.
 */
export function eventChipClassName({ allDay, continuesAfter = false, continuesBefore = false, labelVisible = false }: ChipShape) {
  return cn(
    "group/chip relative z-1 flex min-h-(--month-chip-height) w-full min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-sm border-0 bg-pigment px-1.5 py-0.5 text-left text-(--event-foreground) transition-transform duration-fast hover:-translate-y-px focus-visible:-translate-y-px focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--event-foreground) data-[state=open]:translate-y-0 motion-reduce:transition-none",
    "data-[draggable]:cursor-grab data-[pending]:animate-pulse data-[pending]:cursor-progress motion-reduce:data-[pending]:animate-none motion-reduce:data-[pending]:opacity-70",
    "data-[ghost]:pointer-events-none data-[ghost]:border data-[ghost]:border-dashed data-[ghost]:border-pigment/60 data-[ghost]:bg-pigment/20",
    // Narrow cells trim the inset; a phone cell holds the title alone.
    "max-md:px-1 max-sm:min-h-5 max-sm:gap-0",
    allDay && "font-medium",
    continuesBefore && "-ml-(--event-bleed)",
    continuesBefore && continuesAfter && "w-(--bleed-both) rounded-none",
    continuesBefore !== continuesAfter && "w-(--bleed-one)",
    continuesBefore && !continuesAfter && "rounded-l-none",
    continuesAfter && !continuesBefore && "rounded-r-none",
    labelVisible && "z-2 overflow-visible",
    // Inside "+N more" the chip is a row of the list, not a slice of a cell.
    "in-data-[event-list=overflow]:ml-0 in-data-[event-list=overflow]:min-h-10 in-data-[event-list=overflow]:w-full in-data-[event-list=overflow]:gap-2 in-data-[event-list=overflow]:rounded-chip in-data-[event-list=overflow]:px-3",
  );
}

type EventPopoverProps = EventActionHandlers & {
  calendar: Calendar | undefined;
  calendars: Calendar[];
  continuesAfter?: boolean;
  continuesBefore?: boolean;
  /**
   * This chip is being dragged elsewhere: what stays here is the shape it would
   * leave behind, so the day it came from stays readable.
   */
  ghost?: boolean;
  event: Event;
  /** Absent when the event may not be moved by dragging. */
  onBeginDrag?: (pointerEvent: React.PointerEvent<HTMLElement>) => void;
  /** A write for this event is in flight. */
  pending?: boolean;
  showLabel?: boolean;
  timeFormat: Settings["timeFormat"];
  weekStartsOn: Settings["weekStartsOn"];
};

export function EventPopover({
  calendar,
  calendars,
  continuesAfter = false,
  continuesBefore = false,
  event,
  ghost = false,
  onBeginDrag,
  pending = false,
  showLabel = true,
  timeFormat,
  weekStartsOn,
  ...eventActions
}: EventPopoverProps) {
  const eventColor = calendar?.color ?? event.color;

  return (
    <EventDetailsPopover
      calendar={calendar}
      calendars={calendars}
      event={event}
      timeFormat={timeFormat}
      weekStartsOn={weekStartsOn}
      {...eventActions}
    >
      <button
        className={eventChipClassName({ allDay: event.isAllDay, continuesAfter, continuesBefore, labelVisible: event.isAllDay && showLabel && continuesAfter })}
        type="button"
        aria-label={`${isCalendarTask(event) ? "Task, " : ""}${event.title}, ${getEventDateLabel(
          event,
        )}, ${getEventRangeLabel(event, timeFormat)}, ${calendar?.name ?? "calendar"}`}
        aria-busy={pending || undefined}
        data-ghost={ghost ? "" : undefined}
        data-draggable={onBeginDrag ? "" : undefined}
        data-pending={pending ? "" : undefined}
        data-event-id={event.id}
        data-task-completed={isCalendarTask(event) && event.calendarTask.status === "completed" ? "" : undefined}
        onPointerDown={onBeginDrag}
        style={{
          "--pigment": eventColor,
          // A ghost is drawn as an outline over the page, not as a filled
          // block, so the event's own foreground would be white on a 18%
          // tint. Ink is what stays readable there.
          "--event-foreground": ghost ? "var(--text-secondary)" : getReadableEventTextColor(eventColor),
        } as React.CSSProperties}
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        {!event.isAllDay ? (
          <span className="flex-none font-mono text-10 group-data-compact/month:not-in-data-[event-list=overflow]:hidden" aria-hidden="true" data-event-time="">
            {getEventRangeLabel(event, timeFormat).split(" ")[0]}
          </span>
        ) : null}
        <span className={cn("min-w-0 flex-1 truncate text-10 group-data-[task-completed]/chip:line-through in-data-[event-list=overflow]:text-13", event.isAllDay && showLabel && continuesAfter && "overflow-visible text-clip")} aria-hidden="true" data-event-title="">
          {showLabel ? event.title : ""}
        </span>
        {showLabel && (isCalendarTask(event) || event.recurrence || event.hasAttendees) ? (
          <span className="flex flex-none max-sm:not-in-data-[event-list=overflow]:hidden" data-event-marks="">
            <EventMarks event={event} />
          </span>
        ) : null}
      </button>
    </EventDetailsPopover>
  );
}
