import { bucketEventsByDay, getDaySegments } from "@musubi/calendar/layout";
import type { Calendar, Event, Settings } from "@musubi/types";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { calendarLaneSpans, visibleLaneLimit } from "../all-day-lanes";
import { getEventDateLabel, getEventRangeLabel } from "../calendar-math";
import { toDateKey } from "../date-key";
import { getReadableEventTextColor } from "../event-color";
import { overlapPlacement } from "../time-grid-math";
import type { EventActionHandlers } from "./EventDetailsPopover";
import { EventDetailsPopover } from "./EventDetailsPopover";
import { EventPopover } from "./EventPopover";

// ── Matrix tuning ────────────────────────────────────────────────────────────
/**
 * Narrowest a week block may get before its seven day columns stop being
 * readable. The matrix fits as many columns as this allows and wraps the rest
 * into rows — which is what "automatic matrix by viewport" means in practice.
 */
const MIN_BLOCK_WIDTH_PX = 260;
/**
 * Shortest a block row may get. Rows share the height when they fit and stop
 * shrinking here, so four weeks fill the screen and twenty scroll at a
 * readable size.
 */
const MIN_BLOCK_HEIGHT_PX = 190;
const MULTI_WEEK_EVENT_CAPACITY = 3;
/** One all-day lane: an 11 px bar and a 1 px gap. */
const ALL_DAY_LANE_PX = 12;
const ALL_DAY_BAR_PX = 11;
/**
 * The hours a block shows. A full day squeezed into 190px is a smear; a working
 * window is what makes twenty weeks comparable at a glance. Page-configurable
 * later (`PRD §16.1`), one constant for now so every block shares a scale.
 */
const VISIBLE_START_HOUR = 7;
const VISIBLE_END_HOUR = 21;

const VISIBLE_MINUTES = (VISIBLE_END_HOUR - VISIBLE_START_HOUR) * 60;

/**
 * The hour lines are a background, not elements: twenty blocks × fourteen hours
 * would be 280 divs that never do anything. The gaps are the block's own
 * canvas, so the lines are the only thing drawn.
 */
const BLOCK_GRID_STYLE = {
  "--hour-lines": `repeating-linear-gradient(to bottom, var(--border-subtle) 0 1px, var(--surface-canvas) 1px calc(100% / ${
    VISIBLE_END_HOUR - VISIBLE_START_HOUR
  }))`,
} as CSSProperties;

type MultiWeekCalendarProps = EventActionHandlers & {
  busyEventId?: string;
  calendars: Calendar[];
  events: Event[];
  /** Whole weeks, in order. Each block is one of them. */
  weeks: Date[][];
  timeFormat: Settings["timeFormat"];
  weekStartsOn: Settings["weekStartsOn"];
};

/**
 * Weeks side by side and stacked — the long view.
 *
 * Deliberately NOT the interactive time grid: twenty live grids would each carry
 * drag, resize, hit-testing and a now-marker, and the point of this view is to
 * read many weeks at once. So it reuses the same layout maths (`getDaySegments`,
 * `assignOverlapColumns` via the package, `overlapPlacement`) and renders blocks
 * that answer "how full is that week" — clicking an event still opens the same
 * popover as everywhere else.
 */
export function MultiWeekCalendar({
  busyEventId,
  calendars,
  events,
  timeFormat,
  weeks,
  weekStartsOn,
  ...eventActions
}: MultiWeekCalendarProps) {
  const [columns, setColumns] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);
  const todayKey = toDateKey(new Date());

  // The matrix follows the viewport: as many columns as fit at a readable
  // width, the rest wrap. A page asking for eight weeks gets 4×2 on a laptop
  // and 1×8 on a phone without either being configured.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;

    function measure() {
      if (!frame) return;
      const fit = Math.max(
        1,
        Math.floor(frame.clientWidth / MIN_BLOCK_WIDTH_PX),
      );
      const next = Math.min(fit, weeks.length);
      setColumns((current) => (current === next ? current : next));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [weeks.length]);

  // Plain per-day buckets: a block draws timed events in their own day column,
  // so the month view's continuation metadata would be noise here.
  const byDay = useMemo(() => bucketEventsByDay(events), [events]);

  return (
    <div
      className="grid h-full auto-rows-(--block-rows) grid-cols-(--block-columns) gap-3 overflow-auto p-3 max-sm:gap-2 max-sm:p-2"
      ref={frameRef}
      style={
        {
          "--block-columns": `repeat(${columns}, minmax(0, 1fr))`,
          "--block-rows": `minmax(${MIN_BLOCK_HEIGHT_PX}px, 1fr)`,
        } as CSSProperties
      }
    >
      {weeks.map((week) => (
        <WeekBlock
          busyEventId={busyEventId}
          calendars={calendars}
          days={week}
          eventsByDay={byDay}
          key={toDateKey(week[0]!)}
          timeFormat={timeFormat}
          todayKey={todayKey}
          weekStartsOn={weekStartsOn}
          {...eventActions}
        />
      ))}
    </div>
  );
}

