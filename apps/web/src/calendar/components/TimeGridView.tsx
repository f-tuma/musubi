import { isCalendarTask } from "@musubi/calendar";
import { buildDayAxis, singleDayAxis, sharedWeekAxis, coordinateToInstant, coordinateBoundaryInstant, instantToCoordinate, intervalAxisSegments, civilCandidates, utcOffsetLabel, type TimeAxis } from "../day-axis";
import { availabilityDaySegments, type GridAvailabilityInterval } from "../availability-grid";
import { DEFAULT_CALENDAR_COLOR, type Calendar, type Event, type Settings } from "@musubi/types";
import {
	addDays,
	assignOverlapColumns,
	dayKey,
	type getDaySegments,
	isSameDay,
	startOfDay,
} from "@musubi/calendar/layout";
import {
	type CSSProperties,
	type KeyboardEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { calendarLaneSpans, visibleLaneLimit } from "../all-day-lanes";
import { getEventDateLabel, getEventRangeLabel } from "../calendar-math";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useNarrowViewport } from "~/design/use-narrow-viewport";
import { cn } from "~/lib/utils";
import { useLayerDismissGuard } from "../layer-focus";
import { getReadableEventTextColor } from "../event-color";
import {
	durationToHeight,
	minutesToY,
	yToMinutes,
	type TimeGeometry,
} from "../time-geometry";
import { canEditEvent, eventHomeCalendarId } from "../event-permissions";
import { EventMarks } from "./EventMarks";
import {
	nextAxisDragTimes,
	type DragMode,
	type DragTimes,
} from "../time-grid-drag";
import {
	useDragToCreate,
	useTimeGridDrag,
	type BeginDragInput,
} from "../use-time-grid-drag";
import {
	getTimeGridDays,
	axisOpenScroll,
	holeSegments,
	overlapPlacement,
	type TimeGridViewId,
} from "../time-grid-math";
import {
	EventDetailsPopover,
	type EventActionHandlers,
} from "./EventDetailsPopover";
import { EventPopover } from "./EventPopover";

const ALL_DAY_LANES = 3;
/** One all-day lane: a 20 px bar (`h-5`) and its gap. */
const ALL_DAY_LANE_PX = 24;
/**
 * The hour axis beside the day columns. The CSS grid and the pointer maths
 * read the same number, so a press lands in the column it is drawn over.
 */
const GUTTER_PX = 64;
const NARROW_GUTTER_PX = 52;
/** Narrowest a week grid gets before it scrolls sideways (above 599 px). */
const TIME_GRID_MIN_WIDTH_PX = 760;
const longWeekdayFormatter = new Intl.DateTimeFormat("en", {
	weekday: "long",
});
const shortWeekdayFormatter = new Intl.DateTimeFormat("en", {
	weekday: "short",
});
const hour12Formatter = new Intl.DateTimeFormat("en", {
	hour: "numeric",
	hour12: true,
});
const timeZoneFormatter = new Intl.DateTimeFormat("en", {
	timeZoneName: "shortOffset",
});

type TimeGridViewProps = EventActionHandlers & {
  availabilityIntervals?: GridAvailabilityInterval[];
	anchor: Date;
	/** The event a write is in flight for, so its block can say so. */
	busyEventId?: string;
	calendars: Calendar[];
	events: Event[];
	geometry: TimeGeometry;
	/**
	 * Commit a drag or resize. Absent (or returning without moving) leaves the
	 * grid read-only for direct manipulation.
	 */
	onMoveEvent?: (input: {
		dayOffset: number;
		end: Date;
		event: Event;
		start: Date;
	}) => Promise<unknown>;
	/**
	 * The slot a quick-create popover is currently open for. The selection stays
	 * visible for as long as the popover is, so the interval being described never
	 * disappears out from under it.
	 */
	/** Drops the draft the open quick create describes, before a new one starts. */
	onCancelDraft?: () => void;
	pendingCreate?: {
		exactRange?: { start: Date; end: Date };
		color?: string;
		date: string;
		endTime?: string;
		startTime?: string;
	};
	/**
	 * Move or resize the draft a drag-to-create laid down, while its popover is
	 * open. Absent leaves the draft as a still highlight.
	 */
	onMoveDraft?: (input: {
		exactRange?: { start: Date; end: Date };
		date: string;
		endTime: string;
		startTime: string;
	}) => void;
	/** Page presentation: a five-column working week when false. */
	showWeekend?: boolean;
	onCreateAtTime?: (
		date: string,
		time: string,
		anchor: { returnFocus: HTMLElement; x: number; y: number },
		/** Present when the interval was dragged rather than clicked. */
		endTime?: string,
		exactRange?: { start: Date; end: Date },
	) => void;
	timeFormat: Settings["timeFormat"];
	view: TimeGridViewId;
	weekStartsOn: Settings["weekStartsOn"];
};

type TimelineEventProps = EventActionHandlers & {
	calendar: Calendar | undefined;
	calendars: Calendar[];
	dayIndex: number;
	daySegment: ReturnType<typeof getDaySegments<Event>>[number];
	detailBoundary: HTMLElement | null;
	detailInsideTrigger: boolean;
	/** Live times while this event is being dragged, else undefined. */
	dragTimes?: DragTimes;
	/**
	 * This event is being moved somewhere else: what stays here is the shape it
	 * would leave behind, so the origin is still legible while it travels.
	 */
	ghost?: boolean;
	/** A write for this event is in flight. */
	pending?: boolean;
	draggable: boolean;
	geometry: TimeGeometry;
	axis: TimeAxis;
	onBeginDrag: (input: BeginDragInput) => void;
	onKeyboardAdjust: (event: Event, times: DragTimes) => void;
	timeFormat: Settings["timeFormat"];
	weekStartsOn: Settings["weekStartsOn"];
};

function hourLabel(hour: number, timeFormat: Settings["timeFormat"]) {
	if (timeFormat === "24h") {
		return `${String(hour).padStart(2, "0")}:00`;
	}

	return hour12Formatter.format(new Date(2026, 0, 1, hour));
}

/** `HH:MM` back to a minute of the day. */
function clockMinutes(value: string): number {
	const [hour, minute] = value.split(":");
	return Number(hour ?? 0) * 60 + Number(minute ?? 0);
}

