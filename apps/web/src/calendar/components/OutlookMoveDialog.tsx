import { useEffect, useMemo, useRef, useState } from "react";
import { OUTLOOK_MOVE_LIMIT, type OutlookMoveOptions, type OutlookMoveRequest, type OutlookMoveResult } from "@musubi/types";
import { getLatestOutlookMove, getOutlookMove, getOutlookMoveOptions, previewOutlookMove, startOutlookMove } from "~/api/outlook-moves";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { ItemGroup } from "~/components/ui/item";
import { Row } from "~/components/ui/row";
import { Select } from "~/components/ui/select";

const statusLabels = { pending: "Waiting", queued: "Saving", completed: "Moved", failed: "Not moved", unconfirmed: "Unconfirmed", "not-started": "Not started" };

export function OutlookMoveDialog({ eventID, revision = "", returnFocus, onClose }: { eventID: string; revision?: string; returnFocus?: HTMLElement | React.RefObject<HTMLElement | null> | null; onClose: () => void }) {
  const [loadedRevision, setLoadedRevision] = useState(revision);
  const [options, setOptions] = useState<OutlookMoveOptions>();
  const [result, setResult] = useState<OutlookMoveResult>();
  const [selected, setSelected] = useState<string[]>([]);
  const [minutes, setMinutes] = useState("30"), [direction, setDirection] = useState("later");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const active = useRef(true), pending = useRef(false), frozen = useRef<OutlookMoveRequest | null>(null);
  async function loadOptions(signal?: AbortSignal) {
    const value = await getOutlookMoveOptions(eventID, signal);
    if (active.current && !signal?.aborted) { setOptions(value); setSelected([]); setResult(undefined); frozen.current = null; setSubmitted(false); }
  }
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void getLatestOutlookMove(eventID, controller.signal).then(async value => {
      if (controller.signal.aborted) return;
      if (value) setResult(value); else await loadOptions(controller.signal);
      if (!controller.signal.aborted) { setLoadedRevision(revision); setError(""); }
    }).catch(() => { if (!controller.signal.aborted) setError("Could not load the series. Close and reopen to try again."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { active.current = false; controller.abort(); };
    // The caller keys this dialog by server/user/event. Its target never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventID, revision]);
  useEffect(() => {
    if (result?.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await getOutlookMove(result.operationID, controller.signal); if (!controller.signal.aborted) { setResult(value); setError(""); } }
      catch { if (!controller.signal.aborted) setError("Progress could not be refreshed. Your move is still saved."); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [result?.operationID, result?.status, revision]);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "Could not save this move. Try again."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function preview() {
    if (!options) return;
    frozen.current ??= { operationID: crypto.randomUUID(), eventID, calendarID: options.calendarID, expectedVersion: options.version,
      eventIDs: selected, offsetMinutes: Number(minutes) * (direction === "earlier" ? -1 : 1) };
    setSubmitted(true);
    const value = await previewOutlookMove(frozen.current);
    if (active.current) setResult(value);
  }
  const invalidMinutes = !/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 720;
  const locked = busy || submitted;
  const unfinished = result?.items.some(item => item.status === "unconfirmed");
  const waiting = loading || loadedRevision !== revision;
  const previewing = result?.status === "preview";
  const total = result?.items.length ?? selected.length;
  const timeZone = result?.timeZone ?? options?.timeZone ?? "UTC";
  const { date, clock } = useMemo(() => ({
    date: new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone }),
    clock: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }),
  }), [timeZone]);
  const range = (start: string, end: string) => `${clock.format(new Date(start))}–${clock.format(new Date(end))}`;
  const heading = !waiting ? (result?.title ?? options?.title) : undefined;
  const note = "text-13 leading-normal text-muted-foreground";
  return <div className="contents" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent elevated size="form" closeLabel="Close occurrence move" returnFocus={returnFocus} {...(heading ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <DialogTitle>Move selected occurrences</DialogTitle>
          {heading ? <DialogDescription>{heading}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>
          {waiting && !error ? <p role="status" className={note}>Loading series…</p> : null}
          {error ? <InlineError>{error}</InlineError> : null}
          {!waiting && !result && options ? <>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Direction"><Select label="Direction" disabled={locked} value={direction} onChange={setDirection} options={[{ value: "later", label: "Later" }, { value: "earlier", label: "Earlier" }]} /></Field>
                <Field label="Minutes" error={invalidMinutes ? "Choose 1–720 minutes." : undefined}><Input inputMode="numeric" type="number" min={1} max={720} step={1} value={minutes} disabled={locked} onChange={e => setMinutes(e.target.value)} /></Field>
              </div>
              <p className={note}>Times in {timeZone.replaceAll("_", " ")}. Edited and cancelled occurrences stay as they are.</p>
            </FieldGroup>
            <section className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={note}>{selected.length} of {OUTLOOK_MOVE_LIMIT} selected</span>
                <Button variant="ghost" size="compact" disabled={locked} onClick={() => setSelected(selected.length ? [] : options.occurrences.filter(n => Date.parse(n.start) >= Date.now()).slice(0, OUTLOOK_MOVE_LIMIT).map(n => n.eventID))}>{selected.length ? "Clear selection" : `Select next ${OUTLOOK_MOVE_LIMIT}`}</Button>
              </div>
              <div role="group" className="grid" aria-label="Occurrences">
                {options.occurrences.map(item => <Checkbox key={item.eventID} label={date.format(new Date(item.start))} description={range(item.start, item.end)}
                  checked={selected.includes(item.eventID)} disabled={locked || (!selected.includes(item.eventID) && selected.length >= OUTLOOK_MOVE_LIMIT)}
                  onChange={e => setSelected(old => e.target.checked ? [...old, item.eventID] : old.filter(id => id !== item.eventID))} />)}
              </div>
              {options.preserved.unavailable ? <p className={note}>{options.preserved.unavailable} other occurrences need to sync before they can be selected.</p> : null}
            </section>
            {submitted ? <Button className="self-start" variant="ghost" disabled={busy} onClick={() => void run(() => loadOptions())}>Refresh preview</Button> : null}
          </> : null}
          {!waiting && result ? <>
            {previewing ? <div className="grid gap-1">
              <p className="text-14 text-foreground">{total} {total === 1 ? "occurrence" : "occurrences"}, {Math.abs(result.offsetMinutes)} minutes {result.offsetMinutes > 0 ? "later" : "earlier"}. Times in {timeZone.replaceAll("_", " ")}.</p>
              <p className={note}>The series rule, edited occurrences and cancelled dates stay unchanged.</p>
              {result.meeting ? <p className={note}>Outlook will send updates for these meetings. Guests may need to respond again.</p> : null}
              <p className={note}>If a change cannot be confirmed, the remaining occurrences stop. Earlier changes may already be saved.</p>
            </div> : <p role="status" className="text-14 text-foreground">{result.status === "completed" ? `${total} ${total === 1 ? "occurrence" : "occurrences"} moved.` : result.status === "running" ? `${result.items.filter(n => n.status === "completed").length} of ${total} moved. You can close this window; changes will continue.` : "Move stopped. Review each occurrence below; earlier changes have not been rolled back."}</p>}
            <ItemGroup>
              {result.items.map(item => <Row key={item.eventID} label={date.format(new Date(item.start))}
                detail={`${range(item.start, item.end)} → ${range(item.newStart, item.newEnd)}`} value={previewing ? undefined : statusLabels[item.status]} />)}
            </ItemGroup>
            {unfinished ? <p className={note}>An unconfirmed occurrence may already have moved. Check its Delivery details before making another change.</p> : null}
            {result.status !== "running" ? <div className="flex flex-wrap items-center justify-between gap-2">
              {!unfinished ? <Button variant="ghost" disabled={busy} onClick={() => void run(() => loadOptions())}>{previewing ? "Change selection" : "New preview"}</Button> : null}
              {!previewing ? <Button variant="ghost" loading={busy} onClick={() => void run(async () => { const value = await getOutlookMove(result.operationID); if (active.current) setResult(value); })}>Refresh result</Button> : null}
            </div> : null}
          </> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{result && !previewing ? "Close" : "Cancel"}</Button>
          {!waiting && !result && options ? <Button loading={busy} disabled={invalidMinutes || !total} onClick={() => void run(preview)}>Preview {total || ""} {total === 1 ? "occurrence" : "occurrences"}</Button> : null}
          {!waiting && previewing ? <Button loading={busy} onClick={() => void run(async () => { const value = await startOutlookMove(result.operationID); if (active.current) setResult(value); })}>Move {total} {total === 1 ? "occurrence" : "occurrences"}{result.meeting ? " & notify guests" : ""}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