function WeekBlock({
  busyEventId,
  calendars,
  days,
  eventsByDay,
  timeFormat,
  todayKey,
  weekStartsOn,
  ...eventActions
}: EventActionHandlers & {
  busyEventId?: string;
  calendars: Calendar[];
  days: Date[];
  eventsByDay: Map<string, Event[]>;
  timeFormat: Settings["timeFormat"];
  todayKey: string;
  weekStartsOn: Settings["weekStartsOn"];
}) {
  const first = days[0]!;
  const weekEvents = [
    ...new Map(
      days.flatMap((day) =>
        (eventsByDay.get(toDateKey(day)) ?? []).map((event) => [
          event.id,
          event,
        ]),
      ),
    ).values(),
  ];
  const laneSpans = calendarLaneSpans(weekEvents, days);
  const laneCount = Math.max(0, ...laneSpans.map((span) => span.lane + 1));
  const visibleLaneCount = visibleLaneLimit(
    laneCount,
    MULTI_WEEK_EVENT_CAPACITY,
  );

  return (
    <section
      aria-label={`Week of ${first.toLocaleDateString("en", {
        day: "numeric",
        month: "long",
      })}`}
      className="relative flex min-h-0 flex-col overflow-hidden rounded-md border border-border-subtle bg-canvas"
    >
      <header className="grid flex-none grid-cols-7 border-b border-border-subtle bg-raised">
        {days.map((day) => {
          const dayKey = toDateKey(day);
          const today = dayKey === todayKey;

          return (
            // One line, always: a wrapping header would make one block taller
            // than the rest of its row and break the comparison the matrix
            // exists for.
            <div
              className="flex items-baseline justify-center gap-1 overflow-hidden px-0.5 py-1 text-11 whitespace-nowrap not-first:border-l not-first:border-border-subtle"
              data-today={today ? "" : undefined}
              key={dayKey}
            >
              {/* The month rides on the first of it, so a block that crosses a
                  boundary says so without a caption of its own — and it takes
                  the weekday letter's place rather than making the row taller. */}
              {day.getDate() === 1 ? null : (
                <span className="text-muted-foreground">
                  {day.toLocaleDateString("en", { weekday: "narrow" })}
                </span>
              )}
              <span
                className={
                  today
                    ? "rounded-sm bg-shu px-1 font-medium text-shu-foreground tabular-nums"
                    : "text-foreground-secondary tabular-nums"
                }
              >
                {day.getDate() === 1
                  ? day.toLocaleDateString("en", {
                      day: "numeric",
                      month: "short",
                    })
                  : day.getDate()}
              </span>
            </div>
          );
        })}
      </header>

      <div
        className="relative grid min-h-0 flex-1 grid-cols-7 bg-(image:--hour-lines)"
        role="presentation"
        style={BLOCK_GRID_STYLE}
      >
        {days.map((day, dayIndex) => {
          const dayKey = toDateKey(day);
          // Same segmentation and overlap columns as the real week grid, so a
          // busy Tuesday looks busy in both.
          const segments = getDaySegments(eventsByDay.get(dayKey) ?? [], day);
          const dayLaneSpans = laneSpans.filter(
            (span) => span.startCol <= dayIndex && span.endCol >= dayIndex,
          );
          const visibleLaneSpans = dayLaneSpans.filter(
            (span) => span.lane < visibleLaneCount,
          );
          const hiddenLaneSpans = dayLaneSpans.filter(
            (span) => span.lane >= visibleLaneCount,
          );

          return (
            <div
              className={
                dayKey === todayKey
                  ? "relative min-w-0 bg-shu/6 not-first:border-l not-first:border-border-subtle"
                  : "relative min-w-0 not-first:border-l not-first:border-border-subtle"
              }
              data-today={dayKey === todayKey ? "" : undefined}
              key={dayKey}
            >
              {visibleLaneSpans.map((span) => (
                <BlockEvent
                  busyEventId={busyEventId}
                  calendars={calendars}
                  event={span.event}
                  geometry={{
                    height: `${ALL_DAY_BAR_PX}px`,
                    left: "0%",
                    top: `${1 + span.lane * ALL_DAY_LANE_PX}px`,
                    width: "calc(100% - 2px)",
                  }}
                  key={`${span.id}:${dayKey}`}
                  timeFormat={timeFormat}
                  weekStartsOn={weekStartsOn}
                  {...eventActions}
                />
              ))}
              {hiddenLaneSpans.length > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      aria-label={`${hiddenLaneSpans.length} more all-day ${
                        hiddenLaneSpans.length === 1 ? "item" : "items"
                      } on ${day.toLocaleDateString("en", {
                        day: "numeric",
                        month: "long",
                      })}`}
                      className="absolute top-(--block-top) right-0.5 z-2 h-3 rounded-sm bg-panel px-0.5 text-10 leading-none text-foreground-secondary"
                      style={
                        {
                          "--block-top": `${1 + visibleLaneCount * ALL_DAY_LANE_PX}px`,
                        } as CSSProperties
                      }
                      type="button"
                    >
                      +{hiddenLaneSpans.length}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="center"
                    aria-label={`${day.toLocaleDateString("en", {
                      day: "numeric",
                      month: "long",
                    })} hidden all-day items`}
                    role="dialog"
                    side="bottom"
                  >
                    <div className="grid max-h-(--radix-popover-content-available-height) gap-1 overflow-y-auto p-2" data-event-list="overflow">
                      {hiddenLaneSpans.map((span) => (
                        <EventPopover
                          calendar={calendars.find((calendar) =>
                            span.event.calendars.includes(calendar.id),
                          )}
                          calendars={calendars}
                          event={span.event}
                          key={span.id}
                          showLabel
                          timeFormat={timeFormat}
                          weekStartsOn={weekStartsOn}
                          {...eventActions}
                        />
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
              {segments.map((segment) => {
                // Clipped to the visible window rather than dropped: an event
                // that starts at 06:00 still has to be visible at the top edge,
                // or the block quietly lies about how full the day is.
                const top = Math.max(
                  0,
                  segment.startMin - VISIBLE_START_HOUR * 60,
                );
                const bottom = Math.min(
                  VISIBLE_MINUTES,
                  segment.endMin - VISIBLE_START_HOUR * 60,
                );
                if (bottom <= 0 || top >= VISIBLE_MINUTES) return null;

                return (
                  <BlockEvent
                    busyEventId={busyEventId}
                    calendars={calendars}
                    event={segment.event}
                    geometry={{
                      ...overlapPlacement(segment.col, segment.cols),
                      height: `${((bottom - top) / VISIBLE_MINUTES) * 100}%`,
                      top: `${(top / VISIBLE_MINUTES) * 100}%`,
                    }}
                    key={`${segment.event.id}-${segment.startMin}`}
                    timed
                    timeFormat={timeFormat}
                    weekStartsOn={weekStartsOn}
                    {...eventActions}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BlockEvent({
  busyEventId,
  calendars,
  event,
  geometry,
  timed = false,
  timeFormat,
  weekStartsOn,
  ...eventActions
}: EventActionHandlers & {
  busyEventId?: string;
  calendars: Calendar[];
  event: Event;
  geometry: { height: string; left: string; top: string; width: string };
  /** A timed block keeps a sliver of height however short it is. */
  timed?: boolean;
  timeFormat: Settings["timeFormat"];
  weekStartsOn: Settings["weekStartsOn"];
}) {
  const calendar = calendars.find((item) => event.calendars.includes(item.id));
  const pigment = calendar?.color ?? event.color;

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
        aria-busy={busyEventId === event.id || undefined}
        aria-label={`${event.title}, ${getEventDateLabel(event)}, ${getEventRangeLabel(
          event,
          timeFormat,
        )}, ${calendar?.name ?? "calendar"}`}
        className={
          timed
            ? "absolute top-(--block-top) left-(--block-left) z-1 h-(--block-height) min-h-1.5 w-(--block-width) cursor-pointer overflow-hidden rounded-sm bg-pigment px-0.5 text-left text-10 leading-none text-ellipsis whitespace-nowrap text-pigment-ink focus-inset"
            : "absolute top-(--block-top) left-(--block-left) z-1 h-(--block-height) w-(--block-width) cursor-pointer overflow-hidden rounded-sm bg-pigment px-0.5 text-left text-10 leading-none text-ellipsis whitespace-nowrap text-pigment-ink focus-inset"
        }
        style={
          {
            "--block-height": geometry.height,
            "--block-left": geometry.left,
            "--block-top": geometry.top,
            "--block-width": geometry.width,
            "--pigment": pigment,
            "--pigment-ink": getReadableEventTextColor(pigment),
          } as CSSProperties
        }
        type="button"
      >
        <span>{event.title}</span>
      </button>
    </EventDetailsPopover>
  );
}
