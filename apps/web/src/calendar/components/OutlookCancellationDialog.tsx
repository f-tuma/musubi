import { useRef, useState } from "react";
import type { Event, MicrosoftSeriesCancellationRequest, ProviderEventStateResponse } from "@musubi/types";
import { outlookCancellationNotice, outlookCancellationQueued, outlookCancellationRequest } from "@musubi/calendar";
import { editProviderOrganizer } from "~/api/resources";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { RecurrenceScopeDialog } from "./RecurrenceScopeDialog";

export function OutlookCancellationDialog({ event, observation, returnFocus, onClose }: { event: Event; observation: ProviderEventStateResponse; returnFocus: HTMLElement; onClose: () => void }) {
  const frozen = useRef<MicrosoftSeriesCancellationRequest | null>(null);
  const pending = useRef(false);
  const [selected, setSelected] = useState<"occurrence" | "series">();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [queued, setQueued] = useState(false);
  async function send(scope: "occurrence" | "series") {
    if (pending.current || queued) return;
    pending.current = true; setBusy(true); setError("");
    try {
      frozen.current ??= outlookCancellationRequest(event, observation, scope, crypto.randomUUID());
      setSelected(frozen.current.scope);
      await editProviderOrganizer(frozen.current);
      setQueued(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not queue cancellation. Retry keeps the same request."); }
    finally { pending.current = false; setBusy(false); }
  }
  return queued ? <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent elevated size="compact" closeLabel="Close cancellation" returnFocus={returnFocus} aria-describedby={undefined}>
      <DialogHeader><DialogTitle>Cancellation queued</DialogTitle></DialogHeader>
      <DialogBody><p className="text-14 text-foreground-secondary">{outlookCancellationQueued}</p></DialogBody>
      <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog> :
    <RecurrenceScopeDialog action="cancel" title={event.title} consequence={outlookCancellationNotice} allowedScopes={selected ? [selected] : observation.outlookCancellation?.scopes ?? []} busyScope={busy ? selected : undefined} error={error ? { message: error } : undefined} returnFocus={returnFocus} onResolve={scope => { if (!pending.current) { if (!scope) onClose(); else if (scope !== "following") void send(scope); } }} />;
}