function clockAt(axis: TimeAxis, column: number, coordinate: number, edge: "start" | "end" = "start") {
  const instant = coordinateBoundaryInstant(axis, column, coordinate, edge);
  if (instant === null) return "";
  return civilClock(new Date(instant));
}
function civilClock(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function realRunHeight(axis: TimeAxis, column: number, start: number, geometry: TimeGeometry) {
  let end = Math.floor(start);
  while (end < axis.rows.length && axis.columns[column]?.[end]) end++;
  return Math.max(0, end - start) * geometry.pxPerMinute;
}
function previewPieces(axis: TimeAxis, column: number, times: DragTimes) {
  const start = times.exactRange?.start.getTime() ?? coordinateToInstant(axis, column, times.startMinutes);
  const end = times.exactRange?.end.getTime() ?? coordinateBoundaryInstant(axis, column, times.endMinutes, "end");
  return start === null || end === null ? [] : intervalAxisSegments(axis, column, start, end);
}
function axisTimeLabel(axis: TimeAxis, column: number, coordinate: number, format: Settings["timeFormat"], edge: "start" | "end" = "start") {
  const instant = coordinateBoundaryInstant(axis, column, coordinate, edge);
  if (instant === null) return "";
  const date = new Date(instant);
  const value = axis.columns[column]?.[Math.min(axis.rows.length - 1, Math.floor(coordinate))];
  const label = minuteLabel(date.getHours() * 60 + date.getMinutes(), format);
  return value && civilCandidates(axis.days[column]!, value.minute).length > 1 ? `${label} ${utcOffsetLabel(value.offsetMinutes)} ${value.fold ? "second" : "first"}` : label;
}
function tickLabel(axis: TimeAxis, coordinate: number, timeFormat: Settings["timeFormat"]) {
  const row = axis.rows[coordinate]!;
  const repeated = axis.rows.some(other => other.minute === row.minute && other.fold !== row.fold);
  const time = row.minute % 60 === 0 ? hourLabel(row.minute / 60, timeFormat) : minuteLabel(row.minute, timeFormat);
  if (!repeated) return time;
  const value = axis.columns.map(column => column[coordinate]).find(Boolean)!;
  return `${time} ${utcOffsetLabel(value.offsetMinutes)} ${row.fold === 0 ? "first" : "second"}`;
}

/** A minute of the day as a clock time, for live drag feedback. */
function minuteLabel(
	minutes: number,
	timeFormat: Settings["timeFormat"],
): string {
	const hour = Math.floor(minutes / 60) % 24;
	const minute = Math.floor(minutes % 60);

	if (timeFormat === "12h") {
		return new Intl.DateTimeFormat("en", {
			hour: "numeric",
			hour12: true,
			minute: "2-digit",
		}).format(new Date(2026, 0, 1, hour, minute));
	}
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeZoneLabel(date: Date) {
	return (
		timeZoneFormatter
			.formatToParts(date)
			.find((part) => part.type === "timeZoneName")?.value ?? "Local"
	);
}

const TimelineEvent = memo(function TimelineEvent({
	axis,
	calendar,
	calendars,
	dayIndex,
	daySegment,
	detailBoundary,
	detailInsideTrigger,
	dragTimes,
	draggable,
	geometry,
	ghost = false,
	onBeginDrag,
	pending = false,
	onKeyboardAdjust,
	timeFormat,
	weekStartsOn,
	...eventActions
}: TimelineEventProps) {
	const { col, cols, event } = daySegment;
	const editable = canEditEvent(eventActions.getEventMaster(event), calendars);
	// While dragging, the block follows the ghost times rather than the data.
	const startMin = dragTimes?.startMinutes ?? daySegment.startMin;
  const endMin = dragTimes?.endMinutes ?? daySegment.endMin;
	const eventColor = calendar?.color ?? event.color;
	const renderStart = (dragTimes?.exactRange?.start ?? event.start).getTime();
  const renderEnd = (dragTimes?.exactRange?.end ?? event.end).getTime();
  const pieces = intervalAxisSegments(axis, dayIndex, renderStart, Math.max(renderEnd, renderStart + 60_000));
  function pieceHeight(piece: { start: number; end: number }) {
    return Math.min(realRunHeight(axis, dayIndex, piece.start, geometry), Math.max(pieces.length > 1 ? (piece.end - piece.start) * geometry.pxPerMinute - 2 : durationToHeight(piece.end - piece.start, geometry) - 2, pieces.length > 1 ? 1 : geometry.minEventHeight));
  }
  const lastPiece = pieces.at(-1);
  const actionHeight = lastPiece ? (lastPiece.start - pieces[0]!.start) * geometry.pxPerMinute + pieceHeight(lastPiece) : 0;


	/**
	 * Keyboard equivalent of dragging (docs/ui/calendar-ui.md R10): Alt+Up/Down
	 * moves by one snap interval, adding Shift changes the length instead. Without
	 * this, direct manipulation would be mouse-only.
	 */
	function handleKeyDown(keyEvent: ReactKeyboardEvent<HTMLElement>) {
		if (!draggable || !keyEvent.altKey) return;
		if (keyEvent.key !== "ArrowUp" && keyEvent.key !== "ArrowDown") return;

		keyEvent.preventDefault();
		keyEvent.stopPropagation();
		if (keyEvent.shiftKey && event.end.getTime() > axis.days[dayIndex]!.end) { eventActions.onNotice("Resize this event from its final day."); return; }
		const step = (keyEvent.key === "ArrowDown" ? 1 : -1) * geometry.snapMinutes;
		const times = nextAxisDragTimes({
			axis, originDayIndex: dayIndex, dayIndex, exactRange: { start: event.start, end: event.end },
			deltaMinutes: step,
			geometry,
			mode: keyEvent.shiftKey ? "resize-end" : "move",
			originEndMinutes: daySegment.endMin,
			originStartMinutes: daySegment.startMin,
		});

		if (!times) { eventActions.onNotice("No local time at that position. The event was not changed."); return; }
		if (
			times.startMinutes === daySegment.startMin &&
			times.endMinutes === daySegment.endMin
		) {
			return;
		}
		onKeyboardAdjust(event, times);
	}

	function startDrag(
		pointerEvent: ReactPointerEvent<HTMLElement>,
		mode: DragMode,
	) {
		// Only the primary button, and only where a move is actually allowed.
		if (!draggable || pointerEvent.button !== 0) return;
		onBeginDrag({
			dayIndex,
			exactRange: { start: event.start, end: event.end },
			endMinutes: daySegment.endMin,
			event,
			mode,
			pointerId: pointerEvent.pointerId,
			startMinutes: daySegment.startMin,
			x: pointerEvent.clientX,
			y: pointerEvent.clientY,
		});
	}
	// One placement rule for Day and Week: a column is a column, and the reason a
	// block is narrow is that something overlaps it, not which view you are in.
	//
	// While it is being dragged it takes the whole column, the way Google's does:
	// the block you are holding is the one you need to read, and its lane is about
	// to change anyway. Dropping it puts it back in whatever lane it lands in.
	const { left, width } = dragTimes
		? overlapPlacement(0, 1)
		: overlapPlacement(col, cols);

	return (
		<EventDetailsPopover
			anchorInsideTrigger={detailInsideTrigger}
			calendar={calendar}
			calendars={calendars}
			collisionBoundary={detailBoundary}
			event={event}
			timeFormat={timeFormat}
			weekStartsOn={weekStartsOn}
			{...eventActions}
		>
			{/* One action owns every linked piece around reserved civil rows; it
			    is transparent to the pointer so only the pieces take it. */}
			<button
				className="group/action pointer-events-none absolute top-(--event-top) left-(--event-left) h-(--event-height) w-(--event-width) border-0 bg-transparent p-0"
				style={
					{
						"--event-top": `${minutesToY(pieces[0]?.start ?? startMin, geometry)}px`,
						"--event-left": left,
						"--event-width": width,
						"--event-height": `${actionHeight}px`,
					} as CSSProperties
				}
				type="button"
				aria-label={`${isCalendarTask(event) ? "Task, " : ""}${event.title}, ${getEventDateLabel(
					event,
				 )}, ${getEventRangeLabel(event, timeFormat)}, ${axisTimeLabel(axis, dayIndex, daySegment.startMin, timeFormat)}, ${calendar?.name ?? "calendar"}`}
				aria-busy={pending || undefined}
				data-dragging={dragTimes ? "" : undefined}
				data-ghost={ghost ? "" : undefined}
				data-draggable={draggable ? "" : undefined}
				data-pending={pending ? "" : undefined}
				data-overlapping={col > 0 ? "" : undefined}
				data-readonly={editable ? undefined : ""}
				data-time-event={event.id}
				onKeyDown={handleKeyDown}
				onPointerDown={(pointerEvent) => startDrag(pointerEvent, "move")}
			>
			{pieces.map((piece, pieceIndex) => (
			<span
				className={cn(
					// The block is its own size container: its height is set from
					// geometry, so what fits inside is answered by the box
					// (`block-*` variants) rather than by a duration threshold.
					"group/block pointer-events-auto absolute top-(--piece-top) left-0 z-(--lane-z) grid h-(--piece-height) w-full min-w-0 content-start gap-0.5 overflow-hidden rounded-sm bg-pigment px-1.5 py-1 text-left text-pigment-ink transition-transform duration-fast @container-size/event-block hover:-translate-y-px group-aria-expanded/action:hover:translate-y-0 max-sm:px-1 motion-reduce:transition-none",
					realRunHeight(axis, dayIndex, piece.start, geometry) < 12 && "p-0 max-sm:px-0",
					// A block laid over another needs an edge against it: the ring
					// is the canvas, so it reads as space.
					col > 0 && "ring-2 ring-canvas",
					draggable && "cursor-grab",
					pieces.length > 1 && "border-l border-dashed border-l-current",
					pending && "animate-pulse cursor-progress motion-reduce:animate-none motion-reduce:opacity-70",
					// Held: lifted and slightly translucent, so the grid underneath
					// stays readable and it is obvious the block is in hand.
					dragTimes && "z-40 cursor-grabbing opacity-90 shadow-overlay motion-reduce:opacity-100",
					// What a moved event leaves behind: its outline with ink in it,
					// not a faded copy whose text would lose contrast.
					ghost && "pointer-events-none border border-dashed border-pigment/60 bg-pigment/18",
				)}
				data-linked-segment={pieces.length > 1 ? "" : undefined}
				data-draggable={draggable ? "" : undefined}
				data-pending={pending ? "" : undefined}
				data-overlapping={col > 0 ? "" : undefined}
				key={piece.start}
				style={
					{
						"--pigment": eventColor,
						"--pigment-ink": ghost
							? "var(--text-secondary)"
							: getReadableEventTextColor(eventColor),
						// A single piece fills the action box, so the container
						// follows its actual rendered height.
						"--piece-height": pieces.length === 1 ? "100%" : `${pieceHeight(piece)}px`,
						"--piece-top": `${(piece.start - (pieces[0]?.start ?? startMin)) * geometry.pxPerMinute}px`,
						"--lane-z": col + 1,
					} as CSSProperties
				}
			>
				<span className="hidden truncate font-mono text-10 block-time:block" data-event-time="">
					{/* While dragging, show the time the drop would produce — the
              answer the user is actually looking for. */}
					{dragTimes
						? `${axisTimeLabel(axis, dayIndex, startMin, timeFormat)}–${axisTimeLabel(axis, dayIndex, endMin, timeFormat, "end")}`
						: getEventRangeLabel(event, timeFormat).replace(" – ", "–")}
				</span>
				<span className="truncate text-11 leading-tight block-wrap:line-clamp-2 block-wrap:whitespace-normal" data-event-title="">
          {isCalendarTask(event) ? <EventMarks event={event} /> : null}
					{isCalendarTask(event) && event.calendarTask.status === "completed" ? <s>{event.title}</s> : event.title}
          {!isCalendarTask(event) ? <EventMarks event={event} readOnly={!editable} /> : null}
				</span>
				{event.location ? (
					<span className="hidden truncate text-10 opacity-80 block-meta:block">{event.location}</span>
				) : null}
				{draggable ? (
					<>
						{/* Resize has its own handles and its own state, so a move can
                never be mistaken for a length change. Hinted on hover only. */}
						<span
							aria-hidden="true"
							className="absolute top-0 left-0 h-2 w-full cursor-ns-resize group-hover/block:bg-pigment-ink/28"
							data-resize-handle="start"
							hidden={pieceIndex !== 0 || (dragTimes?.exactRange?.start ?? event.start).getTime() < axis.days[dayIndex]!.start}
							onPointerDown={(pointerEvent) => {
								pointerEvent.stopPropagation();
								startDrag(pointerEvent, "resize-start");
							}}
						/>
						<span
							aria-hidden="true"
							className="absolute bottom-0 left-0 h-2 w-full cursor-ns-resize group-hover/block:bg-pigment-ink/28"
							data-resize-handle="end"
							hidden={pieceIndex !== pieces.length - 1 || (dragTimes?.exactRange?.end ?? event.end).getTime() > axis.days[dayIndex]!.end}
							onPointerDown={(pointerEvent) => {
								pointerEvent.stopPropagation();
								startDrag(pointerEvent, "resize-end");
							}}
						/>
					</>
				) : null}
			</span>
			))}
			</button>
		</EventDetailsPopover>
	);
});

export function TimeGridView({
  availabilityIntervals = [],
	anchor,
	calendars,
	events,
	geometry: baseGeometry,
	onCancelDraft,
	onCreateAtTime,
	onMoveEvent,
	busyEventId,
	onMoveDraft,
	pendingCreate,
	showWeekend = true,
	timeFormat,
	view,
	weekStartsOn,
	...eventActions
}: TimeGridViewProps) {
	const days = useMemo(
		() =>
			getTimeGridDays(anchor, view, weekStartsOn, {
				includeWeekend: showWeekend,
			}),
		[anchor, showWeekend, view, weekStartsOn],
	);
	const axis = useMemo(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const axes = days.map(day => buildDayAxis(dayKey(day), timezone));
    return view === "day" ? singleDayAxis(axes[0]!) : sharedWeekAxis(axes);
  }, [days, view]);
  const geometry = useMemo(() => ({ ...baseGeometry, visibleDayEndMinutes: axis.rows.length }), [baseGeometry, axis]);
  const ticks = useMemo(() => {
    const counts = new Map<number, number>();
    for (const row of axis.rows) counts.set(row.minute, (counts.get(row.minute) ?? 0) + 1);
    return axis.rows.flatMap((row, coordinate) => row.minute % 60 === 0 || coordinate === 0 || axis.rows[coordinate - 1]!.minute !== row.minute - 1 || ((counts.get(row.minute) ?? 0) > 1 && (counts.get(row.minute - 1) ?? 0) < 2) ? [{ row, coordinate }] : []);
  }, [axis]);
  const segmentsByDay = useMemo(() => days.map((day, column) => {
    const eventSegments = assignOverlapColumns(events.filter(event => !event.isAllDay).flatMap(event => {
      const pieces = intervalAxisSegments(axis, column, event.start.getTime(), Math.max(event.end.getTime(), event.start.getTime() + 60_000));
      return pieces.length ? [{ event, kind: "event" as const, startMin: pieces[0]!.start, endMin: pieces.at(-1)!.end, col: 0, cols: 1 }] : [];
    }));
    return [...eventSegments, ...assignOverlapColumns(availabilityDaySegments(availabilityIntervals, day, axis, column))];
  }), [days, axis, events, availabilityIntervals]);
	const calendarsById = useMemo(
		() => new Map(calendars.map((calendar) => [calendar.id, calendar])),
		[calendars],
	);
	const allDaySpans = useMemo(
		() => calendarLaneSpans(events, days),
		[days, events],
	);
	const allDayLaneTotal = Math.max(
		0,
		...allDaySpans.map((span) => span.lane + 1),
	);
	const visibleAllDayLaneCount = visibleLaneLimit(
		allDayLaneTotal,
		ALL_DAY_LANES,
	);
	const visibleAllDaySpans = allDaySpans.filter(
		(span) => span.lane < visibleAllDayLaneCount,
	);
	const hiddenAllDaySpans = allDaySpans.filter(
		(span) => span.lane >= visibleAllDayLaneCount,
	);
	const hiddenAllDayCount = hiddenAllDaySpans.length;
	const allDayLaneCount = Math.max(1, Math.min(allDayLaneTotal, ALL_DAY_LANES));
	const [now, setNow] = useState(() => new Date());
	const hasToday = days.some((day) => isSameDay(day, now));
	const dayMode = view === "day";
	const narrow = useNarrowViewport();
	const gutter = narrow ? NARROW_GUTTER_PX : GUTTER_PX;
	const [detailBoundary, setDetailBoundary] = useState<HTMLElement | null>(null);
	const dismissGuard = useLayerDismissGuard();
	const rootRef = useRef<HTMLElement>(null);
	const availabilityPress = useRef(false);
  const [keyboardSlot, setKeyboardSlot] = useState<{ dayIndex: number; coordinate: number } | null>(null);
	const setRoot = useCallback((element: HTMLElement | null) => {
		rootRef.current = element;
		setDetailBoundary(element?.parentElement ?? null);
	}, []);
	const canvasRef = useRef<HTMLDivElement>(null);
	// Last applied geometry, so a density change can rescale scroll instead of
	// resetting it.
	const geometryRef = useRef(geometry);

	const readColumns = useCallback(() => {
		const bounds = canvasRef.current?.getBoundingClientRect();
		// The time gutter is part of the canvas but is not a day column.
		const gutterWidth = bounds ? Math.min(gutter, bounds.width) : 0;
		const width = bounds ? (bounds.width - gutterWidth) / days.length : 0;
		return {
			count: days.length,
			left: (bounds?.left ?? 0) + gutterWidth,
			width,
		};
	}, [days.length, gutter]);

	const { begin: beginDrag, drag } = useTimeGridDrag({
		axis,
		columns: readColumns,
		geometry,
		onCommit: async ({ dayOffset, event, times }) => {
			if (!onMoveEvent) return;
			const day = addDays(startOfDay(event.start), dayOffset);
			await onMoveEvent({
				dayOffset,
				end: times.exactRange?.end ?? new Date(day.getTime() + times.endMinutes * 60_000),
				event,
				start: times.exactRange?.start ?? new Date(day.getTime() + times.startMinutes * 60_000),
			});
		},
		onError: eventActions.onNotice,
		scrollRoot: () => rootRef.current?.parentElement,
	});

	/**
	 * Apply a keyboard nudge. Announced through the notice live region, because a
	 * screen-reader user gets no visual confirmation from the block moving.
	 */
	async function adjustByKeyboard(event: Event, times: DragTimes) {
		if (!onMoveEvent) return;
		const day = startOfDay(event.start);
		try {
			await onMoveEvent({
				dayOffset: 0,
				end: times.exactRange?.end ?? new Date(day.getTime() + times.endMinutes * 60_000),
				event,
				start: times.exactRange?.start ?? new Date(day.getTime() + times.startMinutes * 60_000),
			});
			eventActions.onNotice(
				`${event.title} now ${axisTimeLabel(axis, days.findIndex(value => dayKey(value) === dayKey(day)), times.startMinutes, timeFormat)}–${axisTimeLabel(axis, days.findIndex(value => dayKey(value) === dayKey(day)), times.endMinutes, timeFormat, "end")}.`,
			);
		} catch (error) {
			eventActions.onNotice(
				error instanceof Error
					? error.message
					: "That change could not be saved. The original time was restored.",
				{ tone: "error" },
			);
		}
	}

	const {
		begin: beginCreateDrag,
		consumeClick,
		selection: liveSelection,
	} = useDragToCreate({
		axis,
		geometry,
		onSelected: (dragged, column) => {
			const day = days[dragged.dayIndex];
			if (!day || !onCreateAtTime) return;
			const bounds = column.getBoundingClientRect();
			onCreateAtTime(
				dayKey(day),
				clockAt(axis, dragged.dayIndex, dragged.startMinutes),
				{
					returnFocus: column,
					// The column's edge, so the popover lands beside the draft rather
					// than over it.
					x: bounds.right,
					y: bounds.top + minutesToY(dragged.startMinutes, geometry),
				},
				clockAt(axis, dragged.dayIndex, dragged.endMinutes, "end"),
				dragged.exactRange,
			);
		},
	});
	// Where the open quick-create popover's slot sits on the grid. This is the
	// draft: a laid-down block, not just a highlight.
	const draftSlot = useMemo(() => {
		if (!pendingCreate?.startTime) return undefined;

		const dayIndex = days.findIndex((day) => dayKey(day) === pendingCreate.date);
		if (dayIndex < 0) return undefined;

    const day = axis.days[dayIndex]!;
    const start = pendingCreate.exactRange?.start.getTime() ?? civilCandidates(day, clockMinutes(pendingCreate.startTime))[0]?.instant;
    if (start === undefined) return undefined;
    const end = pendingCreate.exactRange?.end.getTime() ?? (pendingCreate.endTime ? civilCandidates(day, clockMinutes(pendingCreate.endTime))[0]?.instant : start + 60 * 60_000);
    if (end === undefined || end <= start) return undefined;
    const pieces = intervalAxisSegments(axis, dayIndex, start, end);
    if (!pieces.length) return undefined;
    return { dayIndex, startMinutes: pieces[0]!.start, endMinutes: pieces.at(-1)!.end, exactRange: { start: new Date(start), end: new Date(end) } };
  }, [days, axis, pendingCreate]);

	// A second pointer machine, for the draft: same threshold, snapping,
	// auto-scroll and Escape as a real event, but it commits into the open form
	// instead of to the server.
	const { begin: beginDraftDrag, drag: draftDrag } = useTimeGridDrag<undefined>({
		axis,
		columns: readColumns,
		geometry,
		onCommit: async ({ dayOffset, mode, times }) => {
			if (!draftSlot || !onMoveDraft) return;
			const day =
				days[
					Math.max(
						0,
						Math.min(
							days.length - 1,
							draftSlot.dayIndex + (mode === "move" ? dayOffset : 0),
						),
					)
				];
			if (!day) return;
			onMoveDraft({
				date: dayKey(times.exactRange?.start ?? day),
				endTime: times.exactRange ? civilClock(times.exactRange.end) : clockAt(axis, days.indexOf(day), times.endMinutes, "end"),
				startTime: times.exactRange ? civilClock(times.exactRange.start) : clockAt(axis, days.indexOf(day), times.startMinutes),
				exactRange: times.exactRange,
			});
		},
		onError: eventActions.onNotice,
		scrollRoot: () => rootRef.current?.parentElement,
	});
	const dragPreviewColor = drag
		? (calendarsById.get(eventHomeCalendarId(drag.event) ?? "")?.color ??
			drag.event.color)
		: "transparent";

	// Three sources, in the order they win: the create gesture in progress, the
	// draft being dragged, and the draft at rest. A plain click also produces a
	// draft, so it too shows what "when" it picked.
	const selection = useMemo(() => {
		if (liveSelection) return liveSelection;
		if (draftDrag && draftSlot) {
			return {
				dayIndex:
					draftDrag.mode === "move" ? draftDrag.dayIndex : draftSlot.dayIndex,
				exactRange: draftDrag.times.exactRange,
				endMinutes: draftDrag.times.endMinutes,
				startMinutes: draftDrag.times.startMinutes,
			};
		}
		return draftSlot;
	}, [draftDrag, draftSlot, liveSelection]);

	/** Grab the draft to move it, or one of its edges to resize it. */
	function startDraftDrag(
		pointerEvent: ReactPointerEvent<HTMLElement>,
		mode: DragMode,
	) {
		if (!draftSlot || !onMoveDraft || pointerEvent.button !== 0) return;
		pointerEvent.stopPropagation();
		beginDraftDrag({
			dayIndex: draftSlot.dayIndex,
			exactRange: draftSlot.exactRange,
			endMinutes: draftSlot.endMinutes,
			event: undefined,
			mode,
			pointerId: pointerEvent.pointerId,
			startMinutes: draftSlot.startMinutes,
			x: pointerEvent.clientX,
			y: pointerEvent.clientY,
		});
	}


	// One effect owns where the grid is scrolled.
	//
	// Opening a range anchors near the working day rather than midnight. A density
	// change is different: it rewrites the pixel↔time mapping, so keeping the same
	// scrollTop would silently show a different hour. Then we rescale instead,
	// because the visible *time* is what the user is holding onto.
	useEffect(() => {
		const scrollRoot = rootRef.current?.parentElement;
		const previousHourHeight = geometryRef.current.hourHeight;
		geometryRef.current = geometry;

		if (!scrollRoot) return;

		scrollRoot.scrollTo?.({
			top:
				previousHourHeight === geometry.hourHeight
					? minutesToY(axisOpenScroll(axis, new Date(), hasToday), geometry) - 12
					: scrollRoot.scrollTop * (geometry.hourHeight / previousHourHeight),
		});
	}, [anchor, axis, geometry, hasToday, view, weekStartsOn]);

	useEffect(() => {
		if (!hasToday) {
			return;
		}

		const timer = window.setInterval(() => setNow(new Date()), 60_000);
		return () => window.clearInterval(timer);
	}, [hasToday]);

	function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (event.target !== event.currentTarget) {
			return;
		}

		const scrollRoot = rootRef.current?.parentElement;

		if (!scrollRoot) {
			return;
		}

		if (event.key === "ArrowDown" || event.key === "PageDown") {
			event.preventDefault();
			scrollRoot.scrollBy({
				behavior: "smooth",
				top:
					event.key === "PageDown" ? 4 * geometry.hourHeight : geometry.hourHeight,
			});
		} else if (event.key === "ArrowUp" || event.key === "PageUp") {
			event.preventDefault();
			scrollRoot.scrollBy({
				behavior: "smooth",
				top:
					event.key === "PageUp" ? -4 * geometry.hourHeight : -geometry.hourHeight,
			});
		} else if (event.key === "Home") {
			event.preventDefault();
			scrollRoot.scrollTo({ behavior: "smooth", top: 0 });
		} else if (event.key === "End") {
			event.preventDefault();
			scrollRoot.scrollTo({
				behavior: "smooth",
				top: scrollRoot.scrollHeight,
			});
		}
	}

	return (
		<section
			className={
				// A week has to look like a week: wider viewports keep a minimum
				// column and scroll sideways; a phone fits all of them.
				dayMode || narrow
					? "min-h-(--grid-min-height) min-w-full focus-inset"
					: "min-h-(--grid-min-height) min-w-(--time-grid-min-width) focus-inset"
			}
			aria-label={`${view === "day" ? "Day" : "Week"} time grid`}
			onKeyDown={handleKeyDown}
			ref={setRoot}
			style={
				{
					"--timeline-gutter": `${gutter}px`,
					"--tick-label-width": `${gutter - 12}px`,
					"--day-count": days.length,
					"--day-columns": `repeat(${days.length}, minmax(0, 1fr))`,
					"--time-grid-columns": `${gutter}px repeat(${days.length}, minmax(0, 1fr))`,
					"--time-grid-min-width": `${TIME_GRID_MIN_WIDTH_PX}px`,
					"--axis-height": `${axis.rows.length * geometry.pxPerMinute}px`,
					"--all-day-height": `${allDayLaneCount * ALL_DAY_LANE_PX + 8}px`,
					// The CSS grid derives its height from the same number as the event maths.
					"--hour-height": `${geometry.hourHeight}px`,
					"--grid-min-height": "calc(24 * var(--hour-height) + 92px)",
					"--column-inset-width": "calc(100% - 4px)",
					"--preview-width": "calc(100% - 6px)",
				} as CSSProperties
			}
			tabIndex={0}
		>
			{/* Above the events, so a draft or block scrolled up passes under the
			    date it belongs to rather than over it. */}
			<div className="sticky top-0 z-8 bg-canvas">
				<div className="grid min-h-12 grid-cols-(--time-grid-columns) border-b border-border-subtle">
					{/* The corner above the hour axis: this names the zone every hour on
              the axis is written in, so it belongs at the top of that axis. */}
					<span className="flex items-end justify-end pr-2.5 pb-1 pl-1 text-10 text-muted-foreground">
						{timeZoneLabel(now)}
					</span>
					{days.map((day) => {
						const today = isSameDay(day, now);

						return (
							<time
								className={
									today
										? "flex min-w-0 items-center justify-center gap-1.5 border-r border-border-subtle text-shu uppercase last:border-r-0 max-sm:flex-col max-sm:gap-0 max-sm:leading-tight"
										: "flex min-w-0 items-center justify-center gap-1.5 border-r border-border-subtle text-foreground-secondary uppercase last:border-r-0 max-sm:flex-col max-sm:gap-0 max-sm:leading-tight"
								}
								data-time-grid-day={dayKey(day)}
								data-today={today ? "" : undefined}
								dateTime={dayKey(day)}
								key={dayKey(day)}
							>
								<span className="truncate text-10 font-medium tracking-label">
									{(dayMode ? longWeekdayFormatter : shortWeekdayFormatter).format(day)}
								</span>
								<strong
									className={
										today
											? "grid h-6 min-w-6 place-content-center rounded-full bg-shu text-12 font-medium text-shu-foreground"
											: "grid h-6 min-w-6 place-content-center rounded-full text-12 font-medium text-foreground-secondary"
									}
								>
									{day.getDate()}
								</strong>
							</time>
						);
					})}
				</div>

				<div className="grid min-h-(--all-day-height) grid-cols-(--time-grid-columns) border-b border-border-subtle">
					<span className="flex items-start justify-end border-r border-border-subtle pt-2 pr-2.5 pl-1 text-10 text-foreground-secondary">
						All day
					</span>
					<div className="relative col-span-(--day-count) min-w-0">
						{visibleAllDaySpans.map((span) => {
							const calendar = calendarsById.get(
								eventHomeCalendarId(span.event) ?? "",
							);
							const eventColor = calendar?.color ?? span.event.color;
							return (
								<EventDetailsPopover
									anchorInsideTrigger={dayMode}
									calendar={calendar}
									calendars={calendars}
									collisionBoundary={detailBoundary}
									event={span.event}
									key={span.id}
									side={dayMode ? "right" : "bottom"}
									timeFormat={timeFormat}
									weekStartsOn={weekStartsOn}
									{...eventActions}
								>
									<button
										className="absolute top-(--event-top) left-(--event-left) block h-5 w-(--event-width) truncate rounded-sm bg-pigment px-1.5 text-left text-11 text-pigment-ink focus-inset"
										type="button"
										aria-label={`${isCalendarTask(span.event) ? "Task deadline" : "All-day event"}, ${span.event.title}, ${getEventDateLabel(
											span.event,
										)}, ${calendar?.name ?? "calendar"}`}
										data-all-day-event={span.event.id}
										style={
											{
												"--pigment": eventColor,
												"--pigment-ink": getReadableEventTextColor(eventColor),
												"--event-left": `${(span.startCol / days.length) * 100}%`,
												"--event-top": `${span.lane * ALL_DAY_LANE_PX + 4}px`,
												"--event-width": `calc(${
													((span.endCol - span.startCol + 1) / days.length) * 100
												}% - 2px)`,
											} as CSSProperties
										}
									>
										{isCalendarTask(span.event) && span.event.calendarTask.status === "completed" ? <s>{span.event.title}</s> : span.event.title}<EventMarks event={span.event} />
									</button>
								</EventDetailsPopover>
							);
						})}
						{hiddenAllDayCount > 0 ? (
							<Popover>
								<PopoverTrigger asChild>
									<button
										aria-label={`${hiddenAllDayCount} more all-day ${
											hiddenAllDayCount === 1 ? "item" : "items"
										}`}
										className="absolute top-(--event-top) right-1 rounded-sm bg-panel px-0.5 text-10 text-muted-foreground hover:text-foreground"
										style={
											{
												"--event-top": `${Math.max(0, allDayLaneCount - 1) * ALL_DAY_LANE_PX + 8}px`,
											} as CSSProperties
										}
										type="button"
									>
										+{hiddenAllDayCount}
									</button>
								</PopoverTrigger>
								<PopoverContent
									align="end"
									aria-label="Hidden all-day items"
									role="dialog"
									side="bottom"
								>
									<div className="grid max-h-(--radix-popover-content-available-height) gap-1 overflow-y-auto p-2" data-event-list="overflow">
										{hiddenAllDaySpans.map((span) => (
											<EventPopover
												calendar={calendarsById.get(eventHomeCalendarId(span.event) ?? "")}
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
					</div>
				</div>
			</div>

			<div className="relative h-(--axis-height)" data-time-grid-canvas="" ref={canvasRef}>
				{ticks.map(({ row, coordinate }) => (
					<div
						className="absolute top-(--tick-top) right-0 left-(--timeline-gutter) h-px border-t border-border-subtle"
						key={row.key}
						style={{ "--tick-top": `${minutesToY(coordinate, geometry)}px` } as CSSProperties}
					>
						{coordinate > 0 ? (
							<span className="absolute -top-2 right-full mr-2.5 w-(--tick-label-width) text-right font-mono text-10 leading-tight text-muted-foreground">
								{tickLabel(axis, coordinate, timeFormat)}
							</span>
						) : null}
					</div>
				))}
				<div className="absolute inset-y-0 right-0 left-(--timeline-gutter) grid grid-cols-(--day-columns)">
					{days.map((day, dayIndex) => {
						const today = isSameDay(day, now);
						const nowMinutes = instantToCoordinate(axis, dayIndex, now.getTime());
						const dropTarget = Boolean(
							drag && drag.mode === "move" && drag.dayIndex === dayIndex,
						);

						return (
							<div
								className={
									dropTarget
										? "group/column relative min-w-0 border-r border-border-subtle bg-shu/7 first:border-l last:border-r-0 focus-inset"
										: "group/column relative min-w-0 border-r border-border-subtle first:border-l last:border-r-0 focus-inset"
								}
								data-drop-target={dropTarget ? "" : undefined}
								data-time-grid-column={dayKey(day)}
								key={dayKey(day)}
								tabIndex={onCreateAtTime ? 0 : -1}
                role="group"
                aria-label={`${dayKey(day)} time slots${keyboardSlot?.dayIndex === dayIndex ? `, ${axisTimeLabel(axis, dayIndex, keyboardSlot.coordinate, timeFormat)}` : ""}`}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || !onCreateAtTime) return;
                  let coordinate = keyboardSlot?.dayIndex === dayIndex ? keyboardSlot.coordinate : axisOpenScroll(axis, new Date(), false);
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault(); event.stopPropagation();
                    const step = event.key === "ArrowDown" ? geometry.snapMinutes : -geometry.snapMinutes;
                    let next = coordinate + step;
                    while (next >= 0 && next < axis.rows.length && coordinateToInstant(axis, dayIndex, next) === null) next += step;
                    if (next < 0 || next >= axis.rows.length) return;
                    coordinate = next;
                    setKeyboardSlot({ dayIndex, coordinate });
                    const scrollRoot = rootRef.current?.parentElement;
                    if (scrollRoot) scrollRoot.scrollTo?.({ top: Math.max(0, minutesToY(coordinate, geometry) - scrollRoot.clientHeight / 2) });
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault(); event.stopPropagation();
                    const instant = coordinateToInstant(axis, dayIndex, coordinate);
                    if (instant === null) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    onCreateAtTime(dayKey(day), clockAt(axis, dayIndex, coordinate), { returnFocus: event.currentTarget, x: bounds.right, y: bounds.top + minutesToY(coordinate, geometry) }, undefined, { start: new Date(instant), end: new Date(Math.min(axis.days[dayIndex]!.end, instant + 60 * 60_000)) });
                  }
                }}
								onPointerDown={(pointerEvent) => {
									availabilityPress.current = pointerEvent.target instanceof Element && !!pointerEvent.target.closest("[data-availability-interval]");
									if (
										!onCreateAtTime ||
										pointerEvent.button !== 0 ||
										// This press is dismissing a preview or a menu; it must not
										// also leave a draft behind the thing it just closed.
										dismissGuard.pressDismissedLayer() ||
										(pointerEvent.target instanceof Element &&
											pointerEvent.target.closest("button,[data-availability-interval],[role=dialog],[role=menu],[data-radix-popper-content-wrapper]"))
									) {
										return;
									}
									if (coordinateToInstant(axis, dayIndex, yToMinutes(pointerEvent.clientY - pointerEvent.currentTarget.getBoundingClientRect().top, geometry)) === null) return;
									// Same as the month grid: the previous draft goes on press,
									// so two pending events are never on screen at once.
									onCancelDraft?.();
									beginCreateDrag({
										clientY: pointerEvent.clientY,
										column: pointerEvent.currentTarget,
										dayIndex,
										pointerId: pointerEvent.pointerId,
									});
								}}
								onClick={(event) => {
									// A release outside the static block can target this column.
									if (availabilityPress.current) { availabilityPress.current = false; return; }
									if (
										!onCreateAtTime ||
										// A drag already answered "when" — don't create twice.
										consumeClick() ||
										// The press this click belongs to closed a layer. Radix
										// dismisses on pointerdown, so nothing is open to ask about
										// by now — the press had to be remembered.
										dismissGuard.consumeDismiss() ||
										(event.target instanceof Element && event.target.closest('button,[data-availability-interval],[role="dialog"],[role="menu"]'))
									) {
										return;
									}

									const bounds = event.currentTarget.getBoundingClientRect();
									// Same geometry the grid is drawn with, so the created time is
									// the time the user pointed at (snapped and clamped there).
									const minutes = yToMinutes(event.clientY - bounds.top, geometry);
									const instant = coordinateToInstant(axis, dayIndex, minutes);
									if (instant === null) return;
									const exactRange = { start: new Date(instant), end: new Date(Math.min(axis.days[dayIndex]!.end, instant + 60 * 60_000)) };

									onCreateAtTime(
										dayKey(day),
										clockAt(axis, dayIndex, minutes),
										{
											returnFocus: event.currentTarget,
											// Beside the column, level with the slot that was clicked
											// — same rule as a dragged slot.
											x: event.currentTarget.getBoundingClientRect().right,
											y: event.clientY,
										},
										undefined, exactRange,
									);
								}}
							>
                {/* Drawn only while the column itself has keyboard focus. */}
                {keyboardSlot?.dayIndex === dayIndex ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-(--slot-top) hidden h-(--slot-height) border border-shu group-focus-visible/column:block"
                    style={{ "--slot-top": `${minutesToY(keyboardSlot.coordinate, geometry)}px`, "--slot-height": `${geometry.snapMinutes * geometry.pxPerMinute}px` } as CSSProperties}
                  />
                ) : null}
                {holeSegments(axis, dayIndex).map(hole => (
                  <div
                    key={hole.start}
                    className="pointer-events-none absolute inset-x-0 top-(--slot-top) flex h-(--slot-height) items-center justify-center border-y border-dashed border-border-subtle bg-panel text-10 text-muted-foreground"
                    data-time-axis-hole=""
                    style={{ "--slot-top": `${minutesToY(hole.start, geometry)}px`, "--slot-height": `${(hole.end - hole.start) * geometry.pxPerMinute}px` } as CSSProperties}
                  >
                    No local time
                  </div>
                ))}
								{/* The draft: visible from the first pixel of the create
                    gesture, and once laid down it can be moved and resized like
                    a real block. It stays aria-hidden — the popover's own date
                    and time fields are the keyboard path to the same change. */}
								{selection?.dayIndex === dayIndex ? previewPieces(axis, dayIndex, selection).map((piece, pieceIndex, pieces) => {
                  const run = realRunHeight(axis, dayIndex, piece.start, geometry);
                  const laidDown = Boolean(draftSlot && onMoveDraft);
                  return (
									<div
										aria-hidden="true"
										className={cn(
											// Translucent, over the events it is drawn among and under
											// the sticky header. During the create gesture it stays
											// transparent to the pointer; laid down it takes it back.
											"pointer-events-none absolute top-(--event-top) left-0.5 z-5 flex h-(--event-height) w-(--column-inset-width) flex-col items-stretch overflow-hidden rounded-sm border border-(--draft-accent) bg-(--draft-fill) px-1 py-0.5 @container-size/event-block",
											run < 12 && "p-0",
											run < 2 && "border-0",
											laidDown && "pointer-events-auto cursor-grab touch-none select-none",
											draftDrag && "cursor-grabbing",
										)}
                    key={piece.start}
										data-draft={laidDown ? "" : undefined}
										data-dragging={draftDrag ? "" : undefined}
										data-time-grid-selection=""
										style={
											{
												"--draft-accent": pendingCreate?.color ?? "var(--accent-primary)",
												"--event-height": `${Math.min(run, durationToHeight(piece.end - piece.start, geometry))}px`,
												"--event-top": `${minutesToY(piece.start, geometry)}px`,
											} as CSSProperties
										}
										onPointerDown={(pointerEvent) => startDraftDrag(pointerEvent, "move")}
									>
										{/* Time then name, left aligned — the same reading order
                        as a real block. */}
										<span className="font-mono text-10 text-foreground">
											{axisTimeLabel(axis, dayIndex, selection.startMinutes, timeFormat)}–
											{axisTimeLabel(axis, dayIndex, selection.endMinutes, timeFormat, "end")}
										</span>
										{/* Named once it is laid down, so it reads as the event it
                        is about to become rather than as a selection. */}
										{draftSlot && !liveSelection ? (
											<span className="hidden truncate text-11 text-foreground block-time:block">New event</span>
										) : null}
										{laidDown ? (
											<>
												{/* A draft is made to be adjusted, so its grips are
                            always drawn. */}
												<span
													hidden={pieceIndex !== 0 || (selection.exactRange !== undefined && selection.exactRange.start.getTime() < axis.days[dayIndex]!.start)}
													className="absolute top-0 left-0 h-2 w-full cursor-ns-resize after:absolute after:top-px after:left-1/2 after:h-0.5 after:w-6 after:-translate-x-1/2 after:rounded-full after:bg-(--draft-accent)"
													data-resize-handle="start"
													onPointerDown={(pointerEvent) =>
														startDraftDrag(pointerEvent, "resize-start")
													}
												/>
												<span
													hidden={pieceIndex !== pieces.length - 1 || (selection.exactRange !== undefined && selection.exactRange.end.getTime() > axis.days[dayIndex]!.end)}
													className="absolute bottom-0 left-0 h-2 w-full cursor-ns-resize after:absolute after:bottom-px after:left-1/2 after:h-0.5 after:w-6 after:-translate-x-1/2 after:rounded-full after:bg-(--draft-accent)"
													data-resize-handle="end"
													onPointerDown={(pointerEvent) =>
														startDraftDrag(pointerEvent, "resize-end")
													}
												/>
											</>
										) : null}
									</div>
                  );
                }) : null}
								{/* The event where it is being dragged to — the answer to
                    "where will this land", including across days. */}
								{drag && drag.mode === "move" && drag.dayIndex === dayIndex ? previewPieces(axis, dayIndex, drag.times).map(piece => {
                  const run = realRunHeight(axis, dayIndex, piece.start, geometry);
                  return (
									<div
										aria-hidden="true"
										className={
											run < 12
												? "pointer-events-none absolute top-(--event-top) left-0.5 z-41 flex h-(--event-height) w-(--preview-width) flex-col overflow-hidden rounded-sm bg-pigment p-0 text-pigment-ink shadow-overlay"
												: "pointer-events-none absolute top-(--event-top) left-0.5 z-41 flex h-(--event-height) w-(--preview-width) flex-col overflow-hidden rounded-sm bg-pigment px-1.5 py-1 text-pigment-ink shadow-overlay"
										}
                    key={piece.start}
										data-drag-preview=""
										style={
											{
												"--pigment": dragPreviewColor,
												"--pigment-ink": getReadableEventTextColor(dragPreviewColor),
												"--event-height": `${Math.min(run, durationToHeight(piece.end - piece.start, geometry))}px`,
												"--event-top": `${minutesToY(piece.start, geometry)}px`,
											} as CSSProperties
										}
									>
										<span className="font-mono text-10">
											{axisTimeLabel(axis, dayIndex, drag.times.startMinutes, timeFormat)}–
											{axisTimeLabel(axis, dayIndex, drag.times.endMinutes, timeFormat, "end")}
										</span>
										<span className="truncate text-11 leading-tight">{drag.event.title}</span>
									</div>
                  );
                }) : null}
								{segmentsByDay[dayIndex]?.map((segment) => {
                  if (segment.kind !== "availability") {
                    return (
									<TimelineEvent
										axis={axis}
										detailBoundary={detailBoundary}
										detailInsideTrigger={dayMode}
										pending={
											busyEventId !== undefined &&
											(segment.event.id === busyEventId ||
												segment.event.id.startsWith(`${busyEventId}_`))
										}
										calendar={calendarsById.get(eventHomeCalendarId(segment.event) ?? "")}
										calendars={calendars}
										dayIndex={dayIndex}
										daySegment={segment}
										dragTimes={
											// A resize grows the block in place. A move leaves this one
											// where it was, as a ghost, and travels as its own preview
											// in whichever column the pointer is over.
											drag?.event.id === segment.event.id && drag.mode !== "move"
												? drag.times
												: undefined
										}
										ghost={drag?.event.id === segment.event.id && drag.mode === "move"}
										draggable={
											Boolean(onMoveEvent) &&
											canEditEvent(eventActions.getEventMaster(segment.event), calendars)
										}
										geometry={geometry}
										key={segment.event.id}
										onBeginDrag={beginDrag}
										onKeyboardAdjust={adjustByKeyboard}
										timeFormat={timeFormat}
										weekStartsOn={weekStartsOn}
										{...eventActions}
									/>
                    );
                  }
                  const placement = overlapPlacement(segment.col, segment.cols);
                  const height = Math.min(realRunHeight(axis, dayIndex, segment.startMin, geometry), durationToHeight(segment.endMin - segment.startMin, geometry));
                  return (
                  <div
                    key={`${segment.interval.sourceId}:${segment.interval.start}:${segment.interval.end}:${segment.startMin}`}
                    className={
                      height < 12
                        ? "absolute top-(--event-top) left-(--event-left) z-0 grid h-(--event-height) w-(--event-width) min-w-0 content-start gap-0.5 overflow-hidden rounded-sm bg-pigment p-0 text-left text-pigment-ink @container-size/event-block"
                        : "absolute top-(--event-top) left-(--event-left) z-0 grid h-(--event-height) w-(--event-width) min-w-0 content-start gap-0.5 overflow-hidden rounded-sm bg-pigment px-1.5 py-1 text-left text-pigment-ink @container-size/event-block"
                    }
                    data-availability-interval=""
                    role="note"
                    aria-label={`Busy, ${segment.interval.label}, ${dayKey(day)}, ${axisTimeLabel(axis, dayIndex, segment.startMin, timeFormat)}–${axisTimeLabel(axis, dayIndex, segment.endMin, timeFormat, "end")}`}
                    style={
                      {
                        "--pigment": DEFAULT_CALENDAR_COLOR,
                        "--pigment-ink": getReadableEventTextColor(DEFAULT_CALENDAR_COLOR),
                        "--event-top": `${minutesToY(segment.startMin, geometry)}px`,
                        "--event-height": `${height}px`,
                        "--event-left": placement.left,
                        "--event-width": placement.width,
                      } as CSSProperties
                    }
                  >
                    <span className="hidden truncate font-mono text-10 block-time:block">{axisTimeLabel(axis, dayIndex, segment.startMin, timeFormat)}–{axisTimeLabel(axis, dayIndex, segment.endMin, timeFormat, "end")}</span>
                    <span className="truncate text-11 leading-tight">Busy</span>
                    <span className="hidden truncate text-10 opacity-80 block-meta:block">{segment.interval.label}</span>
                  </div>
                  );
                })}
								{today && nowMinutes !== null ? (
									<div
										className="pointer-events-none absolute inset-x-0 top-(--event-top) z-6 h-0.5 bg-shu"
										data-current-time
										style={{ "--event-top": `${minutesToY(nowMinutes, geometry)}px` } as CSSProperties}
									>
										<span className="absolute -top-0.5 -left-0.5 size-1.5 rounded-full bg-shu" />
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}
