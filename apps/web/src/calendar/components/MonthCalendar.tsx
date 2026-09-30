import type { Calendar, Event, Settings } from "@musubi/types";
import { eventDayKeys, getMonthGrid } from "@musubi/calendar/layout";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getEventRangeLabel,
  getLongDateLabel,
  getWeekdayLabels,
} from "../calendar-math";
import { calendarLaneSpans, visibleLaneLimit } from "../all-day-lanes";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { dayDelta, shiftDayKey, toDateKey } from "../date-key";
import { getReadableEventTextColor } from "../event-color";
import { canEditEvent, eventHomeCalendarId } from "../event-permissions";
import { useLayerDismissGuard } from "../layer-focus";
import { movePreviewRange } from "../time-grid-drag";
import { useDayRangeCreate, useMonthDrag } from "../use-time-grid-drag";
import { EventPopover } from "./EventPopover";
import type { EventActionHandlers } from "./EventDetailsPopover";

const DEFAULT_EVENT_CAPACITY = 3;

// ── Cell geometry ───────────────────────────────────────────────────────────
// One set of numbers for the CSS and the capacity maths, so "+N more" appears
// exactly where the chips stop fitting.
/** One chip line: a chip, a reserved slot and the draft pill all share it. */
const CHIP_HEIGHT_PX = 21;
/** `gap-0.5` between chip lines. */
const CHIP_GAP_PX = 2;
/**
 * A cell's space that is not chip lines: `pt-1.5` + the `size-6` day number +
 * `pt-0.5` + `pb-1` + the 1 px rule, rounded up.
 */
const DAY_FIXED_SPACE_PX = 38;
/**
 * A cell narrower than about 95 px has no room for a chip's time next to its
 * title. Seven of them is 665 px — measured on the grid itself, so a docked
 * inspector gets the compact cell without losing any day columns.
 */
const COMPACT_GRID_WIDTH_PX = 665;
/**
 * A continuing bar reaches across the cell's inline padding and the 1 px rule
 * to join its neighbour: 6 px padding + 1, or 4 + 1 in a compact grid.
 */
const EVENT_BLEED_PX = 7;
const COMPACT_EVENT_BLEED_PX = 5;


function eventCapacityForGrid(grid: HTMLElement, rows: number) {
  // SSR, jsdom and a temporarily hidden workspace do not have a measurable
  // layout. Keep the established density until a real grid size is available.
  if (grid.clientHeight <= 0) return DEFAULT_EVENT_CAPACITY;

  const rowHeight = grid.clientHeight / rows;
  const availableHeight = Math.max(0, rowHeight - DAY_FIXED_SPACE_PX);

  return Math.max(
    1,
    Math.floor((availableHeight + CHIP_GAP_PX) / (CHIP_HEIGHT_PX + CHIP_GAP_PX)),
  );
}

type MonthCalendarProps = EventActionHandlers & {
  anchor: Date;
  /**
   * The exact grid to draw, as whole weeks. Defaults to the anchor's month,
   * which is what "Month" means; multi-week passes its own run of weeks and
   * gets the same cells, chips, overflow and drag behaviour for free.
   */
  days?: Date[];
  /** What a screen reader calls this grid. Defaults to the anchor's month. */
  gridLabel?: string;
  /**
   * Smallest a week row may get. Month leaves it at zero so six rows always fit
   * their area; a long multi-week run sets it and lets the area scroll.
   */
  rowMinHeight?: string;
  /**
   * Dim the days that fall outside the anchor's month. True for Month, where
   * the edges are padding; false wherever every day on screen is equally the
   * point.
   */
  dimOutsideMonth?: boolean;
  /** The event a write is in flight for, so its chip can say so. */
  busyEventId?: string;
  calendars: Calendar[];
  events: Event[];
  onCreateAtDate?: (
    date: string,
    target: HTMLElement,
    /** Set when days were dragged across: an all-day range. */
    endDate?: string,
  ) => void;
  /** The slot a quick-create popover is open for: the draft, shown as a pill. */
  /** Drops the draft the open quick create describes, before a new one starts. */
  onCancelDraft?: () => void;
  pendingCreate?: { color?: string; date: string; endDate?: string };
  /**
   * Move the draft to another day range while its popover is open. Absent leaves
   * the draft as a still pill.
   */
  onMoveDraft?: (input: { date: string; endDate: string }) => void;
  onMonthChange: (offset: number) => void;
  /**
   * Move an event by the days dragged, keeping its time. The origin is the day
   * the block was grabbed on, not the event's first day: a multi-day bar
   * grabbed in the middle keeps that offset instead of restarting on the drop
   * day, which is also what the preview draws. Absent leaves the month
   * read-only for direct manipulation.
   */
  onMoveEventToDate?: (input: {
    dayKey: string;
    event: Event;
    originDayKey: string;
  }) => Promise<unknown>;
  /**
   * Page presentation. When false, cells belonging to the neighbouring months
   * render empty — the cell itself stays so the month never changes height.
   */
  showAdjacentDays?: boolean;
  timeFormat: Settings["timeFormat"];
  weekStartsOn: Settings["weekStartsOn"];
};

