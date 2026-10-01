import { isCalendarTask } from "@musubi/calendar";
import { providerFlavor, type Calendar, type Event, type Settings } from "@musubi/types";
import { MapPin } from "lucide-react";
import { type CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
	AGENDA_FREE_DAYS_MIN,
	AGENDA_GROUP_PAGE,
	freeDaysBetween,
	getAgendaGroups,
	getAgendaLabel,
	relativeDayName,
} from "../agenda-math";
import { getEventDateLabel, getEventRangeLabel } from "../calendar-math";
import { toDateKey } from "../date-key";
import { eventHomeCalendarId } from "../event-permissions";
import { EventMarks } from "./EventMarks";
import {
	EventDetailsPopover,
	type EventActionHandlers,
} from "./EventDetailsPopover";
import { AccountMark } from "./ProviderIcon";

type AgendaViewProps = EventActionHandlers & {
	anchor: Date;
	calendars: Calendar[];
	events: Event[];
	timeFormat: Settings["timeFormat"];
	weekStartsOn: Settings["weekStartsOn"];
};

const weekdayFormatter = new Intl.DateTimeFormat("en", { weekday: "long" });
const shortMonthFormatter = new Intl.DateTimeFormat("en", { month: "short" });
const monthFormatter = new Intl.DateTimeFormat("en", { month: "long" });

