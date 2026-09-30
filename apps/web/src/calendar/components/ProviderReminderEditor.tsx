import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { ProviderEventStateResponse, AnyProviderReminderEdit } from "@musubi/types";
import { providerReminderDraft, providerReminderRequest, providerReminderReceiptMessage } from "@musubi/calendar";
import { editProviderReminders } from "~/api/resources";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { focusDialogBody } from "./dialog-focus";

export function ProviderReminderEditor({ eventId, connectionId, observation, onClose, returnFocus, occurrence = false }: {
  eventId: string; connectionId?: string; occurrence?: boolean; observation: ProviderEventStateResponse; onClose: () => void; returnFocus?: HTMLElement | null;
}) {
  const caldav = observation.reminderEdit?.provider === "caldav";
  const series = observation.reminderEdit?.provider === "caldav" && observation.reminderEdit.scope === "series";
  const label = caldav ? series ? "CalDAV series alarm" : "CalDAV event alarms" : "Google reminders";
  const [draft, setDraft] = useState(() => providerReminderDraft(observation));
  const instanceDefaults = !caldav && occurrence && draft.mode === "defaults";
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lastRequest = useRef<{ key: string; request: AnyProviderReminderEdit } | null>(null);
  async function save() {
    if (pending.current || notice) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const key = JSON.stringify(draft);
      const request = lastRequest.current?.key === key ? lastRequest.current.request : providerReminderRequest(observation, draft, crypto.randomUUID(), occurrence);
      lastRequest.current = { key, request };
      const receipt = await editProviderReminders(eventId, request, connectionId);
      setNotice(providerReminderReceiptMessage(receipt.status, caldav ? "caldav" : "google"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not save ${label}. Your draft is still here.`); }
    finally { pending.current = false; setBusy(false); }
  }
  // What the person must know to act safely stays visible; the rest is help.
  const scopeLine = caldav
    ? `${series ? "Applies to every occurrence in this series. " : ""}Stored on the event and may be shared with other calendar users.`
    : occurrence ? "These Google reminders apply only to this occurrence." : "";
  const help = caldav
    ? "Calendar apps deliver this alarm. Musubi reminders are separate; both may notify you."
    : "Personal notifications from Google Calendar. Musubi reminders are separate; both apps may notify you.";
  const updateOverride = (index: number, patch: Partial<(typeof draft.overrides)[number]>) =>
    setDraft(current => ({ ...current, overrides: current.overrides.map((entry, position) => position === index ? { ...entry, ...patch } : entry) }));
  return <div className="contents" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
      <DialogContent onOpenAutoFocus={focusDialogBody} size="compact" closeLabel={`Close ${label}`} returnFocus={returnFocus} {...(scopeLine ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>{caldav ? label : occurrence ? "Google reminders for this occurrence" : "Google reminders"}</DialogTitle>
            <HelpTooltip label={`About ${label}`}>{help}</HelpTooltip>
          </div>
          {scopeLine ? <DialogDescription>{scopeLine}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>
          {notice ? <p role="status" className="text-14 text-foreground-secondary">{notice}</p> : <FieldGroup>
            <Field label="Reminder mode"><Select label="Reminder mode" value={draft.mode} disabled={busy} options={[...(!caldav && (!occurrence || instanceDefaults) ? [{ value: "defaults", label: "Calendar defaults", disabled: occurrence }] : []), { value: "off", label: "Off" }, { value: "custom", label: "Custom" }]} onChange={value => setDraft(current => ({ mode: value as typeof current.mode, overrides: value === "custom" && !current.overrides.length ? [{ method: "popup", minutes: "15" }] : current.overrides }))} /></Field>
            {!caldav && occurrence ? <p className="text-13 text-muted-foreground">Choose Custom or Off to change this occurrence.</p> : null}
            {draft.mode === "custom" ? <>
              {draft.overrides.map((item, index) => <div key={index} className="flex items-end gap-2">
                {!caldav ? <Select className="w-auto flex-none" label={`Reminder ${index + 1} method`} value={item.method} disabled={busy} options={[{ value: "popup", label: "Notification" }, { value: "email", label: "Email" }]} onChange={value => updateOverride(index, { method: value as "popup" | "email" })} /> : null}
                <Field className="flex-1" label={`Reminder ${index + 1} minutes before start`} help="Whole minutes, from 0 to 40320."><Input inputMode="numeric" value={item.minutes} disabled={busy} onChange={event => updateOverride(index, { minutes: event.target.value })} /></Field>
                <Button variant="ghost" size="icon" aria-label={`Remove reminder ${index + 1}`} title={`Remove reminder ${index + 1}`} disabled={busy} onClick={() => setDraft(current => ({ ...current, overrides: current.overrides.filter((_, position) => position !== index) }))}><X aria-hidden="true" /></Button>
              </div>)}
              <Button className="self-start" variant="secondary" disabled={busy || draft.overrides.length >= (caldav ? 1 : 5)} onClick={() => setDraft(current => ({ ...current, overrides: [...current.overrides, { method: "popup", minutes: "15" }] }))}><Plus aria-hidden="true" />Add reminder</Button>
            </> : null}
            {error ? <InlineError>{error}</InlineError> : null}
          </FieldGroup>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{notice ? "Close" : "Cancel"}</Button>
          {!notice ? <Button loading={busy} disabled={instanceDefaults} onClick={() => void save()}>Save {label}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