export function MonthCalendar({
  anchor,
  busyEventId,
  calendars,
  days: providedDays,
  dimOutsideMonth = true,
  events,
  gridLabel,
  rowMinHeight,
  onCreateAtDate,
  onMonthChange,
  onMoveDraft,
  onMoveEventToDate,
  onCancelDraft,
  pendingCreate,
  showAdjacentDays = true,
  timeFormat,
  weekStartsOn,
  ...eventActions
}: MonthCalendarProps) {
  // The first background gesture only dismisses the open panel or menu.
  const dismissGuard = useLayerDismissGuard();
  const {
    begin: beginRangeCreate,
    consumeClick,
    range,
  } = useDayRangeCreate({
    onSelected: ({ fromKey, toKey }, cell) => {
      // Dragging backwards is as valid as forwards.
      const [start, end] =
        fromKey <= toKey ? [fromKey, toKey] : [toKey, fromKey];
      // Anchor on the last day of the range, so the popover opens past the end
      // of the pill rather than across it.
      const endCell = document.querySelector<HTMLElement>(
        `[data-day-key="${end}"]`,
      );
      onCreateAtDate?.(start, endCell ?? cell, end);
    },
  });

  // The draft the open popover describes, as a day range. Dragging it moves the
  // whole range, so the pill is grabbable the way a real chip is.
  const { begin: beginDraftDrag, drag: draftDrag } = useMonthDrag<undefined>({
    onCommit: async ({ dayKey: targetKey, originDayKey }) => {
      if (!pendingCreate || !onMoveDraft) return;
      const shift = dayDelta(originDayKey, targetKey);
      onMoveDraft({
        date: shiftDayKey(pendingCreate.date, shift),
        endDate: shiftDayKey(
          pendingCreate.endDate ?? pendingCreate.date,
          shift,
        ),
      });
    },
    onError: eventActions.onNotice,
  });

  /**
   * The pill's range, whether it is being dragged out right now or already
   * belongs to an open draft.
   *
   * The live drag draws the same pill rather than tinting the cells it crosses:
   * the time grid paints the block you are about to create while you drag it, and
   * a month cell should answer the gesture with the thing it will produce too.
   */
  const draftRange = useMemo(() => {
    if (range) {
      const [first, second] = [range.fromKey, range.toKey];
      return first <= second
        ? { from: first, live: true, to: second }
        : { from: second, live: true, to: first };
    }
    if (!pendingCreate) return undefined;
    // While the pill is being dragged it follows the pointer, before anything
    // is written back to the intent.
    const shift = draftDrag
      ? dayDelta(draftDrag.originDayKey, draftDrag.dayKey)
      : 0;
    const from = shiftDayKey(pendingCreate.date, shift);
    const to = shiftDayKey(pendingCreate.endDate ?? pendingCreate.date, shift);
    return from <= to
      ? { from, live: false, to }
      : { from: to, live: false, to: from };
  }, [draftDrag, pendingCreate, range]);

  const { begin: beginMonthDrag, drag } = useMonthDrag({
    onCommit: async ({ dayKey: targetKey, event, originDayKey }) => {
      await onMoveEventToDate?.({ dayKey: targetKey, event, originDayKey });
    },
    onError: eventActions.onNotice,
  });
  /**
   * Where the dragged event would land, as a day range — derived the way
   * draftRange derives the pill's, so a move previews across the days it takes
   * instead of collapsing into the cell under the pointer.
   *
   * A timed event lives on its start day whatever hours it spans, because that
   * is the only cell segmentEventsByDay gives it, so it is the only cell to
   * preview.
   */
  const previewRange = useMemo(
    () =>
      drag
        ? movePreviewRange(
            drag.event.isAllDay
              ? eventDayKeys(drag.event)
              : [drag.originDayKey],
            dayDelta(drag.originDayKey, drag.dayKey),
          )
        : undefined,
    [drag],
  );
  const days = useMemo(
    () => providedDays ?? getMonthGrid(anchor, weekStartsOn),
    [anchor, providedDays, weekStartsOn],
  );
  const weekdayLabels = getWeekdayLabels(weekStartsOn);
  const rows = Math.max(1, Math.round(days.length / 7));
  const weeks = useMemo(
    () =>
      Array.from({ length: rows }, (_, weekIndex) =>
        days.slice(weekIndex * 7, weekIndex * 7 + 7),
      ),
    [days, rows],
  );
  const calendarsById = useMemo(
    () => new Map(calendars.map((calendar) => [calendar.id, calendar])),
    [calendars],
  );
  const dragPreviewColor = drag
    ? (calendarsById.get(eventHomeCalendarId(drag.event) ?? "")?.color ??
      drag.event.color)
    : "transparent";
  const todayKey = toDateKey(new Date());
  const initialFocusIndex = Math.max(
    0,
    days.findIndex((day) => toDateKey(day) === toDateKey(anchor)),
  );
  const [focusedIndex, setFocusedIndex] = useState(initialFocusIndex);
  const [eventCapacity, setEventCapacity] = useState(DEFAULT_EVENT_CAPACITY);
  const [compact, setCompact] = useState(false);
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;

    function syncEventCapacity() {
      if (!grid) return;
      const nextCapacity = eventCapacityForGrid(grid, rows);
      setEventCapacity((current) =>
        current === nextCapacity ? current : nextCapacity,
      );
      if (grid.clientWidth > 0) {
        setCompact(grid.clientWidth < COMPACT_GRID_WIDTH_PX);
      }
    }

    syncEventCapacity();
    const observer = new ResizeObserver(syncEventCapacity);
    observer.observe(grid);
    return () => observer.disconnect();
    // Row count changes the height each row gets, and with it how many chips
    // fit before "+N more" — a multi-week page re-measures when it grows.
  }, [rows]);

  function focusCell(index: number) {
    const bounded = Math.min(days.length - 1, Math.max(0, index));
    setFocusedIndex(bounded);
    requestAnimationFrame(() => cellRefs.current[bounded]?.focus());
  }

  function handleGridKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    index: number,
  ) {
    if (event.target !== event.currentTarget) {
      return;
    }

    const moves: Partial<Record<string, number>> = {
      ArrowDown: 7,
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
    };
    const move = moves[event.key];

    if (move !== undefined) {
      event.preventDefault();
      const next = index + move;

      if (next < 0) {
        onMonthChange(-1);
      } else if (next >= days.length) {
        onMonthChange(1);
      } else {
        focusCell(next);
      }
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusCell(index - (index % 7));
    } else if (event.key === "End") {
      event.preventDefault();
      focusCell(index + (6 - (index % 7)));
    } else if (event.key === "PageUp") {
      event.preventDefault();
      onMonthChange(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      onMonthChange(1);
    } else if (onCreateAtDate && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onCreateAtDate(toDateKey(days[index]!), event.currentTarget);
    }
  }

  return (
    <div
      className="group/month flex h-full min-h-0 min-w-0 flex-col"
      data-compact={compact ? "" : undefined}
      data-event-capacity={eventCapacity}
      role="grid"
      style={
        {
          "--month-chip-height": `${CHIP_HEIGHT_PX}px`,
          "--event-bleed": `${compact ? COMPACT_EVENT_BLEED_PX : EVENT_BLEED_PX}px`,
          "--bleed-one": "calc(100% + var(--event-bleed))",
          "--bleed-both": "calc(100% + 2 * var(--event-bleed))",
        } as CSSProperties
      }
      aria-label={
        gridLabel ??
        `${anchor.toLocaleDateString("en", {
          month: "long",
          year: "numeric",
        })} calendar`
      }
    >
      <div
        className="grid h-8 flex-none grid-cols-7 border-b border-border-subtle md:h-9"
        role="row"
      >
        {weekdayLabels.map((weekday) => (
          <div
            className="flex items-center justify-center text-10 tracking-label text-muted-foreground uppercase not-first:border-l not-first:border-border-subtle"
            role="columnheader"
            key={weekday}
          >
            {weekday}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-rows-(--month-rows)"
        ref={gridRef}
        role="rowgroup"
        style={
          {
            // Six rows for a month, one to twenty for multi-week. The minimum is
            // zero for Month, which must fit its area without scrolling;
            // multi-week raises it so a long run stays readable and scrolls.
            "--month-rows": `repeat(${rows}, minmax(${rowMinHeight ?? "0px"}, 1fr))`,
          } as CSSProperties
        }
      >
        {weeks.map((week, weekIndex) => {
          const weekFrom = toDateKey(week[0]!);
          const weekTo = toDateKey(week[week.length - 1]!);
          // A range in play reserves a line in every cell of the rows it
          // touches, not only the ones it covers: an all-day event is one block
          // per cell, so a cell that did not step aside would break the bar it
          // carries a day short of the range.
          // Draft and move previews consume real slots. Apply the same budget
          // to the whole week so multi-day bars remain aligned without pushing
          // the overflow link into the following week's date heading.
          const rowHits = (from: string, to: string) =>
            from <= weekTo && to >= weekFrom;
          const draftRow = Boolean(
            draftRange && rowHits(draftRange.from, draftRange.to),
          );
          // The two runs, not the span between them: a row that holds neither
          // the preview nor the ghost has nothing to step aside for.
          const previewRow = Boolean(
            previewRange &&
              (rowHits(previewRange.from, previewRange.to) ||
                rowHits(previewRange.originFrom, previewRange.originTo)),
          );
          const laneSpans = calendarLaneSpans(events, week, true);
          const laneCount = Math.max(
            0,
            ...laneSpans.map((span) => span.lane + 1),
          );
          const reservedSlots = Number(draftRow) + Number(previewRow);
          const visibleLaneCount = visibleLaneLimit(laneCount, Math.max(0, eventCapacity - reservedSlots));

          return (
            // Clipped, so a multi-day join never paints into another week.
            <div className="grid min-h-0 grid-cols-7 overflow-clip" role="row" key={weekFrom}>
              {week.map((day, dayIndex) => {
                const index = weekIndex * 7 + dayIndex;
                const dateKey = toDateKey(day);
                const dayLaneSpans = laneSpans.filter(
                  (span) =>
                    span.startCol <= dayIndex && span.endCol >= dayIndex,
                );
                const inMonth =
                  !dimOutsideMonth || day.getMonth() === anchor.getMonth();
                const isToday = dateKey === todayKey;
                const weekend = day.getDay() === 0 || day.getDay() === 6;
                // A hidden adjacent day keeps its cell (so the month keeps its
                // height) but shows nothing and takes no clicks.
                const muted = !inMonth && !showAdjacentDays;
                const inDraft = Boolean(
                  draftRange &&
                    dateKey >= draftRange.from &&
                    dateKey <= draftRange.to,
                );
                const inPreview = Boolean(
                  previewRange &&
                    dateKey >= previewRange.from &&
                    dateKey <= previewRange.to,
                );
                const dragged =
                  previewRow && drag
                    ? dayLaneSpans.find(
                        (span) =>
                          span.kind === "event" &&
                          span.event.id === drag.event.id,
                      )
                    : undefined;
                const renderedSpans =
                  inPreview && dragged
                    ? dayLaneSpans.filter((span) => span !== dragged)
                    : dayLaneSpans;
                const lastActiveLane = Math.max(
                  -1,
                  ...dayLaneSpans.map((span) => span.lane),
                );
                const visibleSlots = muted
                  ? []
                  : dragged
                    ? (inPreview
                        ? renderedSpans
                        : [
                            dragged,
                            ...renderedSpans.filter((span) => span !== dragged),
                          ]
                      ).slice(0, visibleLaneCount)
                    : Array.from(
                        {
                          length: Math.min(
                            visibleLaneCount,
                            lastActiveLane + 1,
                          ),
                        },
                        (_, lane) =>
                          renderedSpans.find((span) => span.lane === lane) ??
                          null,
                      );
                const itemCount = dayLaneSpans.length;
                const overflow = muted
                  ? 0
                  : dayLaneSpans.filter((span) => span.lane >= visibleLaneCount)
                      .length;
                const dropTarget = Boolean(drag && drag.dayKey === dateKey);
                const previewBefore = Boolean(
                  previewRange && dateKey > previewRange.from && dayIndex > 0,
                );
                const previewAfter = Boolean(
                  previewRange && dateKey < previewRange.to && dayIndex < 6,
                );
                const draftBefore = Boolean(
                  draftRange && dateKey > draftRange.from && dayIndex > 0,
                );
                const draftAfter = Boolean(
                  draftRange && dateKey < draftRange.to && dayIndex < 6,
                );

                return (
                  <div
                    className={cn(
                      "relative min-w-0 overflow-hidden border-r border-b border-border-subtle px-1.5 pt-1.5 pb-1 transition-colors duration-fast last:border-r-0 hover:bg-raised/35 focus-inset group-data-compact/month:px-1 motion-reduce:transition-none",
                      !inMonth && "bg-raised text-foreground-secondary hover:bg-sunken",
                      isToday && "bg-shu/4",
                      dropTarget && "bg-shu/7",
                      // A cell clips its contents, which cuts the bleed a draft
                      // uses to reach across the divider; through its
                      // translucent fill the rule would show, so the cell
                      // holding one drops the clip.
                      inDraft && "overflow-visible",
                    )}
                    key={dateKey}
                    ref={(node) => {
                      cellRefs.current[index] = node;
                    }}
                    data-drop-target={dropTarget ? "" : undefined}
                    data-today={isToday ? "" : undefined}
                    onPointerDown={(pointerEvent) => {
                      if (
                        muted ||
                        !onCreateAtDate ||
                        pointerEvent.button !== 0 ||
                        dismissGuard.pressDismissedLayer() ||
                        (pointerEvent.target instanceof Element &&
                          pointerEvent.target.closest("button,[role=dialog],[role=menu],[data-radix-popper-content-wrapper]"))
                      ) {
                        return;
                      }
                      // A new gesture replaces the old draft from its first
                      // press, not on release: leaving the previous popover open
                      // over a range being dragged reads as two pending events.
                      onCancelDraft?.();
                      beginRangeCreate({
                        cell: pointerEvent.currentTarget,
                        dayKey: dateKey,
                        pointerId: pointerEvent.pointerId,
                        pointerType: pointerEvent.pointerType,
                        time: pointerEvent.timeStamp,
                        x: pointerEvent.clientX,
                        y: pointerEvent.clientY,
                      });
                    }}
                    role="gridcell"
                    aria-label={
                      muted
                        ? getLongDateLabel(day)
                        : `${getLongDateLabel(day)}, ${itemCount} ${
                            itemCount === 1 ? "calendar item" : "calendar items"
                          }`
                    }
                    tabIndex={focusedIndex === index ? 0 : -1}
                    data-day-key={dateKey}
                    onClick={(event) => {
                      // Portaled inspector content belongs to its own surface.
                      if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"]')) return;
                      // A drag already opened quick create for its range.
                      if (
                        muted ||
                        consumeClick() ||
                        dismissGuard.consumeDismiss()
                      )
                        return;
                      onCreateAtDate?.(dateKey, event.currentTarget);
                    }}
                    onFocus={() => setFocusedIndex(index)}
                    onKeyDown={(event) => handleGridKeyDown(event, index)}
                  >
                    <div className="flex min-h-6 items-center justify-between gap-1">
                      {muted ? null : (
                        <span
                          className={cn(
                            "grid size-6 place-content-center rounded-full text-12 tabular-nums",
                            inMonth
                              ? weekend
                                ? "text-muted-foreground"
                                : "text-foreground-secondary"
                              : "text-foreground",
                            isToday && "bg-shu text-shu-foreground",
                          )}
                        >
                          {day.getDate()}
                        </span>
                      )}
                      {/* The accent is already on the day number beside it; the
                          word carries itself in ink. */}
                      {isToday ? (
                        <span className="text-10 tracking-label text-foreground-secondary uppercase max-sm:hidden">
                          Today
                        </span>
                      ) : null}
                    </div>
                    <div className="grid gap-0.5 pt-0.5" data-day-events="">
                      {/* The draft, as one pill across the range it covers: a
                        month cell has no time axis, so this reads like the
                        all-day event it will become. Grabbing it moves the whole
                        range. It stays aria-hidden — the popover's own date
                        fields are the keyboard path to the same change. */}
                      {inDraft && draftRange ? (
                        <div
                          aria-hidden="true"
                          className={cn(
                            "relative z-4 flex min-h-(--month-chip-height) w-full items-center overflow-hidden rounded-sm border border-(--draft-accent) bg-(--draft-fill) px-1.5 text-11 whitespace-nowrap text-foreground",
                            draftBefore && "-ml-(--event-bleed) w-(--bleed-one) rounded-l-none border-l-0",
                            draftAfter && "w-(--bleed-one) rounded-r-none border-r-0",
                            draftBefore && draftAfter && "w-(--bleed-both)",
                            // A grabbable surface must not also be selectable
                            // text: dragging a selection makes Chromium cancel
                            // the pointer gesture mid-move.
                            !draftRange.live && onMoveDraft && "cursor-grab touch-none select-none",
                            draftDrag && "cursor-grabbing",
                            // Still being dragged out: the cell underneath owns
                            // the gesture.
                            draftRange.live && "pointer-events-none",
                          )}
                          data-continues-after={draftAfter ? "" : undefined}
                          data-continues-before={draftBefore ? "" : undefined}
                          data-draft={
                            !draftRange.live && onMoveDraft ? "" : undefined
                          }
                          data-dragging={draftDrag ? "" : undefined}
                          data-live={draftRange.live ? "" : undefined}
                          style={
                            {
                              "--draft-accent":
                                pendingCreate?.color ?? "var(--accent-primary)",
                            } as CSSProperties
                          }
                          onPointerDown={
                            draftRange.live
                              ? undefined
                              : (pointerEvent) => {
                                  if (
                                    !onMoveDraft ||
                                    pointerEvent.button !== 0
                                  ) {
                                    return;
                                  }
                                  pointerEvent.stopPropagation();
                                  beginDraftDrag({
                                    event: undefined,
                                    originDayKey: dateKey,
                                    pointerId: pointerEvent.pointerId,
                                    x: pointerEvent.clientX,
                                    y: pointerEvent.clientY,
                                  });
                                }
                          }
                        >
                          {dateKey === draftRange.from || dayIndex === 0
                            ? "New event"
                            : ""}
                        </div>
                      ) : draftRow && !muted ? (
                        <div aria-hidden="true" className="min-h-(--month-chip-height)" />
                      ) : null}
                      {/* The dragged event across the days it would land on, drawn
                        the way the draft draws a range — one block per cell,
                        broken only at the week edge — but in the event's own
                        colour and shape, because this is a move and not a new
                        event. It sits on the line the whole row reserved, over
                        the ghost it is passing rather than pushing it down. */}
                      {inPreview && !muted && drag && previewRange ? (
                        <div
                          aria-hidden="true"
                          className={cn(
                            "pointer-events-none relative z-3 flex min-h-(--month-chip-height) w-full min-w-0 items-center gap-1 overflow-hidden rounded-sm bg-pigment px-1.5 text-left text-pigment-ink shadow-overlay group-data-compact/month:px-1",
                            drag.event.isAllDay && "font-medium",
                            previewBefore && "-ml-(--event-bleed) w-(--bleed-one) rounded-l-none",
                            previewAfter && "w-(--bleed-one) rounded-r-none",
                            previewBefore && previewAfter && "w-(--bleed-both)",
                          )}
                          data-drag-preview=""
                          style={
                            {
                              "--pigment": dragPreviewColor,
                              "--pigment-ink":
                                getReadableEventTextColor(dragPreviewColor),
                            } as CSSProperties
                          }
                        >
                          {!drag.event.isAllDay ? (
                            <span className="flex-none font-mono text-10 group-data-compact/month:hidden" data-event-time="">
                              {
                                getEventRangeLabel(
                                  drag.event,
                                  timeFormat,
                                ).split(" ")[0]
                              }
                            </span>
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-11" data-event-title="">
                            {previewBefore ? "" : drag.event.title}
                          </span>
                        </div>
                      ) : dragged || muted ? null : previewRow ? (
                        <div aria-hidden="true" className="min-h-(--month-chip-height)" />
                      ) : null}
                      {visibleSlots.map((span, lane) => {
                        if (!span) {
                          return (
                            <div
                              aria-hidden="true"
                              className="min-h-(--month-chip-height)"
                              key={`lane:${lane}`}
                            />
                          );
                        }
                        const labelColumn = Array.from(
                          { length: span.endCol - span.startCol + 1 },
                          (_, offset) => span.startCol + offset,
                        ).find((column) => {
                          const labelDay = week[column];
                          return Boolean(
                            labelDay &&
                              (showAdjacentDays ||
                                !dimOutsideMonth ||
                                labelDay.getMonth() === anchor.getMonth()),
                          );
                        });
                        const event = span.event;
                        return (
                          <EventPopover
                            calendar={calendarsById.get(
                              eventHomeCalendarId(event) ?? "",
                            )}
                            calendars={calendars}
                            continuesAfter={
                              event.isAllDay && dayIndex < span.endCol
                            }
                            continuesBefore={
                              event.isAllDay && dayIndex > span.startCol
                            }
                            ghost={drag?.event.id === event.id}
                            event={event}
                            pending={
                              busyEventId !== undefined &&
                              (event.id === busyEventId ||
                                event.id.startsWith(`${busyEventId}_`))
                            }
                            key={span.id}
                            onBeginDrag={
                              onMoveEventToDate &&
                              canEditEvent(
                                eventActions.getEventMaster(event),
                                calendars,
                              )
                                ? (pointerEvent) => {
                                    if (pointerEvent.button !== 0) return;
                                    beginMonthDrag({
                                      event,
                                      originDayKey: dateKey,
                                      pointerId: pointerEvent.pointerId,
                                      x: pointerEvent.clientX,
                                      y: pointerEvent.clientY,
                                    });
                                  }
                                : undefined
                            }
                            showLabel={
                              dayIndex === (labelColumn ?? span.startCol)
                            }
                            timeFormat={timeFormat}
                            weekStartsOn={weekStartsOn}
                            {...eventActions}
                          />
                        );
                      })}
                      {overflow > 0 ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              className="min-h-5 w-fit cursor-pointer rounded-sm bg-transparent px-1 text-11 text-muted-foreground hover:text-foreground"
                              type="button"
                              onClick={(event) => event.stopPropagation()}
                            >
                              +{overflow} more
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="center"
                            aria-label={`${getLongDateLabel(day)} events`}
                            role="dialog"
                            side="bottom"
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <div className="flex max-h-(--radix-popover-content-available-height) flex-col">
                              <div className="flex flex-none items-baseline justify-between gap-3 border-b border-border-subtle p-4">
                                <h2 className="m-0 font-serif text-19 font-normal">
                                  {day.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                                </h2>
                                <p className="m-0 text-11 whitespace-nowrap text-foreground-secondary">
                                  {itemCount}{" "}
                                  {itemCount === 1 ? "item" : "items"}
                                </p>
                              </div>
                              <div className="grid min-h-0 gap-1 overflow-y-auto p-2">
                                {dayLaneSpans.map((span) => (
                                  <EventPopover
                                    calendar={calendarsById.get(
                                      eventHomeCalendarId(span.event) ?? "",
                                    )}
                                    calendars={calendars}
                                    event={span.event}
                                    key={span.id}
                                    pending={
                                      busyEventId !== undefined &&
                                      (span.event.id === busyEventId ||
                                        span.event.id.startsWith(
                                          `${busyEventId}_`,
                                        ))
                                    }
                                    showLabel
                                    timeFormat={timeFormat}
                                    weekStartsOn={weekStartsOn}
                                    {...eventActions}
                                  />
                                ))}
                              </div>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