export function AgendaView({
	anchor,
	calendars,
	events,
	timeFormat,
	weekStartsOn,
	...eventActions
}: AgendaViewProps) {
	// One reading per render keeps the relative labels aligned.
	const now = new Date();
	const groups = getAgendaGroups(events, anchor);
	const calendarsById = useMemo(
		() => new Map(calendars.map((calendar) => [calendar.id, calendar])),
		[calendars],
	);
	const groupFingerprint = `${anchor.getTime()}:${events
		.map((event) => event.id)
		.join("|")}`;
	const [pagination, setPagination] = useState({
		fingerprint: groupFingerprint,
		shown: AGENDA_GROUP_PAGE,
	});
	const shown =
		pagination.fingerprint === groupFingerprint
			? pagination.shown
			: AGENDA_GROUP_PAGE;
	const rootRef = useRef<HTMLElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const visibleGroups = groups.slice(0, shown);
	const todayKey = toDateKey(now);

	useEffect(() => {
		const scrollRoot = rootRef.current?.parentElement;

		if (scrollRoot && typeof scrollRoot.scrollTo === "function") {
			scrollRoot.scrollTo({ behavior: "auto", top: 0 });
		}
	}, [groupFingerprint]);

	useEffect(() => {
		const sentinel = sentinelRef.current;

		if (
			!sentinel ||
			shown >= groups.length ||
			typeof IntersectionObserver === "undefined"
		) {
			return;
		}

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) {
					setPagination((current) => ({
						fingerprint: groupFingerprint,
						shown: Math.min(
							(current.fingerprint === groupFingerprint
								? current.shown
								: AGENDA_GROUP_PAGE) + AGENDA_GROUP_PAGE,
							groups.length,
						),
					}));
				}
			},
			{
				root: rootRef.current?.parentElement ?? null,
				// Match the mobile Agenda: prepare the next batch before the user
				// reaches the edge, so the list reads as one continuous timeline.
				rootMargin: "0px 0px 400px",
			},
		);
		observer.observe(sentinel);

		return () => observer.disconnect();
	}, [groupFingerprint, groups.length, shown]);


	return (
		<section
			className="min-h-full w-full p-5"
			aria-label={`${getAgendaLabel(anchor)} agenda`}
			ref={rootRef}
		>
			<ol className="m-0 list-none p-0">
				{visibleGroups.map((group, groupIndex) => {
					const previous = visibleGroups[groupIndex - 1]?.date;
					const isNewYear =
						groupIndex === 0 || previous?.getFullYear() !== group.date.getFullYear();
					const isNewMonth =
						!isNewYear && previous?.getMonth() !== group.date.getMonth();
					const isToday = group.key === todayKey;
					const relative = relativeDayName(group.date, now);
					// Days with nothing on them are not rendered, so the jump between two
					// groups is the only place free time can be shown at all.
					const freeDays = previous ? freeDaysBetween(previous, group.date) : 0;

					return (
						<Fragment key={group.key}>
							{isNewYear ? (
								<li
									className="sticky top-0 z-3 flex min-h-8 items-center border-b border-border-subtle bg-canvas text-13 text-foreground-secondary"
									aria-hidden="true"
									data-agenda-year={group.date.getFullYear()}
								>
									<span>{group.date.getFullYear()}</span>
								</li>
							) : null}
							{isNewMonth ? (
								<li className="pt-5 pb-2 font-serif text-18" aria-hidden="true">
									<span>{monthFormatter.format(group.date)}</span>
								</li>
							) : null}
							{freeDays >= AGENDA_FREE_DAYS_MIN ? (
								// Indented to the events' edge: the date column plus its gap.
								<li className="py-3 text-12 text-foreground-secondary sm:pl-32">
									<span>{freeDays} free days</span>
								</li>
							) : null}
							<li
								className="flex flex-col gap-3 border-b border-border-subtle py-5 sm:flex-row sm:gap-8"
								data-agenda-date={group.key}
							>
								{/* Sticky under the year, so a long day keeps saying which day it is. */}
								<time
									className="sticky top-8 z-2 flex items-baseline gap-3 self-start bg-canvas pt-3 pb-2 sm:w-24 sm:flex-none sm:flex-col sm:items-start sm:gap-1 sm:pb-0"
									dateTime={group.key}
								>
									<strong
										className={
											isToday
												? "font-serif text-28 leading-tight font-normal text-shu"
												: "font-serif text-28 leading-tight font-normal"
										}
									>
										{group.date.getDate()}
									</strong>
									<span className="text-13">{weekdayFormatter.format(group.date)}</span>
									<small className="text-12 text-foreground-secondary">
										{relative || shortMonthFormatter.format(group.date)}
									</small>
								</time>
								<div className="min-w-0 flex-1">
									{group.items.map((event) => {
										const calendar = calendarsById.get(eventHomeCalendarId(event) ?? "");
										const eventColor = calendar?.color ?? event.color;
										const rangeLabel = getEventRangeLabel(event, timeFormat);
										const [starts, ends] = rangeLabel.split(" – ");

										return (
											<EventDetailsPopover
												calendar={calendar}
												calendars={calendars}
												align="start"
												event={event}
												key={event.id}
												side="bottom"
												timeFormat={timeFormat}
												weekStartsOn={weekStartsOn}
												{...eventActions}
											>
												<button
													className="flex w-full min-w-0 cursor-pointer items-start gap-4 rounded-control bg-transparent px-3 py-4 text-left text-foreground transition-colors duration-fast not-first:border-t not-first:border-border-subtle hover:bg-raised focus-inset motion-reduce:transition-none max-sm:gap-2"
													style={{ "--pigment": eventColor } as CSSProperties}
													type="button"
													aria-label={`${event.title}, ${getEventDateLabel(
														event,
													)}, ${getEventRangeLabel(
														event,
														timeFormat,
													)}, ${calendar?.name ?? "calendar"}`}
													data-agenda-event={event.id}
												>
													<span className="flex w-20 flex-none flex-col gap-1 text-13 leading-normal tabular-nums max-sm:w-14">
														<strong className="font-medium">{starts}</strong>
														{ends ? <span className="text-12 text-foreground-secondary">{ends}</span> : null}
													</span>
													{/* The pigment is the rule down the copy: colour marks the
                              item without filling it. */}
													<span className="min-w-0 flex-1 border-l-3 border-pigment pl-4 max-sm:pl-3">
														<span className="block text-15 leading-normal font-medium wrap-anywhere">
															{isCalendarTask(event) && event.calendarTask.status === "completed" ? (
																<s className="text-foreground-secondary">{event.title}</s>
															) : (
																event.title
															)}
														</span>
														<span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-12 leading-snug text-foreground-secondary">
															<span className="inline-flex min-w-0 items-center gap-1 wrap-anywhere">
																<AccountMark
																	flavor={calendar ? providerFlavor(calendar) : null}
																	color={eventColor}
																	size="compact"
																/>
																{calendar?.name ?? "Calendar"}
															</span>
															{event.location ? (
																<>
																	<span aria-hidden="true">·</span>
																	<span className="inline-flex min-w-0 items-center gap-1 wrap-anywhere">
																		<MapPin aria-hidden="true" className="flex-none" size={13} />
																		{event.location}
																	</span>
																</>
															) : null}
															{isCalendarTask(event) ? (
																<>
																	<span aria-hidden="true">·</span>
																	<span>
																		{event.calendarTask.status === "completed" ? "Completed task" : "Task"}
																	</span>
																</>
															) : null}
															<EventMarks event={event} />
														</span>
													</span>
												</button>
											</EventDetailsPopover>
										);
									})}
								</div>
							</li>
						</Fragment>
					);
				})}
			</ol>
			{shown < groups.length ? (
				<div
					className="h-px"
					data-agenda-sentinel
					ref={sentinelRef}
					role="status"
					aria-label="Loading more events"
				/>
			) : null}
		</section>
	);
}
