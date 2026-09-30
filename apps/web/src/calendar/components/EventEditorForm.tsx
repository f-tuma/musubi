import { createPortal } from "react-dom";
import { TimeZonePicker } from "./TimeZonePicker";
import { chooseEventTimeKind } from "@musubi/calendar";
import {
	can,
	DEFAULT_CALENDAR_COLOR,
	providerDisplayName,
	providerFlavor,
	type Calendar,
	type Event,
	type Settings,
} from "@musubi/types";
import {
	CalendarDays,
	ChevronDown,
	Globe2,
	Sun,
	House,
	Maximize2,
	Minimize2,
	Repeat2,
	UsersRound,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefCallback,
	type RefObject,
	useId,
	useState,
} from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field, FieldGroup } from "~/components/ui/field";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { ItemGroup } from "~/components/ui/item";
import { Label } from "~/components/ui/label";
import { RowAction } from "~/components/ui/row";
import { SectionLabel } from "~/components/ui/section-label";
import { Select } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { DatePicker } from "~/components/ui/date-picker";
import { minutesToTime, TimePicker, timeToMinutes } from "~/components/ui/time-picker";
import { groupCalendars } from "../calendar-groups";
import { shiftDayKey } from "../date-key";
import {
	type EventFormValues,
	eventBoundaries,
	selectHomeCalendar,
	validateEventForm,
} from "../event-form";
import {
	connectionOfCalendar,
	federatedConnectionMap,
} from "../federation-routing";
import { useSnapshot } from "~/offline/SnapshotProvider";
import { createTimeGeometry } from "../time-geometry";
import { CalendarDot } from "./CalendarDot";
import { AccountMark } from "./ProviderIcon";
import { RecurrenceEditor } from "./RecurrenceEditor";

type FormError = {
	message: string;
	requestId?: string;
};

const TIME_SNAP_MINUTES = createTimeGeometry().snapMinutes;
const LAST_MINUTE = 24 * 60 - 1;
const LATEST_START_TIME = minutesToTime(LAST_MINUTE - TIME_SNAP_MINUTES);
const LATEST_END_TIME = minutesToTime(LAST_MINUTE);

/** What the grid's draft is drawn from: when it is, and which calendar's colour. */
function draftSignature(values: EventFormValues): string {
	return [
		values.calendarId,
		values.date,
		values.endDate,
		values.endTime,
		values.isAllDay,
		values.startTime,
	].join("|");
}

/** The "when" fields a gesture outside the form can move under it. */
export type EventWhen = Pick<
	EventFormValues,
	"date" | "endDate" | "endTime" | "isAllDay" | "startTime" | "exactRange"
>;

type EventEditorFormProps = {
	rdateMaster?: Event;
	calendarLocked?: boolean;
	calendars: Calendar[];
	localAccountName?: string;
	/**
	 * Quick create: only what a new event cannot do without — name, when, which
	 * calendar — with the rest behind one disclosure. Same form, same validation,
	 * same submit; only how much of it is on screen differs (R3, R5).
	 */
	compact?: boolean;
	/**
	 * Opens the full editor with the current draft. Panel shells render the action
	 * in their header; compact forms can also disclose the remaining fields in place.
	 */
	onExpand?: (values: EventFormValues) => void;
	/** Return an expanded inspector to its previous size, retaining this form. */
	onCollapse?: () => void;
	/** Header slot; the form retains the current draft and saving guard. */
	expandActionContainer?: HTMLElement | null;
	initialValues: EventFormValues;
	/** Retain a draft across an access-change unmount without retaining provider baselines. */
	onValuesChange?: (values: EventFormValues) => void;
	/** Panel editors own a scrolling body and fixed actions inside an inspector. */
	layout?: "page" | "popover" | "panel";
	/**
	 * The title field, for a shell that owns its own opening focus. `autoFocus`
	 * is enough on a page; inside a dialog the shell moves focus after mount and
	 * would take it away again.
	 */
	titleRef?: RefObject<HTMLInputElement | null>;
	/**
	 * A new "when" from outside the form — the draft block being dragged on the
	 * grid while this is open. Only these fields are replaced, so a title that is
	 * already typed survives the move.
	 */
	when?: EventWhen;
	/**
	 * Grid ← form. The draft on the grid is the same event this form describes, so
	 * editing the time, the length or the calendar has to move and recolour it —
	 * otherwise the block says one thing and the fields another. Only fires on a
	 * real change, so the `when` prop coming back the other way cannot loop.
	 */
	onDraftChange?: (draft: EventWhen & { color?: string }) => void;
	onCancel: () => void;
	onError: (error: unknown, values: EventFormValues) => FormError;
	onSubmit: (values: EventFormValues) => Promise<void>;
	/** A remounting shell may keep write state above the form. */
	submissionState?: { saving: boolean; error?: FormError };
	submitLabel: string;
	submitRef?: RefCallback<HTMLButtonElement>;
	timeFormat: Settings["timeFormat"];
	weekStartsOn: Settings["weekStartsOn"];
};

