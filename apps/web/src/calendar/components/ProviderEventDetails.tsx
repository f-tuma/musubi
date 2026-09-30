import { OutlookMoveDialog } from "./OutlookMoveDialog";
import { OutlookCancellationDialog } from "./OutlookCancellationDialog";
import { UsersRound } from "lucide-react";
import { ProviderOrganizerEditor } from "./ProviderOrganizerEditor";
import { ProviderRsvpEditor } from "./ProviderRsvpEditor";
import type { Event, ProviderEventStateResponse } from "@musubi/types";
import { assertCaldavSeriesAlarmObservation, canManageProviderOrganizer, outlookSeriesOrganizerObservation, providerEventDetails } from "@musubi/calendar";
import { useEffect, useId, useRef, useState } from "react";
import { getProviderEventState } from "~/api/resources";
import { getServerOrigin } from "~/api/query-keys";
import { cn } from "~/lib/utils";
import { Avatar, AvatarStackPreview } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Disclosure } from "~/components/ui/disclosure";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Row } from "~/components/ui/row";
import { SectionLabel } from "~/components/ui/section-label";
import { ProviderReminderEditor } from "./ProviderReminderEditor";
import { AccountMark } from "./ProviderIcon";

function providerResponseStateLabel(response: string) {
  switch (response.toLowerCase()) {
    case "accepted": return "Accepted";
    case "declined": return "Declined";
    case "tentative":
    case "tentativelyaccepted": return "Tentative";
    case "needsaction":
    case "needs-action":
    case "notresponded": return "Awaiting response";
    // Graph can also report `none` for the organizer, so do not imply a pending RSVP.
    case "none": return "Not reported";
    default: return response;
  }
}

function providerRoleLabel(role: string | null) {
  switch (role?.toLowerCase()) {
    case "required":
    case "req-participant": return "Required";
    case "optional":
    case "opt-participant": return "Optional";
    case "chair": return "Chair";
    default: return role;
  }
}

const PROVIDER_METADATA_LABELS: Record<string, Record<string, string>> = {
  Availability: { opaque: "Busy", transparent: "Free", workingelsewhere: "Working elsewhere" },
  Privacy: { default: "Default", public: "Public", private: "Private", confidential: "Confidential", normal: "Normal" },
  "Provider status": { confirmed: "Confirmed", tentative: "Tentative", cancelled: "Cancelled", canceled: "Cancelled", active: "Active" },
  "Provider event type": { singleinstance: "Single event", seriesmaster: "Recurring series", occurrence: "Occurrence", exception: "Exception" },
};

function readableProviderPerson(person: { name: string | null; address: string | null }) {
  const address = person.address?.replace(/^mailto:/i, "") ?? null;
  const name = person.name?.replace(/^mailto:/i, "") || address || "Unnamed participant";
  return { name, address: address === name ? null : address };
}

