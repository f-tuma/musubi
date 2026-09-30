import { isCalendarTask } from "@musubi/calendar";
import { CalendarTaskDetails } from "./CalendarTaskDetails";
import { isGoogleEditorPrivacyRefresh, refreshPrivateEditorBaseline, refreshPrivateEditorValues, rememberPrivateEditorChanges, type PrivateEditorField } from "../event-editor-privacy";
import { ProviderRsvpEditor } from "./ProviderRsvpEditor";
import { ProviderReminderEditor } from "./ProviderReminderEditor";
import { getServerOrigin } from "~/api/query-keys";
import type { ProviderEventStateResponse } from "@musubi/types";
import { AccountMark } from "./ProviderIcon";
import { ProviderEventDetails } from "./ProviderEventDetails";
import { hasKnownEventTime, type EventScopeRequest } from "@musubi/types";
import { eventScopeRequest } from "@musubi/calendar";
import {
	requireEventRevision,
	editedEvent,
	EventMutationError,
} from "@musubi/types";
import {
	endSeriesBefore,
	excludeOccurrence,
	noteParts,
	seriesEditWrites,
	withSeriesEditIntent,
	shortUrlLabel,
	type EditScope,
} from "@musubi/calendar";
import type { Calendar, Event, Settings } from "@musubi/types";
import { providerDisplayName, providerFlavor, sameRule } from "@musubi/types";
import {
	ArrowLeft,
	BellRing,
	ChevronDown,
	Check,
	Clock3,
	CopyPlus,
	Ellipsis,
	FileText,
	Link2,
	MapPin,
	Pencil,
	Repeat2,
	RefreshCw,
	Trash2,
	UsersRound,
	X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { Attendee, RemoveEventResponse } from "~/api/contracts";
import {
	answerLabel,
	ATTENDANCE_CHOICES,
	groupAttendees,
	type AttendanceChoice,
} from "../attendance";
import { EventDeliveryDialog } from "./EventDeliveryDialog";
import { getEventAttendees } from "~/api/resources";
import { cn } from "~/lib/utils";
import { Avatar, AvatarStackPreview } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { Disclosure } from "~/components/ui/disclosure";
import { Empty } from "~/components/ui/empty";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { ItemGroup } from "~/components/ui/item";
import { RowAction } from "~/components/ui/row";
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
} from "~/ui/Menu";
import { InspectorHeaderActions, Inspector as Popover, InspectorTrigger as PopoverTrigger, InspectorClose as PopoverClose, InspectorContent as PopoverContent } from "~/ui/Inspector";
import { getEventDateLabel, getEventRangeLabel } from "../calendar-math";
import {
	eventFormValues,
	updateEventFromForm,
	type EventFormValues,
} from "../event-form";
import { connectionOfCalendar } from "../federation-routing";
import {
	canEditEvent,
	canRemoveEvent,
	eventHomeCalendarId,
	getEditableCalendars,
	getEventHomeCalendar,
	getEventMutationError,
} from "../event-permissions";
import type { Notify } from "../notice";
import {
	eventReminder,
	inheritedEventReminder,
	type EventReminder,
	type ReminderControl,
} from "../reminder-control";
import {
	allDayValue,
	optionsFor,
	timedValue,
	withAllDay,
	withTimed,
} from "@musubi/types";
import { CalendarDot } from "./CalendarDot";
import { EventEditorForm } from "./EventEditorForm";
import { DetailList, DetailRow, detailLinkClassName, PanelBody, PanelFooter, PanelHeader, PanelTitle } from "./EventPanel";
import { RecurrenceScopeDialog } from "./RecurrenceScopeDialog";

type TargetMutation = {
	expectedRevision?: number;
	calendarId: string;
	eventId: string;
};

export type EventActionHandlers = {
	onApplyEventScope?: (event: Event, request: EventScopeRequest) => Promise<unknown>;
	getEventMaster: (event: Event) => Event;
	onForkEvent: (input: TargetMutation) => Promise<Event>;
	onLinkEvent: (input: TargetMutation) => Promise<Event>;
	onNotice: Notify;
	onOpenFullEditor?: (values: EventFormValues, event: Event) => void;
	onRemoveEvent: (event: Event) => Promise<RemoveEventResponse>;
	/** Creates detached occurrences and split series for scoped recurrence edits. */
	onRestoreEvent?: (event: Event) => Promise<unknown>;
	onSetAttendance: (input: {
		calendarId?: string;
		eventId: string;
		status: AttendanceChoice;
	}) => Promise<Attendee[]>;
	onUpdateEvent: (event: Event) => Promise<Event>;
	/** Absent where reminders are not loaded yet — the control simply hides. */
	reminders?: ReminderControl;
	user: { id: string; name: string };
};

/** Sentinel for the menu item that removes an override rather than setting one. */
const INHERIT = "inherit";

function reminderLabel(reminder: EventReminder, kind: "allDay" | "timed") {
	const value =
		kind === "timed" ? timedValue(reminder.rule) : allDayValue(reminder.rule);
	const option = optionsFor(reminder.rule, kind).find(
		(entry) => entry.value === value,
	);
	return option?.label ?? "Off";
}

/** Faces before the pile turns into "+N", the same count the phone shows. */

type DeleteScope = "occurrence" | "following" | "series";
type DeletePrompt = "confirm" | "scope";
type TargetAction = "fork" | "link";