export function EventEditorForm({
	rdateMaster,
	calendarLocked = false,
	calendars,
	localAccountName,
	compact = false,
	initialValues,
	onValuesChange,
	layout = "popover",
	onCancel,
	onDraftChange,
	onExpand,
	onCollapse,
	expandActionContainer,
	onError,
	onSubmit,
	submissionState,
	submitLabel,
	submitRef,
	timeFormat,
	titleRef,
	weekStartsOn,
	when,
}: EventEditorFormProps) {
	const id = useId();
	const panel = layout === "panel";
	// What the app knows, not what the browser guesses: a self-hosted server that
	// is down looks online to `navigator`.
	const { offline } = useSnapshot();
	const [values, setValues] = useState(initialValues);
	const [expanded, setExpanded] = useState(!compact);
	const [calendarPickerOpen, setCalendarPickerOpen] = useState(false);
	const [placementMessage, setPlacementMessage] = useState("");
	// Adjusted during render rather than from an effect: the form must never
	// paint a time the grid has already moved on from.
	const whenSignature = when ? JSON.stringify(when) : "";
	const [syncedWhen, setSyncedWhen] = useState(whenSignature);
	if (when && syncedWhen !== whenSignature) {
		setSyncedWhen(whenSignature);
		setValues((current) => ({ ...current, ...when, invalidatedExactEndpoints: undefined }));
	}
	const [localError, setError] = useState<FormError>();
	const [localSaving, setSaving] = useState(false);
	const saving = submissionState?.saving ?? localSaving;
	const error = submissionState?.error ?? localError;
	const selectedCalendar = calendars.find(
		(calendar) => calendar.id === values.calendarId,
	);
	const selectedCalendarIds = new Set(values.calendarIds);
	const calendarGroups = groupCalendars(calendars);
	const homeServer = calendarServer(selectedCalendar);
	const calendarCount = values.calendarIds.length;
	const calendarDisclosure = panel || !expanded;
	const showCalendarList = !calendarDisclosure || calendarPickerOpen;

	function patch(next: Partial<EventFormValues>) {
		const changed = (keys: (keyof EventFormValues)[]) => keys.some((key) => key in next && next[key] !== values[key]);
		const invalidated = new Set(values.invalidatedExactEndpoints);
		if (changed(["date", "startTime", "isAllDay", "timeKind", "timeZone"])) invalidated.add("start");
		if (changed(["endDate", "endTime", "isAllDay", "timeKind", "timeZone"])) invalidated.add("end");
		const merged = { ...values, ...next, invalidatedExactEndpoints: [...invalidated] };

		setValues(merged);
		onValuesChange?.(merged);
		setError(undefined);
		if (onDraftChange && draftSignature(merged) !== draftSignature(values)) {
			let exactRange = merged.exactRange;
			if (!merged.isAllDay && (!merged.timeKind || merged.timeKind === "legacy-unknown")) {
				try {
					exactRange = eventBoundaries(merged);
				} catch {
					// Keep the last valid grid preview until the civil edit resolves.
					return;
				}
			}
			onDraftChange({
				color: calendars.find((calendar) => calendar.id === merged.calendarId)
					?.color,
				date: merged.date,
				exactRange: merged.isAllDay ? undefined : exactRange,
				endDate: merged.endDate,
				endTime: merged.endTime,
				isAllDay: merged.isAllDay,
				startTime: merged.startTime,
			});
		}
	}

	function changeStartTime(startTime: string) {
		const previousStart = timeToMinutes(values.startTime);
		const previousEnd = timeToMinutes(values.endTime);
		const nextStart = timeToMinutes(startTime);
		if (nextStart === null) return;

		const previousDuration =
			previousStart !== null && previousEnd !== null && previousEnd > previousStart
				? previousEnd - previousStart
				: 60;
		const nextEnd = Math.min(
			LAST_MINUTE,
			nextStart + Math.max(TIME_SNAP_MINUTES, previousDuration),
		);

		patch({
			endTime: minutesToTime(nextEnd),
			startTime,
		});
	}

	function changeHomeCalendar(calendar: Calendar) {
		const switchedServer = calendarServer(calendar) !== homeServer;
		const change = selectHomeCalendar(values, calendar.id, (calendarId) =>
			calendarServer(calendars.find((item) => item.id === calendarId)),
		);

		patch({
			calendarId: change.calendarId,
			calendarIds: change.calendarIds,
		});
		setPlacementMessage(
			switchedServer && change.removedCalendarCount > 0
				? `${calendar.name} is now home. ${change.removedCalendarCount} ${
						change.removedCalendarCount === 1 ? "calendar was" : "calendars were"
					} removed because an event cannot span Musubi servers.`
				: `${calendar.name} is now the home calendar.`,
		);
	}

	function changeCalendarMembership(calendar: Calendar, checked: boolean) {
		patch({
			calendarIds: checked
				? Array.from(new Set([...values.calendarIds, calendar.id]))
				: values.calendarIds.filter((calendarId) => calendarId !== calendar.id),
		});
		setPlacementMessage(
			checked
				? `Event will also appear in ${calendar.name}.`
				: `Event will no longer appear in ${calendar.name}.`,
		);
	}

	async function handleSubmit(submitEvent: FormEvent<HTMLFormElement>) {
		submitEvent.preventDefault();
		const validationError = validateEventForm(
			values,
			federatedConnectionMap(calendars),
		);

		if (validationError) {
			setError({ message: validationError });
			return;
		}

		setSaving(true);
		setError(undefined);

		try {
			await onSubmit(values);
		} catch (submitError) {
			setError(onError(submitError, values));
		} finally {
			setSaving(false);
		}
	}

	function handleExpand() {
		try {
			if (onExpand) onExpand(values);
			else setExpanded(true);
		} catch (error) {
			setError(onError(error, values));
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			event.currentTarget.requestSubmit();
		}
	}

	function changeTimeModel(next: Partial<EventFormValues>) {
		patch({
			...next,
            ...(values.createID && next.timeKind === "zoned" && !next.timeZone && !values.timeZone ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, timeLabel: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
			...(panel && next.isAllDay && values.endDate < values.date
				? { endDate: values.date }
				: {}),
		});
	}

	function changeAllDay(checked: boolean) {
		changeTimeModel(values.timeKind && values.timeKind !== "legacy-unknown"
			? chooseEventTimeKind(values, checked ? "all-day" : "zoned")
			: { isAllDay: checked });
	}

	// Popovers grow down; narrow sheets grow up. Keep the toggle on the
	// anchored side of the conditional time row, with matching DOM/tab order.
	const allDayToggle = (
		<div className="flex min-h-control items-center gap-2">
			<Sun aria-hidden="true" className="w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
			<span aria-hidden="true" className="flex-1 text-13 text-foreground">All day</span>
			<Switch label="All day" checked={values.isAllDay} disabled={saving} onCheckedChange={changeAllDay} />
		</div>
	);

	const attendanceToggle = (
		<div className="flex min-h-control items-center gap-2">
			<UsersRound aria-hidden="true" className="w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
			<span className="flex flex-1 items-center gap-1">
				<Label htmlFor={`${id}-attendance`}>Allow attendance</Label>
				<HelpTooltip label="Help for Allow attendance">Guests can respond to this event.</HelpTooltip>
			</span>
			<Switch id={`${id}-attendance`} label="Allow attendance" checked={values.hasAttendees} disabled={saving} onCheckedChange={hasAttendees => patch({ hasAttendees })} />
		</div>
	);

	const timeModelFields = values.timeEditable && expanded ? (
		<>
			<Field label="Time model" help="The selected model interprets the event dates and times. Changing it may change when the event occurs.">
				<Select label="Time model" value={values.timeKind === "legacy-unknown" ? "" : values.timeKind ?? ""} placeholder="Not specified" disabled={saving}
					options={[{ value: "zoned", label: "Event time zone" }, { value: "floating", label: "Floating local time" }, { value: "all-day", label: "All-day dates" }]}
					onChange={kind => changeTimeModel(chooseEventTimeKind(values, kind as "zoned" | "floating" | "all-day"))} />
			</Field>
			{values.timeKind === "zoned" && <Field label="Event time zone" help="Uses the dates and times shown in the editor.">
				<TimeZonePicker value={values.timeZone ?? ""} disabled={saving} onChange={value => patch({ timeZone: value, timeLabel: value })} />
			</Field>}
		</>
	) : null;

	const endMin = values.endDate === values.date
		? minutesToTime(Math.min(LAST_MINUTE, (timeToMinutes(values.startTime) ?? 0) + TIME_SNAP_MINUTES))
		: undefined;
	const pageLayout = layout === "page";

	return (
		<form
			aria-busy={saving || undefined}
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-compact={!expanded ? "" : undefined}
			data-layout={layout}
			onKeyDown={handleKeyDown}
			onSubmit={handleSubmit}
		>
			<div data-editor-body="" className={cn(
				"flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-6 pt-1 pb-5",
				// Expanded: title across, then three columns that each scroll on their
				// own, so the calendar list gives way instead of the layer.
				pageLayout && "md:grid md:grid-cols-3 md:grid-rows-header-body md:gap-x-8 md:overflow-hidden",
			)}>
				<Field className={cn(pageLayout && "md:col-span-3")} label="Event title" labelHidden>
					<Input
						variant="title"
						autoFocus
						disabled={saving}
						placeholder="Event title"
						ref={titleRef}
						value={values.title}
						onChange={(event) => patch({ title: event.target.value })}
					/>
				</Field>

				<section aria-label="When" className={cn("grid min-w-0 content-start gap-3", pageLayout && "md:min-h-0 md:overflow-y-auto")} data-editor-section="when">
					{layout === "popover" ? timeModelFields : null}
					<div className="flex min-w-0 items-center gap-2">
						<CalendarDays aria-hidden="true" className="w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
						<span aria-hidden="true" className="w-12 flex-none text-13 text-foreground-secondary">Starts</span>
						{/* Date and time share a line while both fit; in a narrow column the
						    time moves under the date instead of the date being cut to one letter. */}
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<Field className="min-w-40 flex-1" label="Date" labelHidden>
							<DatePicker
								disabled={saving}
								label="Date"
								value={values.date}
								weekStartsOn={weekStartsOn}
								onChange={(date) =>
									patch({
										date,
										...(!values.isAllDay && values.endDate === values.date
											? { endDate: date }
											: {}),
									})
								}
							/>
						</Field>
						{!values.isAllDay ? (
							<Field className="w-32 flex-none" label="Start time" labelHidden>
								<TimePicker
									disabled={saving}
									label="Start time"
									max={LATEST_START_TIME}
									timeFormat={timeFormat}
									value={values.startTime}
									onChange={changeStartTime}
								/>
							</Field>
						) : null}
						</div>
					</div>
					{/* The panel displays an exclusive all-day end; drafts and writes keep
					    Musubi's inclusive last date, just like grid selections. */}
					<div className="flex min-w-0 items-center gap-2">
						<span aria-hidden="true" className="w-5 flex-none" />
						<span className="flex w-12 flex-none items-center text-13 text-foreground-secondary">
							<span aria-hidden="true">Ends</span>
							{panel && values.isAllDay ? <HelpTooltip label="Help for end date">The end date is not included. A one-day event ends on the following date.</HelpTooltip> : null}
						</span>
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<Field className="min-w-40 flex-1" label="Ends" labelHidden>
							<DatePicker
								disabled={saving}
								label="Ends"
								min={panel && values.isAllDay ? shiftDayKey(values.date, 1) : values.date}
								value={panel && values.isAllDay ? shiftDayKey(values.endDate, 1) : values.endDate}
								weekStartsOn={weekStartsOn}
								onChange={(endDate) => patch({ endDate: panel && values.isAllDay ? shiftDayKey(endDate, -1) : endDate })}
							/>
						</Field>
						{!values.isAllDay ? (
							<Field className="w-32 flex-none" label="End time" labelHidden>
								<TimePicker
									disabled={saving}
									label="End time"
									max={LATEST_END_TIME}
									min={endMin}
									timeFormat={timeFormat}
									value={values.endTime}
									onChange={(endTime) => patch({ endTime })}
								/>
							</Field>
						) : null}
						</div>
					</div>

					{allDayToggle}

					{values.timeLabel ? <p className="pl-7 text-12 text-muted-foreground">{values.timeLabel}</p> : null}

					{expanded ? (
						<div className="flex min-w-0 items-start gap-2">
							<Repeat2 aria-hidden="true" className="mt-2.5 w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
							<span aria-hidden="true" className="mt-2.5 w-12 flex-none text-13 text-foreground-secondary">Repeat</span>
							<Field className="min-w-0 flex-1" label="Repeat" labelHidden>
								<RecurrenceEditor
									rdateMaster={rdateMaster}
									weekStartsOn={weekStartsOn}
									allDay={values.timeKind === "all-day"}
									date={values.date}
									disabled={saving}
									value={values.recurrence}
									onChange={(recurrence) => patch({ recurrence })}
								/>
							</Field>
						</div>
					) : null}
					{expanded && pageLayout ? attendanceToggle : null}
					{pageLayout && timeModelFields ? <FieldGroup>{timeModelFields}</FieldGroup> : null}
				</section>

				{expanded ? (
					<section aria-label="Details" className={cn("flex min-w-0 flex-col gap-5", pageLayout && "md:min-h-0 md:overflow-y-auto")} data-editor-section="details">
						{!pageLayout ? attendanceToggle : null}
						<Field label="Location">
							<Input
								disabled={saving}
								placeholder="Add location"
								value={values.location}
								onChange={(event) => patch({ location: event.target.value })}
							/>
						</Field>
						<Field label="Link">
							<Input
								disabled={saving}
								placeholder="Add link"
								type="url"
								value={values.url}
								onChange={(event) => patch({ url: event.target.value })}
							/>
						</Field>
						<Field label="Description">
							<Textarea
								disabled={saving}
								placeholder="Add notes"
								rows={panel || pageLayout ? 8 : 3}
								value={values.description}
								onChange={(event) => patch({ description: event.target.value })}
							/>
						</Field>
					</section>
				) : null}

				<section
					aria-labelledby={`${id}-calendar-heading`}
					className={cn("flex min-w-0 flex-col gap-3", pageLayout && "md:min-h-0")}
					data-editor-section="calendars"
				>
					<div className="flex min-h-5 items-center gap-1">
						<SectionLabel id={`${id}-calendar-heading`} level={3}>Calendars</SectionLabel>
						<HelpTooltip label="Help for Calendars">Choose where the event appears. Its home calendar owns updates, invitations, and the event color.</HelpTooltip>
					</div>

					{calendarDisclosure ? (
						<ItemGroup>
							<RowAction
								aria-controls={`${id}-calendar-list`}
								aria-expanded={calendarPickerOpen}
								aria-label={`Choose calendars. ${
									selectedCalendar?.name ?? "No calendar"
								} is home. Event appears in ${calendarCount} ${
									calendarCount === 1 ? "calendar" : "calendars"
								}.`}
								detail={calendarCount > 1 ? `Home · in ${calendarCount} calendars` : "This calendar only"}
								disabled={saving}
								icon={<AccountMark size="compact" flavor={selectedCalendar ? providerFlavor(selectedCalendar) : null} color={selectedCalendar?.color ?? DEFAULT_CALENDAR_COLOR} />}
								label={<span className="truncate">{selectedCalendar?.name ?? "Choose a calendar"}</span>}
								trailing={
									<span className="inline-flex items-center gap-1 text-12 text-muted-foreground">
										Change
										<ChevronDown aria-hidden="true" className={cn("size-4 transition-transform duration-fast", calendarPickerOpen && "rotate-180")} strokeWidth={1.6} />
									</span>
								}
								onClick={() => setCalendarPickerOpen((current) => !current)}
							/>
						</ItemGroup>
					) : null}

					{showCalendarList ? (
						<fieldset
							className={cn("m-0 flex min-w-0 flex-col gap-3 border-0 p-0 *:shrink-0", calendarDisclosure && !panel && "max-h-80 overflow-y-auto overscroll-contain", pageLayout && "md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain")}
							data-ui="calendar-placement"
							id={`${id}-calendar-list`}
						>
							<legend className="sr-only">Calendars for this event</legend>

							{calendarGroups.map((group) => (
								<ItemGroup key={group.key}>
									{calendarGroups.length > 1 ? (
										<div className="flex min-w-0 items-center gap-2 px-3 py-2 text-12 font-medium text-foreground-secondary">
											<AccountMark size="compact" flavor={group.flavor} />
											<span className="truncate">{group.key === "musubi" ? localAccountName?.trim() || group.title : group.title}</span>
											{group.key === "musubi" && localAccountName?.trim() ? (
												<span className="sr-only"> · Musubi</span>
											) : null}
											{group.flavor && group.title !== group.detail ? (
												<span className="sr-only"> · {group.detail}</span>
											) : null}
										</div>
									) : null}
									<ul className="divide-y divide-border-subtle">
										{group.calendars.map((calendar) => {
											const checked = selectedCalendarIds.has(calendar.id);
											const isHome = values.calendarId === calendar.id;
											const compatible = calendarServer(calendar) === homeServer;
											const membershipLocked =
												saving || isHome || !compatible || !can(calendar.role, "editEvents");
											const homeLocked =
												saving || calendarLocked || !can(calendar.role, "editEvents");
											const detail = !compatible
												? "Choose as home to switch Musubi server"
												: calendarGroups.length > 1 && calendar.provider ? null : calendarSourceDetail(calendar);

											return (
												<li className="flex min-h-row min-w-0 items-center gap-2 px-3" key={calendar.id}>
													<Checkbox
														aria-label={`Show event in ${calendar.name}`}
														checked={checked}
														className="min-w-0 flex-1"
														description={detail ?? undefined}
														disabled={membershipLocked}
														label={<span className="flex min-w-0 items-center gap-2 text-foreground"><CalendarDot color={calendar.color} /><span className="truncate">{calendar.name}</span></span>}
														onChange={(event) => changeCalendarMembership(calendar, event.target.checked)}
													/>

													{calendarLocked ? (
														isHome ? (
															<span aria-label="Home calendar" className="grid size-10 flex-none place-content-center text-foreground-secondary" role="img">
																<House aria-hidden="true" size={14} strokeWidth={1.7} />
															</span>
														) : (
															<span aria-hidden="true" className="size-10 flex-none" />
														)
													) : (
														<label className={cn("relative grid size-10 flex-none place-content-center rounded-control", homeLocked ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
															<input
																aria-label={`${calendar.name} as home calendar`}
																checked={isHome}
																className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
																disabled={homeLocked}
																name={`${id}-home-calendar`}
																type="radio"
																value={calendar.id}
																onChange={() => changeHomeCalendar(calendar)}
															/>
															<span aria-hidden="true" className="grid size-7 place-content-center rounded-full border border-border text-foreground-secondary transition-colors duration-fast peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-shu">
																<House size={14} strokeWidth={1.7} />
															</span>
															<span className="sr-only">{isHome ? "Home" : "Make home"}</span>
														</label>
													)}
												</li>
											);
										})}
									</ul>
								</ItemGroup>
							))}
						</fieldset>
					) : null}

					{placementMessage ? (
						<span aria-live="polite" className="sr-only" role="status">
							{placementMessage}
						</span>
					) : null}
				</section>

				{panel && timeModelFields ? (
					<section aria-labelledby={`${id}-time-settings`} className="flex flex-col gap-3">
						<div className="flex items-center gap-2">
							<Globe2 aria-hidden="true" className="w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
							<SectionLabel id={`${id}-time-settings`} level={3}>Time settings</SectionLabel>
						</div>
						<FieldGroup>{timeModelFields}</FieldGroup>
					</section>
				) : null}

				{error ? (
					<InlineError className={cn(pageLayout && "md:col-span-3")} requestId={error.requestId}>{error.message}</InlineError>
				) : null}
			</div>

			<div className="mb-safe-bottom flex flex-none flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-6 py-4">
				{expanded && onExpand && expandActionContainer ? createPortal(
					<Button
						aria-label={onCollapse ? "Collapse event editor" : "Expand event editor"}
						title={onCollapse ? "Collapse event editor" : "Expand event editor"}
						disabled={saving}
						size="icon-compact"
						variant="ghost"
						onClick={onCollapse ?? handleExpand}
					>
						{onCollapse ? <Minimize2 aria-hidden="true" strokeWidth={1.6} /> : <Maximize2 aria-hidden="true" strokeWidth={1.6} />}
					</Button>,
					expandActionContainer,
				) : null}
				{expanded ? (
					<Button disabled={saving} variant="secondary" onClick={onCancel}>
						Cancel
					</Button>
				) : (
					// One disclosure, in place: the draft carries over because it is the
					// same form state, not a second editor.
					<Button className="mr-auto" disabled={saving} variant="ghost" onClick={handleExpand}>
						More options
					</Button>
				)}
				{/* The form stays open and keeps everything typed — a draft is worth
				    more than a cleared screen — but the button says why it cannot go
				    (`07-realtime-offline-federation.md:103`). */}
				<Button
					disabled={offline}
					loading={saving}
					ref={submitRef}
					title={
						offline
							? "The server cannot be reached — nothing can be saved yet"
							: undefined
					}
					type="submit"
				>
					{offline ? "No connection" : saving ? "Saving…" : submitLabel}
				</Button>
			</div>
		</form>
	);
}

function calendarServer(calendar: Calendar | undefined) {
	return connectionOfCalendar(calendar) ?? "home";
}

function calendarSourceDetail(calendar: Calendar) {
	if (calendar.provider) return providerDisplayName(calendar);
	if (calendar.isDefault) return null;
	return calendar.role === "owner" ? "Your calendar" : "Shared calendar";
}
