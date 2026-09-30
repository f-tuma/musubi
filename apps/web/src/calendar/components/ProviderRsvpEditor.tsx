import { useRef, useState } from "react";
import type { ProviderEventStateResponse, ProviderRsvpEdit } from "@musubi/types";
import { providerRsvpOptions, providerRsvpNotice, caldavRsvpNotice, microsoftRsvpNotice, microsoftRsvpScopeOptions, microsoftSeriesRsvpNotice, providerRsvpRequest, providerRsvpReceiptMessage } from "@musubi/calendar";
import { editProviderRsvp } from "~/api/resources";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Select } from "~/components/ui/select";
import { focusDialogBody } from "./dialog-focus";

export function ProviderRsvpEditor({ eventId, connectionId, observation, onClose, returnFocus, occurrence = false }: {
  eventId: string; occurrence?: boolean; connectionId?: string; observation: ProviderEventStateResponse; onClose: () => void; returnFocus?: HTMLElement | null;
}) {
  const graph = observation.rsvpEdit?.provider === "microsoft";
  const caldav = observation.rsvpEdit?.provider === "caldav";
  const [scope, setScope] = useState(observation.rsvpEdit?.scope);
  const hasSeries = graph && !!observation.rsvpEdit?.series;
  const occurrenceResponse = occurrence || scope === "occurrence";
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lastRequest = useRef<ProviderRsvpEdit | null>(null);
  async function send() {
    if (pending.current || notice || !response) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const request = lastRequest.current?.response === response && (!graph || lastRequest.current.provider === "microsoft" && lastRequest.current.scope === scope) ? lastRequest.current : providerRsvpRequest(observation, response, crypto.randomUUID(), scope);
      lastRequest.current = request;
      const receipt = await editProviderRsvp(eventId, request, connectionId);
      setNotice(providerRsvpReceiptMessage(receipt.status, graph ? "microsoft" : caldav ? "caldav" : "google"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit your response. Your choice is still here."); }
    finally { pending.current = false; setBusy(false); }
  }
  const title = hasSeries ? "Respond in Outlook" : occurrenceResponse ? "Respond to this occurrence" : graph ? "Respond in Outlook" : caldav ? "Respond in calendar" : "Respond in Google";
  // The scope is what a person must know before sending; delivery caveats are help.
  const scopeLine = occurrenceResponse && !hasSeries ? `This ${graph ? "Outlook" : "Google"} response applies only to this occurrence.` : "";
  return <div className="contents" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
      <DialogContent onOpenAutoFocus={focusDialogBody} size="compact" closeLabel={graph ? "Close Outlook response" : caldav ? "Close calendar response" : "Close Google response"} returnFocus={returnFocus} {...(scopeLine ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>{title}</DialogTitle>
            <HelpTooltip label="About responses">{graph ? microsoftRsvpNotice : caldav ? caldavRsvpNotice : providerRsvpNotice}</HelpTooltip>
          </div>
          {scopeLine ? <DialogDescription>{scopeLine}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>
          {notice ? <p role="status" className="text-14 text-foreground-secondary">{notice}</p> : <FieldGroup>
            {hasSeries && observation.rsvpEdit?.scope === "series" ? <p className="text-13 text-foreground-secondary">Response applies to: Entire series</p> : hasSeries ? <Field label="Response applies to"><Select label="Response applies to" value={scope ?? "series"} disabled={busy} options={microsoftRsvpScopeOptions.filter(option => observation.rsvpEdit?.scope !== "series" || option.value === "series")} onChange={value => setScope(value as "occurrence" | "series")} /></Field> : null}
            <Field label={(caldav || graph) ? "Your response" : "Your Google response"}><Select label={(caldav || graph) ? "Your response" : "Your Google response"} placeholder="Choose a response" value={response} disabled={busy} options={[...providerRsvpOptions]} onChange={setResponse} /></Field>
            {hasSeries ? <p className="text-13 text-foreground-secondary" role="status">{scope === "series" ? microsoftSeriesRsvpNotice(response) : "Only this occurrence will receive your response."}</p> : null}
            {error ? <InlineError>{error}</InlineError> : null}
          </FieldGroup>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{notice ? "Close" : "Cancel"}</Button>
          {!notice ? <Button disabled={!response} loading={busy} onClick={() => void send()}>{(caldav || graph) ? "Send response to organizer" : "Send response"}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