type EventDetailsPopoverProps = EventActionHandlers & {
	/**
	 * Where the preview opens. The default sits it beside a calendar block; a
	 * full-width row has no room to its right, so a list passes its own side and
	 * alignment rather than letting collision detection flip the card leftwards.
	 */
	align?: "center" | "end" | "start";
	anchorInsideTrigger?: boolean;
	collisionBoundary?: Element | null;
	side?: "bottom" | "left" | "right" | "top";
	calendar: Calendar | undefined;
	calendars: Calendar[];
	children: ReactElement;
	event: Event;
	timeFormat: Settings["timeFormat"];
	weekStartsOn: Settings["weekStartsOn"];
};

export function EventDetailsPopover(props: EventDetailsPopoverProps) {
  if (isCalendarTask(props.event)) return <CalendarTaskDetails taskId={props.event.calendarTask.id}>{props.children}</CalendarTaskDetails>;
  return <CalendarEventDetailsPopover {...props} />;
}

function CalendarEventDetailsPopover({
	calendar,
	calendars,
	children,
	event,
	getEventMaster,
	onForkEvent,
	onLinkEvent,
	onNotice,
	onOpenFullEditor,
	onRemoveEvent,
	onRestoreEvent,
	onSetAttendance,
	onUpdateEvent,
	onApplyEventScope,
	reminders,
	timeFormat,
	user,
	weekStartsOn,
}: EventDetailsPopoverProps) {
	const liveMaster = getEventMaster(event);
	const [draft, setDraft] = useState<{ event: Event; master: Event; values?: EventFormValues; ownedFields?: PrivateEditorField[]; privacyRevision?: number }>();
  const privacyChanged = draft && draft.privacyRevision !== liveMaster.revision && isGoogleEditorPrivacyRefresh(draft.master, liveMaster, calendars);
  if (privacyChanged) {
    setDraft({
      event: refreshPrivateEditorBaseline(draft.event, event),
      master: refreshPrivateEditorBaseline(draft.master, liveMaster),
      values: refreshPrivateEditorValues(draft.values ?? eventFormValues(draft.event), draft.event, event, draft.ownedFields),
      ownedFields: draft.ownedFields,
      privacyRevision: liveMaster.revision,
    });
  }
	const master = draft?.master ?? liveMaster;
	const occurrence = draft?.event ?? event;
	const titleId = useId();
	const notesTitleId = useId();
	const guestsTitleId = useId();
	const targetActionTitleId = useId();
	const reminderTitleId = useId();
	const [open, setOpen] = useState(false);
	const [deliveryTarget, setDeliveryTarget] = useState<{ context: string; eventId: string }>();
  const [providerRsvpEditor, setProviderRsvpEditor] = useState<{ context: string; eventId: string; occurrence: boolean; observation: ProviderEventStateResponse }>();
  const [providerReminderEditor, setProviderReminderEditor] = useState<{ context: string; eventId: string; occurrence: boolean; observation: ProviderEventStateResponse }>();
	const [expandActionContainer, setExpandActionContainer] = useState<HTMLDivElement | null>(null);
	const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // The overflow menu holds Delete, so its trigger is where a closed prompt returns focus.
  const [moreTriggerElement, setMoreTriggerElement] = useState<HTMLButtonElement | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => { if (wasEditing.current && !editing && open) editButtonRef.current?.focus(); wasEditing.current = editing; }, [editing, open]);
  const [discardAction, setDiscardAction] = useState<(() => void)>();
  const draftDirty = editing && draft?.values && JSON.stringify(draft.values) !== JSON.stringify(eventFormValues(master.recurrence && onRestoreEvent ? occurrence : master));
  function requestExit(after: () => void, closePanel = true) {
    if (pendingEdit || saving || busyAction) return;
    const finish = () => { if (closePanel) handleOpenChange(false, true); else { setEditing(false); setDraft(undefined); } after(); };
    if (draftDirty) setDiscardAction(() => finish); else finish();
  }
	const [deletePrompt, setDeletePrompt] = useState<DeletePrompt>();
	// The edit waiting for its scope answer, kept whole so nothing typed is lost
	// if the question is dismissed.
	const [pendingEdit, setPendingEdit] = useState<Event>();
	const [pendingEditScope, setPendingEditScope] = useState<EditScope>();
	const [pendingDeleteScope, setPendingDeleteScope] = useState<DeleteScope>();
  if (privacyChanged) {
    if (pendingEdit) setPendingEdit(undefined);
    if (pendingEditScope) setPendingEditScope(undefined);
    if (pendingDeleteScope) setPendingDeleteScope(undefined);
    if (deletePrompt) setDeletePrompt(undefined);
  }
	const [triggerElement, setTriggerElement] = useState<HTMLElement | null>(null);
	const [busyAction, setBusyAction] = useState<string>();
	const [targetAction, setTargetAction] = useState<TargetAction>();
	const [pendingTargetId, setPendingTargetId] = useState<string>();
	const [editSubmitElement, setEditSubmitElement] =
		useState<HTMLButtonElement | null>(null);
	const targetListRef = useRef<HTMLDivElement>(null);
	const [actionError, setActionError] = useState<{
		message: string;
		requestId?: string;
	}>();
	const homeCalendar = getEventHomeCalendar(master, calendars) ?? calendar;
	const homeCalendarId = eventHomeCalendarId(master);
	// A primitive, so the attendees effect can depend on it without re-running on
	// every re-render of the calendar list.
	const homeConnectionId = connectionOfCalendar(homeCalendar);
  const providerReminderContext = JSON.stringify([getServerOrigin(), user.id, homeConnectionId, event.id, event.seriesID, event.originalStart, event.revision, liveMaster.revision]);
  if (deliveryTarget && deliveryTarget.context !== providerReminderContext) setDeliveryTarget(undefined);
  if (providerReminderEditor && providerReminderEditor.context !== providerReminderContext) setProviderReminderEditor(undefined);
  if (providerRsvpEditor && providerRsvpEditor.context !== providerReminderContext) setProviderRsvpEditor(undefined);
	const removeCalendar =
		getEditableCalendars(calendars).find((item) =>
			master.calendars.includes(item.id),
		) ?? homeCalendar;
	const editable = canEditEvent(master, calendars);
	const removable = canRemoveEvent(master, calendars);
	const targetCalendars = getEditableCalendars(calendars).filter(
		(item) => !master.calendars.includes(item.id),
	);
	const canAddToCalendar = targetCalendars.length > 0;
	const [attendees, setAttendees] = useState<Attendee[]>();
	const [attendeesOpen, setAttendeesOpen] = useState(false);
	const mine = attendees?.find((attendee) => attendee.id === user.id)?.status;
	// The count and the facepile are about who is coming; a "can't go" belongs in
	// the list, not in the row of faces.
	const going =
		attendees?.filter((attendee) => attendee.status === "going") ?? [];
	const eventCalendars = event.calendars
		.map((calendarId) => calendars.find((item) => item.id === calendarId))
		.filter((item): item is Calendar => Boolean(item));
	// The home calendar owns the colour, so the accent matches the block on the
	// grid instead of whichever membership happens to sort first.
	const accentColor = homeCalendar?.color ?? calendar?.color ?? event.color;
	const deleteConsequence = removeCalendar?.provider
		? `This change will also be sent to ${providerDisplayName(removeCalendar)}.`
		: master.recurrence && !hasKnownEventTime(master)
			? "You can undo changes to individual occurrences after choosing."
			: "This cannot be undone.";

	useEffect(() => {
		if (!open || !master.hasAttendees) return;
		const controller = new AbortController();
		let active = true;
		getEventAttendees(master.id, controller.signal, homeConnectionId)
			.then((nextAttendees) => {
				if (active) setAttendees(nextAttendees);
			})
			.catch(() => {
				if (active) setAttendees(undefined);
			});
		return () => {
			active = false;
			controller.abort();
		};
	}, [homeConnectionId, master.hasAttendees, master.id, open]);

	useEffect(() => {
		if (!targetAction) return;
		requestAnimationFrame(() => {
			targetListRef.current
				?.querySelector<HTMLButtonElement>("button:not(:disabled)")
				?.focus();
		});
	}, [targetAction]);

	function handleOpenChange(nextOpen: boolean, force = false) {
		// Firefox and WebKit treat the nested recurrence dialog as an outside
		// interaction. Keep the editor mounted until that dialog resolves.
		if (!nextOpen && pendingEdit && !force) return;
		setOpen(nextOpen);

		if (!nextOpen) {
			setEditing(false);
			setDraft(undefined);
			setActionError(undefined);
			setTargetAction(undefined);
			setPendingTargetId(undefined);
		}
	}

	async function handleUpdate(values: EventFormValues) {
		// A series has to be asked which occurrences an edit belongs to — the same
		// question dragging and deleting one already ask. Answering it before the
		// write is why the form's own submit hands over rather than saving here.
		if (master.recurrence && onRestoreEvent) {
			setPendingEdit(updateEventFromForm(occurrence, values));
			return;
		}

    setSaving(true);
    try {
		const edited = updateEventFromForm(master, values);
    if (homeCalendar?.provider === "caldav" && !master.recurrence && hasKnownEventTime(master)) {
      if (!onApplyEventScope) throw new Error("Scope editing is unavailable. Refresh before saving.");
      await onApplyEventScope(master, eventScopeRequest(master, master, "series", edited));
    } else await onUpdateEvent(edited);
		onNotice("Event updated.");
    setEditing(false);
    setDraft(undefined);
    } finally { setSaving(false); }
	}

	/**
	 * Apply an edit at the chosen scope. `onRestoreEvent` creates the detached
	 * occurrence or the split-off series, which is the only new event any scope
	 * produces.
	 */
	async function applyScopedEdit(edited: Event, scope: EditScope) {
		setBusyAction("update");
		setPendingEditScope(scope);
		setActionError(undefined);

		let savedMaster: Event | undefined;
		try {
			if (hasKnownEventTime(master)) {
                if (!onApplyEventScope) throw new Error("Scope editing is unavailable. Refresh before saving.");
                await onApplyEventScope(master, eventScopeRequest(master, occurrence, scope, edited));
                onNotice("Recurring event updated.");
                setPendingEdit(undefined);
                handleOpenChange(false, true);
                return;
            }
			const { creates, updates } = withSeriesEditIntent(
				seriesEditWrites({
					edited,
					master,
					occurrence,
					scope,
				}),
			);

			// Sequential: the update carries the exclusion that keeps the created
			// event from briefly showing twice.
			for (const update of updates) {
				savedMaster = await onUpdateEvent(update);
			}
			const created: Event[] = [];
			for (const create of creates) {
				created.push((await onRestoreEvent!(create)) as Event);
			}

			onNotice(
				scope === "series"
					? "Recurring series updated."
					: scope === "following"
						? "This and following events updated."
						: "Occurrence updated.",
				"timeEdit" in edited ? undefined : {
					undo: async () => {
						for (const event of created) {
							await onRemoveEvent(event);
						}
						await onUpdateEvent(
							withSeriesEditIntent({
								updates: [editedEvent(savedMaster!, master)],
								creates: [],
							}).updates[0],
						);
					},
				},
			);
			setPendingEdit(undefined);
			handleOpenChange(false, true);
		} catch (error) {
			setActionError(
				getEventMutationError(
					savedMaster
						? new EventMutationError(
								"Part of this recurring edit was saved. Later delivery was not confirmed. Your draft was kept; refresh and reconcile before retrying.",
								true,
							)
						: error,
					"update",
					homeCalendar,
				),
			);
		} finally {
			setBusyAction(undefined);
			setPendingEditScope(undefined);
		}
	}

	async function handleDelete(scope: DeleteScope = "series") {
		setBusyAction("delete");
		setPendingDeleteScope(scope);
		setActionError(undefined);

		try {
            if (master.recurrence && hasKnownEventTime(master)) {
                if (!onApplyEventScope) throw new Error("Scope editing is unavailable. Refresh before saving.");
                await onApplyEventScope(master, eventScopeRequest(master, occurrence, scope));
                onNotice("Recurring event removed.");
                handleOpenChange(false, true);
                return;
            }
			if (
				master.recurrence &&
				scope !== "series" &&
				!(scope === "following" && event.start.getTime() <= master.start.getTime())
			) {
				const recurrence =
					scope === "occurrence"
						? excludeOccurrence(master.recurrence, event.start)
						: endSeriesBefore(master.recurrence, event.start);
				const { updates } = withSeriesEditIntent({
					updates: [{ ...master, recurrence }],
					creates: [],
				});
				const savedMaster = await onUpdateEvent(updates[0]);
				onNotice(
					scope === "occurrence"
						? "Occurrence removed."
						: "Following occurrences removed.",
					// Only the rule changed, so putting the old one back restores the
					// occurrences exactly.
					{
						undo: () =>
							onUpdateEvent(
								withSeriesEditIntent({
									updates: [editedEvent(savedMaster, master)],
									creates: [],
								}).updates[0],
							),
					},
				);
			} else {
				const result = await onRemoveEvent(master);
				onNotice(result.removed ? "Event deleted." : "Event removed.");
			}
			setDeletePrompt(undefined);
			handleOpenChange(false);
		} catch (error) {
			setActionError(
				getEventMutationError(
					error,
					master.recurrence && scope !== "series" ? "update" : "delete",
					removeCalendar,
				),
			);
		} finally {
			setBusyAction(undefined);
			setPendingDeleteScope(undefined);
		}
	}

	function beginDelete() {
		if (master.recurrence) {
			setDeletePrompt("scope");
		} else {
			setDeletePrompt("confirm");
		}
	}

	async function handleTargetAction(action: TargetAction, calendarId: string) {
		setBusyAction(action);
		setPendingTargetId(calendarId);
		setActionError(undefined);

		try {
			if (action === "link") {
				await onLinkEvent({
					calendarId,
					eventId: master.id,
					expectedRevision: requireEventRevision(master),
				});
				onNotice("Event linked to calendar.");
			} else {
				await onForkEvent({
					calendarId,
					eventId: master.id,
					expectedRevision: requireEventRevision(master),
				});
				onNotice("Independent event copy created.");
			}
			setTargetAction(undefined);
			handleOpenChange(false);
		} catch (error) {
			setActionError(
				getEventMutationError(
					error,
					"update",
					calendars.find((item) => item.id === calendarId),
				),
			);
		} finally {
			setBusyAction(undefined);
			setPendingTargetId(undefined);
		}
	}

	function showTargetCalendars(action: TargetAction) {
		setActionError(undefined);
		setTargetAction(action);
	}

	function hideTargetCalendars() {
		setActionError(undefined);
		setTargetAction(undefined);
		// Link and Copy live in the overflow menu, so its trigger takes focus back.
		requestAnimationFrame(() => moreTriggerElement?.focus());
	}

	const reminder = reminders ? eventReminder(reminders, master) : undefined;
	const reminderKind = master.isAllDay ? "allDay" : "timed";

	async function handleReminder(value: string) {
		if (!reminders || !reminder) return;
		setBusyAction("reminder");
		setActionError(undefined);

		try {
			if (value === INHERIT) {
				await reminders.onChange(master.id, null);
				onNotice("Reminder follows its inherited setting again.");
				return;
			}

			const next =
				reminderKind === "timed"
					? withTimed(reminder.rule, value)
					: withAllDay(reminder.rule, value);
			// Only store an override where it actually differs. Writing one for
			// every glance would make each event an exception, and a later change
			// to the inherited rule would then reach none of them.
			const base = inheritedEventReminder(reminders, master).rule;
			await reminders.onChange(master.id, sameRule(next, base) ? null : next);
			onNotice("Reminder saved.");
		} catch (error) {
			setActionError(getEventMutationError(error, "update", homeCalendar));
		} finally {
			setBusyAction(undefined);
		}
	}

	async function handleAnswer(next: AttendanceChoice) {
		setBusyAction("attendance");
		setActionError(undefined);

		try {
			setAttendees(
				await onSetAttendance({
					calendarId: homeCalendar?.id,
					eventId: master.id,
					status: next,
				}),
			);
			onNotice(next === "none" ? "Answer cleared." : "Answer saved.");
		} catch (error) {
			setActionError(getEventMutationError(error, "update", homeCalendar));
		} finally {
			setBusyAction(undefined);
		}
	}

	const orderedCalendars = [...eventCalendars].sort(
		(left, right) => Number(right.id === homeCalendarId) - Number(left.id === homeCalendarId),
	);
	const answerText = answerLabel(mine) ?? "Answer";
	const showAnswer = Boolean(master.hasAttendees && attendees);
	const noteText = (text: string) =>
		noteParts(text).map((part, index) =>
			part.href ? (
				<a
					aria-label={`Open ${part.href}`}
					className={detailLinkClassName}
					href={part.href}
					key={`${part.href}-${index}`}
					rel="noreferrer"
					target="_blank"
					title={part.href}
				>
					{part.text}
				</a>
			) : (
				part.text
			),
		);
	const longNotes = (event.description?.length ?? 0) > 240;

	return (
		<>
			<Popover open={open} onOpenChange={handleOpenChange} onRequestClose={after => requestExit(after)}>
				<PopoverTrigger
					asChild
					onClick={(clickEvent) => {
						setTriggerElement(clickEvent.currentTarget);
					}}
				>
					{children}
				</PopoverTrigger>
				<PopoverContent
					data-event-preview=""
					aria-labelledby={titleId}
					accessibleTitle={editing ? "Edit event" : event.title}
					persistent={editing}
					onFocusOutside={focusEvent => focusEvent.preventDefault()}
					onEscapeKeyDown={(escapeEvent) => {
						if (!targetAction) return;
						escapeEvent.preventDefault();
						hideTargetCalendars();
					}}
				>
					{editing && !editable ? (
						<>
							<PanelHeader accent={accentColor}>
								<PanelTitle id={titleId}>This event is read-only</PanelTitle>
								<InspectorHeaderActions>
									<Button aria-label="Close event editor" title="Close event editor" size="icon-compact" variant="ghost" onClick={() => requestExit(() => {})}>
										<X aria-hidden="true" strokeWidth={1.6} />
									</Button>
								</InspectorHeaderActions>
							</PanelHeader>
							<Empty title="Your draft is kept" description="It stays here while this editor is open." />
						</>
					) : editing ? (
						<>
							<PanelHeader accent={accentColor}>
								<PanelTitle id={titleId}>{master.recurrence ? "Edit series" : "Edit event"}</PanelTitle>
								<InspectorHeaderActions>
									<div ref={setExpandActionContainer} />
									<Button
										aria-label="Close event editor"
										title="Close event editor"
										size="icon-compact"
										variant="ghost"
										onClick={() => requestExit(() => {}, false)}
									>
										<X aria-hidden="true" strokeWidth={1.6} />
									</Button>
								</InspectorHeaderActions>
							</PanelHeader>
							<EventEditorForm
								rdateMaster={homeCalendar?.provider === "caldav" && !liveMaster.seriesID ? liveMaster : undefined}
								key={draft?.privacyRevision ?? "initial"}
								onValuesChange={(values) => setDraft(current => current ? { ...current, values, ownedFields: rememberPrivateEditorChanges(current.values ?? eventFormValues(master.recurrence && onRestoreEvent ? occurrence : master), values, current.ownedFields) } : current)}
								calendarLocked
								calendars={calendars}
								localAccountName={user.name}
								layout="panel"
								expandActionContainer={expandActionContainer}
								initialValues={draft?.values ?? eventFormValues(
									master.recurrence && onRestoreEvent ? occurrence : master,
								)}
								onCancel={() => requestExit(() => {}, false)}
								onExpand={
									onOpenFullEditor
										? (values) => {
												// The full editor explicitly edits the master. Carry the
												// draft's changes, not the occurrence's anchor dates.
												const expandedDraft =
													master.recurrence && onRestoreEvent
														? eventFormValues(
																seriesEditWrites({
																	edited: updateEventFromForm(occurrence, values),
																	master,
																	occurrence,
																	scope: "series",
																}).updates[0]!,
															)
														: values;
												handleOpenChange(false);
												onOpenFullEditor({ ...expandedDraft, privateDraftFields: draft?.ownedFields }, master);
											}
										: undefined
								}
								onError={(error) =>
									getEventMutationError(error, "update", homeCalendar)
								}
								onSubmit={handleUpdate}
								submitLabel="Save"
								submitRef={setEditSubmitElement}
								timeFormat={timeFormat}
								weekStartsOn={weekStartsOn}
							/>
						</>
					) : (
						<>
							<PanelHeader accent={accentColor}>
								<PanelTitle id={titleId}>{event.title}</PanelTitle>
								<InspectorHeaderActions>
									<PopoverClose asChild>
										<Button aria-label="Close event details" title="Close event details" size="icon-compact" variant="ghost">
											<X aria-hidden="true" strokeWidth={1.6} />
										</Button>
									</PopoverClose>
								</InspectorHeaderActions>
							</PanelHeader>

							<PanelBody>
								<DetailList>
									<DetailRow icon={<Clock3 strokeWidth={1.5} />} label="When">
										<span className="flex flex-wrap items-center gap-x-2">
											<span>{getEventDateLabel(event)}</span>
											<span aria-hidden="true" className="text-muted-foreground">·</span>
											<span>{getEventRangeLabel(event, timeFormat)}</span>
											{!event.isAllDay ? <span className="text-muted-foreground">{getDurationLabel(event)}</span> : null}
											{event.recurrence ? (
												<span className="inline-flex items-center gap-1 text-foreground-secondary">
													<Repeat2 aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
													Recurring
												</span>
											) : null}
										</span>
									</DetailRow>
									<DetailRow
										icon={homeCalendar?.provider
											? <AccountMark flavor={providerFlavor(homeCalendar)} size="compact" color={accentColor} />
											: <CalendarDot color={accentColor} />}
										label="Calendars"
									>
										<ul aria-label="Calendars" className="flex flex-wrap gap-x-3 gap-y-1">
											{orderedCalendars.length > 0 ? (
												orderedCalendars.map((item) => {
													const home = item.id === homeCalendarId;
													return (
														<li
															aria-label={home ? `${item.name} · Home calendar` : undefined}
															className={cn("inline-flex min-w-0 items-center gap-1.5", home ? "font-medium text-foreground" : "text-foreground-secondary")}
															key={item.id}
															title={home ? "Home calendar" : undefined}
														>
															{home ? null : <CalendarDot color={item.color} />}
															{item.name}
														</li>
													);
												})
											) : (
												<li>Calendar</li>
											)}
										</ul>
									</DetailRow>
									{event.location ? (
										<DetailRow icon={<MapPin strokeWidth={1.5} />} label="Location">
											{event.location}
										</DetailRow>
									) : null}
									{event.url ? (
										<DetailRow icon={<Link2 strokeWidth={1.5} />} label="Link">
											<ExternalEventLink url={event.url} />
										</DetailRow>
									) : null}
								</DetailList>

								{master.hasAttendees ? (
									<section aria-busy={!attendees} aria-labelledby={guestsTitleId}>
										{attendees ? (
											<Disclosure
												density="compact"
												icon={<UsersRound aria-hidden="true" strokeWidth={1.5} />}
												label={<span id={guestsTitleId}>{`${homeCalendar?.provider ? "Musubi attendees" : "Attendees"} · ${going.length}`}</span>}
												value={going.length ? <AvatarStackPreview limit={2} people={going} /> : undefined}
												open={attendeesOpen}
												onOpenChange={setAttendeesOpen}
											>
												{attendees.length ? (
													<ul className="grid gap-3 pl-7">
														{groupAttendees(attendees).map((group) => (
															<li className="grid gap-2" key={group.status}>
																<p className="text-11 font-medium tracking-label text-muted-foreground uppercase">{group.title}</p>
																<ul className="grid max-h-48 gap-2 overflow-y-auto overscroll-contain">
																	{group.items.map((item) => (
																		<li className="flex min-w-0 items-center gap-3" key={item.id}>
																			<Avatar image={item.image} name={item.name} size="compact" />
																			<span className="truncate text-13 text-foreground">{item.name}</span>
																		</li>
																	))}
																</ul>
															</li>
														))}
													</ul>
												) : <p className="pl-7 text-13 text-muted-foreground">Be the first to answer.</p>}
											</Disclosure>
										) : (
											<DetailList>
												<DetailRow icon={<UsersRound strokeWidth={1.5} />} label="Attendees">
													<h3 className="sr-only" id={guestsTitleId}>Attendees</h3>
													<span className="text-muted-foreground" role="status">Loading guests…</span>
												</DetailRow>
											</DetailList>
										)}
									</section>
								) : null}

								{event.description ? (
									<section aria-labelledby={notesTitleId} className="flex gap-2">
										<h3 className="sr-only" id={notesTitleId}>Notes</h3>
										<FileText aria-hidden="true" className="mt-0.5 w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
										<div className="grid min-w-0 flex-1 justify-items-start gap-1">
											<p className="text-13 leading-normal whitespace-pre-wrap wrap-anywhere text-foreground-secondary">
												{longNotes && !notesExpanded ? `${event.description.slice(0, 220)}…` : noteText(event.description)}
											</p>
											{longNotes ? (
												<Button aria-expanded={notesExpanded} variant="link" onClick={() => setNotesExpanded(value => !value)}>
													{notesExpanded ? "Show less" : "Read full notes"}
												</Button>
											) : null}
										</div>
									</section>
								) : null}

								{homeCalendar?.provider ? <ProviderEventDetails presentation="panel" providerFlavor={providerFlavor(homeCalendar)} event={event} seriesMaster={!event.seriesID && liveMaster.recurrence ? liveMaster : undefined} revision={event.seriesID ? event.revision : liveMaster.revision} occurrence={!!event.seriesID} eventId={event.seriesID ? event.id : master.id} series={!event.seriesID && !!master.recurrence} userId={user.id} connectionId={homeConnectionId} onRespond={observation => { setOpen(false); setProviderRsvpEditor({ context: providerReminderContext, occurrence: !!event.seriesID, eventId: event.seriesID ? event.id : master.id, observation }); }} onEditReminders={observation => { setOpen(false); setProviderReminderEditor({ context: providerReminderContext, occurrence: !!event.seriesID, eventId: event.seriesID ? event.id : master.id, observation }); }} /> : null}

								{reminder ? (
									<section aria-labelledby={reminderTitleId} className="flex min-h-8 items-center gap-2">
										<BellRing aria-hidden="true" className="w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
										<h3 className="min-w-0 flex-1 text-13 font-normal text-foreground" id={reminderTitleId}>
											{homeCalendar?.provider ? "Musubi reminder" : "Remind me"}
										</h3>
										<Menu>
											<MenuTrigger asChild>
												<Button loading={busyAction === "reminder"} size="compact" variant="secondary">
													{reminderLabel(reminder, reminderKind)}
													<ChevronDown aria-hidden="true" className="size-3.5" />
												</Button>
											</MenuTrigger>
											<MenuContent align="end" label="Reminder">
												{optionsFor(reminder.rule, reminderKind).map((option) => {
													const current =
														reminderKind === "timed"
															? timedValue(reminder.rule)
															: allDayValue(reminder.rule);
													return (
														<MenuItem
															icon={
																!reminder.inherited && current === option.value ? (
																	<Check aria-hidden="true" size={15} />
																) : undefined
															}
															key={option.value}
															onSelect={() => void handleReminder(option.value)}
														>
															{option.label}
														</MenuItem>
													);
												})}
												{reminder.inherited ? null : (
													<MenuItem onSelect={() => void handleReminder(INHERIT)}>
														Use inherited setting
													</MenuItem>
												)}
											</MenuContent>
										</Menu>
									</section>
								) : null}

								{targetAction && targetCalendars.length > 0 ? (
									<section aria-labelledby={targetActionTitleId} className="grid gap-3">
										<div className="flex items-center gap-1">
											<Button
												aria-label="Back to add options"
												title="Back to add options"
												disabled={Boolean(busyAction)}
												size="icon-compact"
												variant="ghost"
												onClick={hideTargetCalendars}
											>
												<ArrowLeft aria-hidden="true" strokeWidth={1.6} />
											</Button>
											<h3 className="font-serif text-15 font-normal text-foreground" id={targetActionTitleId}>
												{targetAction === "link" ? "Link to a calendar" : "Make an independent copy"}
											</h3>
											<HelpTooltip label={targetAction === "link" ? "About linking" : "About copies"}>
												{targetAction === "link"
													? "It stays one event, so future changes appear in every linked calendar."
													: "The copy can be changed later without affecting this event."}
											</HelpTooltip>
										</div>
										<ItemGroup ref={targetListRef}>
											{targetCalendars.map((item) => {
												const pending =
													pendingTargetId === item.id && busyAction === targetAction;

												return (
													<RowAction
														aria-label={
															targetAction === "link"
																? `Link to ${item.name}`
																: `Make copy in ${item.name}`
														}
														aria-busy={pending || undefined}
														detail={targetCalendarDetail(item)}
														disabled={Boolean(busyAction)}
														icon={<CalendarDot color={item.color} />}
														key={item.id}
														label={item.name}
														showChevron={false}
														value={
															pending
																? targetAction === "link"
																	? "Linking…"
																	: "Copying…"
																: undefined
														}
														onClick={() => void handleTargetAction(targetAction, item.id)}
													/>
												);
											})}
										</ItemGroup>
										{actionError ? (
											<InlineError requestId={actionError.requestId}>
												{actionError.message}
											</InlineError>
										) : null}
									</section>
								) : null}

								{actionError && !targetAction ? (
									<InlineError requestId={actionError.requestId}>
										{actionError.message}
									</InlineError>
								) : null}
							</PanelBody>

							{!targetAction ? (
								<PanelFooter aria-label="Event actions">
									<Menu>
										<MenuTrigger asChild>
											<Button
												aria-label="More event actions"
												title="More actions"
												ref={setMoreTriggerElement}
												size="icon"
												variant="ghost"
											>
												<Ellipsis aria-hidden="true" strokeWidth={1.6} />
											</Button>
										</MenuTrigger>
										<MenuContent align="start" label="Event actions">
											{canAddToCalendar ? (
												<>
													<MenuItem icon={<Link2 size={16} strokeWidth={1.6} />} onSelect={() => showTargetCalendars("link")}>
														Link to another calendar
													</MenuItem>
													<MenuItem icon={<CopyPlus size={16} strokeWidth={1.6} />} onSelect={() => showTargetCalendars("fork")}>
														Make a copy
													</MenuItem>
													<MenuSeparator />
												</>
											) : null}
											<MenuItem icon={<RefreshCw size={16} strokeWidth={1.6} />} onSelect={() => { setOpen(false); setDeliveryTarget({ context: providerReminderContext, eventId: event.seriesID ? event.id : liveMaster.id }); }}>
												{event.seriesID ? "Occurrence delivery details" : "Delivery details"}
											</MenuItem>
											{event.seriesID && liveMaster.id !== event.id ? (
												<MenuItem icon={<RefreshCw size={16} strokeWidth={1.6} />} onSelect={() => { setOpen(false); setDeliveryTarget({ context: providerReminderContext, eventId: liveMaster.id }); }}>
													Series delivery details
												</MenuItem>
											) : null}
											{removable ? (
												<>
													<MenuSeparator />
													<MenuItem icon={<Trash2 size={16} strokeWidth={1.6} />} tone="destructive" onSelect={beginDelete}>
														Delete
													</MenuItem>
												</>
											) : null}
										</MenuContent>
									</Menu>
									{!editable && !removable && !canAddToCalendar ? (
										<p className="min-w-0 flex-1 text-12 leading-snug text-muted-foreground">
											{homeCalendar?.provider === "microsoft"
												? `${providerDisplayName(homeCalendar)} reports this calendar as read-only.`
												: "View only"}
										</p>
									) : <span className="flex-1" />}
									{showAnswer ? (
										<Menu>
											<MenuTrigger asChild>
												<Button
													title={homeCalendar?.provider ? "Your Musubi answer" : "Your answer"}
													loading={busyAction === "attendance"}
													variant={editable ? "secondary" : "primary"}
												>
													{answerText}
													<ChevronDown aria-hidden="true" className="size-3.5" />
												</Button>
											</MenuTrigger>
											<MenuContent align="end" label="Your answer">
												{ATTENDANCE_CHOICES.map((choice) => (
													<MenuItem
														icon={
															mine === choice.value ? (
																<Check aria-hidden="true" size={15} />
															) : undefined
														}
														key={choice.value}
														onSelect={() => void handleAnswer(choice.value)}
													>
														{choice.label}
													</MenuItem>
												))}
												{mine ? (
													<>
														<MenuSeparator />
														<MenuItem onSelect={() => void handleAnswer("none")}>
															Clear answer
														</MenuItem>
													</>
												) : null}
											</MenuContent>
										</Menu>
									) : null}
									{editable ? (
										<Button
											ref={editButtonRef}
											onClick={() => {
												setDraft({
													event: structuredClone(event),
													master: structuredClone(liveMaster),
												});
												setEditing(true);
											}}
										>
											<Pencil aria-hidden="true" strokeWidth={1.6} />
											Edit
										</Button>
									) : null}
								</PanelFooter>
							) : null}
						</>
					)}
				</PopoverContent>
			</Popover>
			<ConfirmationDialog elevated open={!!discardAction} onOpenChange={value => { if (!value) setDiscardAction(undefined); }} returnFocus={editSubmitElement} title="Discard unsaved changes?" description="The original event stays unchanged." closeLabel="Keep editing" cancelLabel="Keep editing" confirmLabel="Discard changes" onConfirm={() => { const finish = discardAction; setDiscardAction(undefined); finish?.(); }} />

			{providerRsvpEditor?.context === providerReminderContext ? <ProviderRsvpEditor
				occurrence={providerRsvpEditor.occurrence} eventId={providerRsvpEditor.eventId} connectionId={homeConnectionId}
				observation={providerRsvpEditor.observation} returnFocus={open ? moreTriggerElement : triggerElement} onClose={() => setProviderRsvpEditor(undefined)} /> : null}
			{providerReminderEditor?.context === providerReminderContext ? <ProviderReminderEditor
				key={providerReminderEditor.context} occurrence={providerReminderEditor.occurrence} eventId={providerReminderEditor.eventId} connectionId={homeConnectionId}
				observation={providerReminderEditor.observation} returnFocus={open ? moreTriggerElement : triggerElement} onClose={() => setProviderReminderEditor(undefined)} /> : null}

			{deliveryTarget?.context === providerReminderContext ? <EventDeliveryDialog key={`${user.id}:${homeConnectionId ?? "home"}:${deliveryTarget.eventId}`}
				eventId={deliveryTarget.eventId} userId={user.id} connectionId={homeConnectionId}
				returnFocus={open ? moreTriggerElement : triggerElement} onClose={() => setDeliveryTarget(undefined)} /> : null}

			{pendingEdit ? (
				<RecurrenceScopeDialog
					busyScope={pendingEditScope}
					error={actionError}
					onResolve={(scope) => {
						if (scope) {
							void applyScopedEdit(pendingEdit, scope);
						} else {
							setPendingEdit(undefined);
						}
					}}
					returnFocus={editSubmitElement}
					/* Only when the edit actually moved it: otherwise the dialog would
					   announce a time change that never happened. */
					timeLabel={
						pendingEdit.start.getTime() === event.start.getTime() &&
						pendingEdit.end.getTime() === event.end.getTime()
							? undefined
							: getEventRangeLabel(pendingEdit, timeFormat)
					}
					title={pendingEdit.title}
				/>
			) : null}

			{deletePrompt === "scope" ? (
				<RecurrenceScopeDialog
					action="delete"
					allowedScopes={removeCalendar?.provider === "microsoft" ? ["occurrence", "series"] : undefined}
					busyScope={pendingDeleteScope}
					consequence={deleteConsequence}
					error={actionError}
					onResolve={(scope) => {
						if (scope) {
							void handleDelete(scope);
						} else {
							setDeletePrompt(undefined);
						}
					}}
					returnFocus={open ? moreTriggerElement : triggerElement}
					title={event.title}
				/>
			) : null}

			<ConfirmationDialog
				closeLabel="Close delete event dialog"
				confirmLabel="Delete"
				description={`“${event.title}” will be removed. ${deleteConsequence}`}
				loading={busyAction === "delete"}
				onConfirm={() => void handleDelete()}
				onOpenChange={(nextOpen) => nextOpen || setDeletePrompt(undefined)}
				open={deletePrompt === "confirm"}
				returnFocus={open ? moreTriggerElement : triggerElement}
				title="Delete event"
			>
				{actionError ? (
					<InlineError requestId={actionError.requestId}>
						{actionError.message}
					</InlineError>
				) : null}
			</ConfirmationDialog>
		</>
	);
}

function ExternalEventLink({ url }: { url: string }) {
	return (
		<a
			aria-label={`Open event link, ${shortUrlLabel(url)}`}
			className={detailLinkClassName}
			href={url}
			rel="noreferrer"
			target="_blank"
		>
			{shortUrlLabel(url)}
		</a>
	);
}

function getDurationLabel(event: Event): string {
	const totalMinutes = Math.max(
		1,
		Math.round((event.end.getTime() - event.start.getTime()) / 60_000),
	);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (!hours) return `${minutes} min`;
	if (!minutes) return `${hours} ${hours === 1 ? "hr" : "hrs"}`;
	return `${hours} ${hours === 1 ? "hr" : "hrs"} ${minutes} min`;
}

function targetCalendarDetail(calendar: Calendar) {
	if (calendar.provider) return providerDisplayName(calendar);
	if (calendar.isDefault) return "Personal calendar";
	return calendar.role === "owner" ? "Your calendar" : "Shared calendar";
}