type Props = { providerFlavor?: string | null; presentation?: "default" | "panel"; event?: Event; seriesMaster?: Event; eventId: string; revision?: number; userId: string; connectionId?: string; series?: boolean; occurrence?: boolean; onEditReminders?: (observation: ProviderEventStateResponse) => void; onRespond?: (observation: ProviderEventStateResponse) => void };
export function ProviderEventDetails(props: Props) {
  return <ProviderEventDetailsSession key={JSON.stringify([getServerOrigin(), props.eventId, props.userId, props.connectionId, props.series, props.occurrence])} {...props} />;
}
function ProviderEventDetailsSession(props: Props) {
  const [moving, setMoving] = useState(false);
  const moveTrigger = useRef<HTMLButtonElement>(null);
  const revision = JSON.stringify([props.revision, props.seriesMaster?.id, props.seriesMaster?.revision]);
  return <>
    <ProviderEventDetailsBody key={revision} {...props} moveTrigger={moveTrigger} onMove={() => setMoving(true)} />
    {moving ? <OutlookMoveDialog eventID={props.eventId} revision={revision} returnFocus={moveTrigger} onClose={() => setMoving(false)} /> : null}
  </>;
}
function ProviderEventDetailsBody({ providerFlavor, presentation = "default", event: sourceEvent, seriesMaster, eventId, userId, connectionId, series = false, occurrence = false, onEditReminders, onRespond, moveTrigger, onMove }: Props & { moveTrigger: React.RefObject<HTMLButtonElement | null>; onMove: () => void }) {
  const titleId = useId();
  const key = JSON.stringify([eventId, userId, connectionId]);
  const [result, setResult] = useState<({ key: string; failed?: boolean } & Partial<ProviderEventStateResponse>)>();
  const [editor, setEditor] = useState<{ kind: "reminders" | "rsvp" | "organizer" | "outlook-series" | "outlook-cancel"; trigger: HTMLElement; observation: ProviderEventStateResponse }>();
  const readSequence = useRef(0);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const active = useRef(true);
  const refreshing = useRef(false);
  const editorRead = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; editorRead.current?.abort(); }; }, []);
  async function openEditor(trigger: HTMLElement, kind: "reminders" | "rsvp" | "organizer" | "outlook-series" | "outlook-cancel" = "reminders", seriesAction = false) {
    if (refreshing.current) return;
    refreshing.current = true; setOpening(true); setOpenError("");
    ++readSequence.current;
    editorRead.current = new AbortController();
    try {
      let observation = await getProviderEventState(seriesAction && seriesMaster ? seriesMaster.id : eventId, editorRead.current.signal, connectionId);
      if (!active.current) return;
      if (seriesAction) {
        if (!seriesMaster) throw new Error("Missing stored series master.");
        assertCaldavSeriesAlarmObservation(seriesMaster, observation);
      } else if (kind === "reminders" && observation.reminderEdit?.provider === "caldav" && observation.reminderEdit.scope === "series") throw new Error("Choose Series alarm settings explicitly.");
      if (kind === "organizer" && (sourceEvent?.id !== eventId || !canManageProviderOrganizer(sourceEvent, observation))) throw new Error("The stored meeting observation changed.");
      setResult({ key, ...observation });
      if (kind === "outlook-series") {
        const scoped = sourceEvent?.id === eventId ? outlookSeriesOrganizerObservation(sourceEvent, observation) : undefined;
        if (!scoped) throw new Error("The stored series observation changed.");
        observation = scoped; kind = "organizer";
      }
      if ((kind === "outlook-cancel" ? observation.outlookCancellation : kind === "organizer" ? observation.organizerEdit : kind === "reminders" ? observation.reminderEdit : observation.rsvpEdit) && observation.state && observation.version) {
        const handoff = kind === "organizer" || kind === "outlook-cancel" ? undefined : kind === "reminders" ? onEditReminders : onRespond;
        if (handoff) handoff(observation); else setEditor({ kind, trigger, observation });
      } else setOpenError("This provider action is unavailable in the refreshed state.");
    } catch { if (active.current) setOpenError("Could not refresh provider details. Retry to load the current state."); }
    finally { refreshing.current = false; if (active.current) setOpening(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const sequence = ++readSequence.current;
    getProviderEventState(eventId, controller.signal, connectionId).then(observation => {
      if (active && sequence === readSequence.current) setResult({ key, ...observation });
    }).catch(() => { if (active && sequence === readSequence.current) setResult({ key, failed: true }); });
    return () => { active = false; controller.abort(); };
  }, [eventId, connectionId, key]);
  const current = result?.key === key ? result : undefined;
  if (current?.state === null) return null;
  const details = current?.state ? providerEventDetails(current.state) : undefined;
  const participants = current?.state?.attendees.map((person, index) => ({
    ...person,
    id: `${index}:${person.address ?? person.name ?? "participant"}`,
    ...readableProviderPerson(person),
  })) ?? [];
  const knownApple = current?.state?.provider === "caldav" && providerFlavor === "apple";
  const displayProvider = presentation === "panel" && knownApple ? "Apple Calendar" : details?.provider;
  const title = details ? `${displayProvider} details` : "Provider details";
  function metadataValue(row: { label: string; value: string }) {
    if (presentation !== "panel") return row.value;
    if (row.label === "Your provider response") return providerResponseStateLabel(row.value);
    if (row.label === "Organizer" && current?.state?.organizer) {
      const person = readableProviderPerson(current.state.organizer);
      return [person.name, person.address].filter(Boolean).join(" · ");
    }
    const labels = PROVIDER_METADATA_LABELS[row.label];
    const value = row.value.toLowerCase();
    return labels && Object.hasOwn(labels, value) ? labels[value] : row.value;
  }
  const settingsHelp = details ? <HelpTooltip label={`About ${displayProvider} settings`}>
    {series ? "These settings describe the series, not an individual occurrence. " : occurrence ? "These settings describe this occurrence. " : ""}
    Imported provider settings. {current?.reminderEdit || current?.rsvpEdit ? "Available actions are shown below." : `Change these in ${displayProvider}.`}
    {" "}Provider notifications and Musubi reminders are separate. Both apps may notify you.
  </HelpTooltip> : null;
  const settingsLabel = series ? "Series settings" : occurrence ? "Occurrence settings" : "Imported settings";
  const metadata = !details ? null : presentation === "panel" ? <div className="grid gap-2 pl-7">
    <p className="flex items-center gap-1 text-12 text-muted-foreground">{settingsLabel}{settingsHelp}</p>
    <dl className="grid gap-1.5 text-13 leading-snug">
      {details.rows.filter(row => row.label !== "Provider participants").map(row => <div className="flex min-w-0 gap-3" key={row.label}>
        <dt className="w-24 flex-none text-muted-foreground">{row.label}</dt>
        <dd className="min-w-0 flex-1 wrap-anywhere text-foreground">{metadataValue(row)}</dd>
      </div>)}
    </dl>
  </div> : <p className="text-13 leading-normal whitespace-pre-wrap wrap-anywhere text-foreground-secondary">
    {settingsLabel}
    {settingsHelp}{"\n\n"}
    {details.rows.map(row => <span key={row.label}><strong className="font-medium text-foreground">{row.label}: </strong>{metadataValue(row)}{"\n"}</span>)}
  </p>;
  const actionButton = "w-fit";
  const actions = <>
    {current?.outlookOccurrenceMove && sourceEvent?.id === eventId && !connectionId ? <Button className={actionButton} size="compact" variant="secondary" ref={moveTrigger} onClick={onMove}>Move selected occurrences</Button> : null}
    {current?.outlookCancellation && sourceEvent?.id === eventId && !connectionId ? <Button className={actionButton} size="compact" variant="secondary" loading={opening} onClick={event => void openEditor(event.currentTarget, "outlook-cancel")}>Cancel Outlook meeting</Button> : null}
    {current?.reminderEdit && current.state && current.version && !series && !(current.reminderEdit.provider === "caldav" && current.reminderEdit.scope === "series") ? <>
      <Button className={actionButton} size="compact" variant="secondary" loading={opening} onClick={event => void openEditor(event.currentTarget)}>{current?.reminderEdit?.provider === "caldav" ? "Edit CalDAV event alarms" : occurrence ? "Edit reminders for this occurrence" : "Edit Google reminders"}</Button>
    </> : null}
    {seriesMaster && current?.reminderEdit?.provider === "caldav" && current.reminderEdit.scope === "series" && current.state && current.version ? <Button className={actionButton} size="compact" variant="secondary" loading={opening} onClick={event => void openEditor(event.currentTarget, "reminders", true)}>Series alarm settings</Button> : null}
    {current?.rsvpEdit && current.state && current.version && !series ? <Button className={actionButton} size="compact" variant="secondary" loading={opening} onClick={event => void openEditor(event.currentTarget, "rsvp")}>{current.rsvpEdit.provider === "microsoft" && current.rsvpEdit.series ? "Respond in Outlook" : occurrence || current.rsvpEdit.scope === "occurrence" ? "Respond to this occurrence" : current.rsvpEdit.provider === "microsoft" ? "Respond in Outlook" : current.rsvpEdit.provider === "caldav" ? "Respond in calendar" : "Respond in Google"}</Button> : null}
    {outlookSeriesOrganizerObservation(sourceEvent, current) && sourceEvent?.id === eventId && !connectionId ? <Button className={actionButton} size="compact" variant="secondary" loading={opening} onClick={event => void openEditor(event.currentTarget, "outlook-series")}>Edit series</Button> : null}
    {canManageProviderOrganizer(sourceEvent, current) && sourceEvent?.id === eventId && !connectionId && !series ? <Button className={actionButton} size="compact" variant="secondary" loading={opening} onClick={event => void openEditor(event.currentTarget, "organizer")}>{current?.organizerEdit?.scope === "occurrence" ? "Manage this occurrence" : `Manage ${current?.organizerEdit?.provider === "caldav" ? "CalDAV" : current?.organizerEdit?.provider === "microsoft" ? "Outlook" : "Google"} meeting`}</Button> : null}
  </>;
  const status = <p className={cn("text-13 text-muted-foreground", presentation === "panel" && "pl-7")} role="status">{current?.failed ? "Provider details could not be loaded. Reopen this event to retry." : "Loading provider details…"}</p>;
  return <section aria-labelledby={titleId} className="grid min-w-0 gap-2">
    {presentation === "panel" && details ? <Disclosure
      density="compact"
      icon={<AccountMark flavor={knownApple ? "apple" : current?.state?.provider ?? null} size="compact" />}
      label={<span id={titleId}>{title}</span>}
    >{metadata}</Disclosure> : <>
      <SectionLabel id={titleId} level={3}>{title}</SectionLabel>
      {metadata ?? status}
    </>}
    {presentation === "panel" && details && participants.length > 0 ? <Disclosure
      density="compact"
      label={`${displayProvider} participants`}
      icon={<UsersRound aria-hidden="true" strokeWidth={1.5} />}
      value={<AvatarStackPreview limit={2} people={participants} />}
    >
      <ul className="grid pl-4" aria-label={`${displayProvider} participants`}>
        {participants.map(person => <li key={person.id}>
          <Row
            size="compact"
            icon={<Avatar name={person.name} size="compact" />}
            label={person.name}
            detail={[person.address, providerRoleLabel(person.role), person.response ? providerResponseStateLabel(person.response) : null].filter(Boolean).join(" · ")}
          />
        </li>)}
      </ul>
      {!current?.state?.attendeesComplete ? <p className="pl-7 text-12 text-muted-foreground">Participant list may be incomplete.</p> : null}
    </Disclosure> : null}
    {openError ? <InlineError>{openError}</InlineError> : null}
    <div className={cn("flex flex-wrap gap-2 empty:hidden", presentation === "panel" && "pl-7")}>{actions}</div>
    {editor?.kind === "outlook-cancel" && sourceEvent ? <OutlookCancellationDialog event={sourceEvent} observation={editor.observation} returnFocus={editor.trigger} onClose={() => setEditor(undefined)} /> : null}
    {editor?.kind === "organizer" && sourceEvent && editor.observation.organizerEdit ? <ProviderOrganizerEditor event={sourceEvent} color={sourceEvent.color} calendarID={editor.observation.organizerEdit.calendarID} observation={editor.observation} returnFocus={editor.trigger} onClose={() => setEditor(undefined)} /> : null}
    {editor?.kind === "reminders" ? <ProviderReminderEditor occurrence={occurrence} eventId={eventId} connectionId={connectionId} observation={editor.observation} returnFocus={editor.trigger} onClose={() => setEditor(undefined)} /> : null}
    {editor?.kind === "rsvp" ? <ProviderRsvpEditor occurrence={occurrence} eventId={eventId} connectionId={connectionId} observation={editor.observation} returnFocus={editor.trigger} onClose={() => setEditor(undefined)} /> : null}
  </section>;
}
