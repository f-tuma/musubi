import { TimeZonePicker } from "./TimeZonePicker";
import { getServerOrigin } from "~/api/query-keys";
import { useEffect, useRef, useState } from "react";
import { CalendarPlus } from "lucide-react";
import type {
  Event,
  ProviderEventStateResponse,
  ProviderOrganizerRequest,
} from "@musubi/types";
import {
  organizerDraft,
  organizerRequest,
  organizerNotificationNotice,
  type OrganizerDraft,
} from "@musubi/calendar";
import { editProviderOrganizer, getOrganizerCalendar } from "~/api/resources";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { focusDialogBody } from "./dialog-focus";
export function ProviderOrganizerCreateAction(props: {
  calendarID: string;
  color: string;
  connectionId?: string;
  onCreate?: (target: HTMLElement) => void;
}) {
  return (
    <OrganizerCreateActionBody
      key={JSON.stringify([
        props.calendarID,
        props.connectionId,
        getServerOrigin(),
      ])}
      {...props}
    />
  );
}
function OrganizerCreateActionBody({
  calendarID,
  color,
  connectionId,
  onCreate,
}: {
  calendarID: string;
  color: string;
  connectionId?: string;
  onCreate?: (target: HTMLElement) => void;
}) {
  const [organizerAddresses, setOrganizerAddresses] = useState<string[] | undefined>();
  const [available, setAvailable] = useState<"google" | "caldav" | "microsoft" | null>(null),
    [trigger, setTrigger] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getOrganizerCalendar(calendarID, controller.signal, connectionId)
      .then((result) => {
        if (!controller.signal.aborted) {
          setAvailable(result.provider);
          setOrganizerAddresses(result.provider === "caldav" ? result.organizerAddresses : undefined);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [calendarID, connectionId]);
  return available ? (
    <>
      <Button
        aria-label={`Create ${available === "caldav" ? "CalDAV" : available === "microsoft" ? "Outlook" : "Google"} meeting`}
        title={`Create ${available === "caldav" ? "CalDAV" : available === "microsoft" ? "Outlook" : "Google"} meeting`}
        size="icon-compact"
        variant="ghost"
        onClick={(event) => {
          if (onCreate) onCreate(event.currentTarget);
          else setTrigger(event.currentTarget);
        }}
      >
        <CalendarPlus aria-hidden="true" size={16} strokeWidth={1.7} />
      </Button>
      {trigger ? (
        <ProviderOrganizerEditor
          organizerAddresses={organizerAddresses}
          provider={available}
          calendarID={calendarID}
          color={color}
          connectionId={connectionId}
          returnFocus={trigger}
          onClose={() => setTrigger(null)}
        />
      ) : null}
    </>
  ) : null;
}
export function ProviderOrganizerEditor({
  organizerAddresses,
  calendarID,
  color,
  event,
  observation,
  provider = observation?.organizerEdit?.provider ?? "google",
  connectionId,
  returnFocus,
  onClose,
}: {
  organizerAddresses?: string[];
  calendarID: string;
  color: string;
  event?: Event;
  observation?: ProviderEventStateResponse;
  provider?: "google" | "caldav" | "microsoft";
  connectionId?: string;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => organizerDraft(event, provider, observation));
  const changed = useRef<(keyof OrganizerDraft)[]>([]),
    identity = useRef({
      eventID: event?.id ?? crypto.randomUUID(),
      calendarID,
      color,
      operationID: crypto.randomUUID(),
      provider,
    });
  const frozen = useRef<ProviderOrganizerRequest | null>(null),
    pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState(false),
    [submitted, setSubmitted] = useState(false),
    [frozenAction, setFrozenAction] = useState<
      ProviderOrganizerRequest["action"] | null
    >(null);
  function patch<K extends keyof OrganizerDraft>(
    key: K,
    value: OrganizerDraft[K],
  ) {
    if (frozen.current) return;
    changed.current = [...new Set([...changed.current, key])];
    setDraft((old) => ({ ...old, [key]: value }));
  }
  const canEditTime =
    !event ||
    provider === "google" ||
    observation?.organizerEdit?.timeEdit === true;
  const canUpdate =
    !event ||
    provider === "google" ||
    observation?.organizerEdit?.actions?.includes("update") === true;
  const canDelete =
    !!event &&
    (provider === "google" || observation?.organizerEdit?.actions?.includes("delete") === true);
  const canSubmit = frozenAction === "delete" ? canDelete : canUpdate;
  async function send(action: ProviderOrganizerRequest["action"]) {
    if (
      (action === "update" && !canUpdate) ||
      (action === "delete" && !canDelete)
    )
      return;
    if (pending.current || notice) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!frozen.current && !event && organizerAddresses?.length && !organizerAddresses.includes(draft.organizerAddress ?? "")) throw new Error("Choose the organizer address for this meeting.");
      frozen.current ??= organizerRequest(
        action,
        draft,
        changed.current,
        identity.current,
        observation,
      );
      setFrozenAction(frozen.current.action);
      setSubmitted(true);
      await editProviderOrganizer(frozen.current, connectionId);
      setConfirm(false);
      setNotice(
        `${personalOccurrence ? "Event" : "Meeting"} change saved. Check Delivery details for ${provider === "caldav" ? "the CalDAV server’s" : provider === "microsoft" ? "Outlook's" : "Google's"} result.${personalOccurrence ? "" : " Guest notification delivery remains unknown."}`,
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        "organizerAdmissionRejected" in cause &&
        cause.organizerAdmissionRejected === true
      ) {
        frozen.current = null;
        setFrozenAction(null);
        identity.current.operationID = crypto.randomUUID();
        setSubmitted(false);
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save this meeting action. Retry keeps the same request.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const wholeSeries = observation?.organizerEdit?.scope === "series";
  const occurrence = observation?.organizerEdit?.scope === "occurrence";
  const personalOccurrence = provider === "microsoft" && (occurrence || wholeSeries) && observation?.state?.attendeesComplete && observation.state.attendees.length === 0;
  const locked = busy || submitted || !canUpdate;
  const providerName = provider === "caldav" ? "CalDAV" : provider === "microsoft" ? "Outlook" : "Google";
  return (
    <div
      className="contents"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !pending.current) onClose();
        }}
      >
        <DialogContent onOpenAutoFocus={focusDialogBody} elevated size="form" closeLabel="Close meeting editor" returnFocus={returnFocus} aria-describedby={undefined}>
          <DialogHeader>
            <div className="flex items-center gap-1">
              <DialogTitle>{wholeSeries ? "Edit series" : occurrence ? "Manage this occurrence" : `${event ? "Manage" : "Create"} ${providerName} meeting`}</DialogTitle>
              {personalOccurrence ? null : (
                <HelpTooltip label="Meeting invitation information">
                  {organizerNotificationNotice(provider, observation?.organizerEdit?.timeEdit)}
                </HelpTooltip>
              )}
            </div>
          </DialogHeader>
          <DialogBody>
            {notice ? (
              <p role="status" className="text-14 text-foreground-secondary">{notice}</p>
            ) : (
              <FieldGroup>
                <ProviderOrganizerFields
                  organizerAddresses={organizerAddresses}
                  draft={draft}
                  event={event}
                  provider={provider}
                  locked={locked}
                  canEditTime={canEditTime}
                  occurrence={occurrence}
                  wholeSeries={wholeSeries}
                  onChange={patch}
                />
                {canDelete && !submitted && (
                  <Button className="self-start" variant="secondary" onClick={() => setConfirm(true)}>
                    {occurrence ? "Cancel this occurrence and notify guests" : "Cancel meeting and notify guests"}
                  </Button>
                )}
              </FieldGroup>
            )}
            {error && !confirm && <InlineError>{error}</InlineError>}
          </DialogBody>
          <DialogFooter>
            <Button
              ref={closeButton}
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            >
              {notice ? "Close" : "Cancel"}
            </Button>
            {!notice && canSubmit && (
              <Button
                loading={busy}
                onClick={() =>
                  void send(
                    frozen.current?.action ?? (event ? "update" : "create"),
                  )
                }
              >
                {submitted
                  ? "Retry saved meeting action"
                  : event
                    ? (personalOccurrence ? "Save" : "Save and notify guests")
                    : "Create and send invitations"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirm && (
        <ConfirmationDialog
          elevated
          open
          returnFocus={closeButton}
          children={error ? <InlineError>{error}</InlineError> : null}
          title={occurrence ? "Cancel this occurrence" : `Cancel ${providerName} meeting`}
          description={`${provider === "caldav" ? "The CalDAV server" : provider === "microsoft" ? "Outlook" : "Google"} will be asked to cancel ${occurrence ? "only this occurrence" : "this meeting"} and notify every guest. Guest notification delivery cannot be verified.`}
          confirmLabel={occurrence ? "Cancel this occurrence and notify guests" : "Cancel meeting and notify guests"}
          closeLabel="Keep meeting"
          loading={busy}
          onOpenChange={setConfirm}
          onConfirm={() => void send("delete")}
        />
      )}
    </div>
  );
}

const organizerNote = "text-13 leading-normal text-muted-foreground";

/** The provider management and shared creation flows keep one field contract. */
export function ProviderOrganizerFields({
  organizerAddresses,
  draft,
  event,
  provider,
  locked,
  canEditTime = true,
  occurrence = false,
  wholeSeries = false,
  onChange,
}: {
  organizerAddresses?: string[];
  draft: OrganizerDraft;
  event?: Event;
  provider: "google" | "caldav" | "microsoft";
  locked: boolean;
  canEditTime?: boolean;
  occurrence?: boolean;
  wholeSeries?: boolean;
  onChange: <Key extends keyof OrganizerDraft>(key: Key, value: OrganizerDraft[Key]) => void;
}) {
  const timeType = wholeSeries ? "time" : draft.allDay ? "date" : "datetime-local";
  return <>
    {!event && provider === "caldav" && organizerAddresses?.length ? <Field label="Organizer address"><Select label="Organizer address" placeholder="Choose an address" value={draft.organizerAddress ?? ""} disabled={locked} options={organizerAddresses.map(value => ({value, label: value.slice(7)}))} onChange={value => onChange("organizerAddress", value)} /></Field> : null}
    {(
      [
        ["title", "Title"],
        ["description", "Notes"],
        ["location", "Location"],
      ] as const
    ).map(([key, label]) => (
      <Field key={key} label={label}>
        <Input
          value={draft[key]}
          disabled={locked}
          onChange={(event) => onChange(key, event.target.value)}
        />
      </Field>
    ))}
    {!event && (
      <Field
        label="Guest email addresses"
        help="Separate required guests with commas. Guest-list changes after creation are not supported here."
      >
        <Textarea
          value={draft.guests}
          disabled={locked}
          onChange={(event) => onChange("guests", event.target.value)}
        />
      </Field>
    )}
    {(provider !== "google" && event && !canEditTime) || (occurrence && (provider !== "microsoft" || !canEditTime)) ? (
      <p className={organizerNote}>{wholeSeries ? "Changes apply to the series. Individual occurrence changes are preserved." : occurrence ? "Only this occurrence will change." : "Meeting time and guests are preserved."}</p>
    ) : (
      <>
        {provider === "microsoft" && (occurrence || wholeSeries) ? <p className={organizerNote}>{wholeSeries ? "Changes apply to every occurrence. Dates stay the same." : "Only this occurrence will change."}</p> : null}
        {provider === "caldav" && event ? (
          <p className={organizerNote}>Their existing responses will reset if the time changes.</p>
        ) : null}
        <Checkbox
          label="All day"
          checked={draft.allDay}
          disabled={locked || (provider !== "google" && !!event)}
          onChange={(event) => onChange("allDay", event.target.checked)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start">
            <Input
              type={timeType}
              value={
                wholeSeries ? draft.start.slice(11) : draft.allDay ? draft.start.slice(0, 10) : draft.start
              }
              disabled={locked}
              onChange={(event) => onChange("start", wholeSeries ? `${draft.start.slice(0, 10)}T${event.target.value}` : event.target.value)}
            />
          </Field>
          <Field label="End">
            <Input
              type={timeType}
              value={wholeSeries ? draft.end.slice(11) : draft.allDay ? draft.end.slice(0, 10) : draft.end}
              disabled={locked}
              onChange={(event) => onChange("end", wholeSeries ? `${draft.end.slice(0, 10)}T${event.target.value}` : event.target.value)}
            />
          </Field>
        </div>
        {!draft.allDay && (
          <Field label="Event time zone" description={provider !== "google" && !event ? "New timed meetings use UTC." : undefined}>
            <TimeZonePicker value={draft.timeZone} disabled={locked || (!!event && provider !== "google")} onChange={value => onChange("timeZone", value)} />
          </Field>
        )}
      </>
    )}
  </>;
}
