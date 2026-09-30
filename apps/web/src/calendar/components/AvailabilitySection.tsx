import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { AVAILABILITY_SOURCE_LIMIT, AvailabilityRequestSchema, type AvailabilityRequest } from "@musubi/types";
import { getServerOrigin } from "~/api/query-keys";
import { getAvailability, getAvailabilitySources, selectAvailabilitySource } from "../availability";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { ItemGroup } from "~/components/ui/item";
import { Row } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { Switch } from "~/components/ui/switch";
import { useAsyncAction } from "~/lib/use-async-action";
export function AvailabilitySection({ userId, onReconnect, onRefresh, connectionBusy = false }: {
  userId: string;
  onReconnect: () => void;
  onRefresh: () => Promise<void>;
  connectionBusy?: boolean;
}) {
  const client = useQueryClient();
  const attempt = useRef(0);
  const prefix = ["availability", getServerOrigin(), userId];
  const sourcesKey = [...prefix, "sources"];
  const mutationKey = ["availability-selection", getServerOrigin(), userId];
  const selecting = useIsMutating({ mutationKey }) > 0;
  const refreshing = useIsMutating({ mutationKey: ["connections-sync", getServerOrigin(), userId] }) > 0;
  const refreshAction = useAsyncAction();
  const busy = selecting || refreshing || connectionBusy || refreshAction.busy;
  const sources = useQuery({ queryKey: sourcesKey, queryFn: ({ signal }) => getAvailabilitySources(signal), retry: false, gcTime: 0, staleTime: 0, enabled: !busy, refetchInterval: busy ? false : 30000 });
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [setupTrigger, setSetupTrigger] = useState<HTMLElement | null>(null);
  const formId = useId();
  const [error, setError] = useState("");
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [requested, setRequested] = useState<{ range: AvailabilityRequest; signature: string; attempt: number }>();
  const enabled = sources.data?.sources.filter(source => source.enabled) ?? [];
  const overLimit = enabled.length > AVAILABILITY_SOURCE_LIMIT;
  const limitMessage = `Select up to ${AVAILABILITY_SOURCE_LIMIT} sources. ${enabled.length} selected; turn a source off before adding another.`;
  const signature = JSON.stringify(enabled.map(source => [source.id, source.generation]));
  const result = useQuery({ queryKey: [...prefix, "intervals", requested, signature], queryFn: ({ signal }) => getAvailability(requested!.range, signal), enabled: !busy && !!trigger && !!requested && requested.signature === signature && !sources.isError && !sources.isFetching, retry: false, gcTime: 0, staleTime: 0 });
  const current = !busy && requested?.signature === signature && !sources.isFetching && !sources.isError && !result.isFetching && !result.isError ? result.data : undefined;
  function close() { setTrigger(null); setRequested(undefined); setError(""); }
  const selection = useMutation({
    mutationKey,
    mutationFn: async ({ id, value, generation }: { id: string; value: boolean; generation: number }) => {
      await client.cancelQueries({ queryKey: prefix });
      client.removeQueries({ queryKey: [...prefix, "intervals"] });
      return selectAvailabilitySource(id, value, generation);
    },
    onSuccess: async value => {
      // The mutation outlives this dialog. Retire any observer read before
      // publishing its confirmed response, including after close/reopen.
      await client.cancelQueries({ queryKey: sourcesKey });
      client.setQueryData(sourcesKey, value);
    },
    onError: () => { setError("The source could not be changed. Refresh its current status and try again."); },
    onSettled: () => { void client.invalidateQueries({ queryKey: sourcesKey }); },
  });
  function toggle(id: string, value: boolean, generation: number) {
    if (busy) return;
    if (value && enabled.length >= AVAILABILITY_SOURCE_LIMIT) { setError(limitMessage); return; }
    setError(""); setRequested(undefined);
    selection.mutate({ id, value, generation });
  }
  const hasSources = !!sources.data?.sources.length;
  const setupButton = <Button variant="secondary" size="compact" onClick={event => {
    refreshAction.setError(""); setSetupTrigger(event.currentTarget);
  }}>How to set up</Button>;
  return <>
    <SettingsSection title="Google availability" help="Busy times from calendars shared without event details.">
      {sources.isPending ? <Row label="Loading shared calendars…" role="status" /> : sources.isError ? (
        <Row role="alert" label="Shared calendars could not be loaded" layout="responsive-actions" trailing={
          <Button variant="secondary" size="compact" disabled={busy} loading={sources.isFetching} onClick={() => void sources.refetch()}>Refresh availability sources</Button>
        } />
      ) : sources.data?.sources.map(source => (
        <Row key={source.id} label={source.label}
          detail={source.reconnectRequired ? `${source.accountLabel} · Reconnect Google` : source.accountLabel}
          trailing={<Switch label={`Use ${source.label} for availability`} checked={source.enabled}
            disabled={busy || (!source.enabled && (enabled.length >= AVAILABILITY_SOURCE_LIMIT || source.reconnectRequired))}
            onCheckedChange={value => toggle(source.id, value, source.generation)} />}
        />
      ))}
      {!sources.isPending && !sources.isError && !hasSources ? (
        <Row label="No shared busy-time calendars yet" layout="responsive-actions" trailing={setupButton} />
      ) : <Row label="Add a shared calendar" layout="responsive-actions" trailing={setupButton} />}
      {sources.data?.sources.some(source => source.reconnectRequired) ? (
        <Row label="Google permission needed" layout="responsive-actions" trailing={
          <Button variant="secondary" size="compact" disabled={busy} onClick={onReconnect}>Reconnect Google for availability</Button>
        } />
      ) : null}
      {hasSources ? <Row label={enabled.length ? `${enabled.length} selected` : "Select a calendar to check"} layout="responsive-actions" trailing={
        <Button variant="secondary" size="compact" disabled={busy || sources.isError || !enabled.length || overLimit} onClick={event => {
          setRequested(undefined); setError(""); setTrigger(event.currentTarget);
        }}>Check availability</Button>
      } /> : null}
    </SettingsSection>
    {enabled.length >= AVAILABILITY_SOURCE_LIMIT && !trigger ? <InlineError>{limitMessage}</InlineError> : null}
    {error && !trigger ? <InlineError>{error}</InlineError> : null}
    {setupTrigger ? <Dialog open onOpenChange={open => { if (!open) setSetupTrigger(null); }}>
      <DialogContent closeLabel="Close availability setup" returnFocus={setupTrigger} size="form">
        <DialogHeader>
          <DialogTitle>Set up Google availability</DialogTitle>
          <DialogDescription>For calendars shared without event details.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SettingsSection title="Add a calendar" variant="plain">
            <ol className="grid list-decimal gap-3 pl-5 text-13 leading-normal text-foreground-secondary">
              <li>Ask the owner to share it with the Google account you connected, choosing <strong className="font-medium text-foreground">See only free/busy (hide details)</strong>.</li>
              <li>Open the sharing email and follow its link with that same account.</li>
              <li>Refresh here, switch the new calendar on, then check availability.</li>
            </ol>
          </SettingsSection>
          {refreshAction.error ? <InlineError>{refreshAction.error}</InlineError> : null}
        </DialogBody>
        <DialogFooter>
          <Button asChild variant="secondary">
            <a href="https://support.google.com/calendar/answer/37082?hl=en" target="_blank" rel="noreferrer">Google sharing guide</a>
          </Button>
          <Button disabled={busy} loading={refreshAction.busy} onClick={() => void refreshAction.run(async () => {
            await onRefresh(); setSetupTrigger(null);
          }, "Could not refresh connected calendars.")}>Refresh connected calendars</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : null}
    {trigger ? <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent closeLabel="Close availability" returnFocus={trigger} size="form">
        <DialogHeader>
          <DialogTitle>Check availability</DialogTitle>
          <DialogDescription>Times are UTC. Unavailable does not mean free.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form id={formId} className="grid gap-4 sm:grid-cols-2" onSubmit={event => {
            event.preventDefault(); setError(""); setRequested(undefined);
            if (busy || sources.isFetching || sources.isError) return;
            if (overLimit) { setError(limitMessage); return; }
            const parsed = AvailabilityRequestSchema.safeParse({ start: `${start}T00:00:00Z`, end: `${end}T00:00:00Z`, sourceIds: enabled.map(source => source.id) });
            if (!parsed.success) { setError("Choose an end after the start, up to 42 days, and at least one source."); return; }
            setRequested({ range: parsed.data, signature, attempt: ++attempt.current });
          }}>
            <Field label="From (UTC)"><Input type="date" value={start} onChange={event => { setStart(event.target.value); setRequested(undefined); }} /></Field>
            <Field label="Until (UTC, exclusive)"><Input type="date" value={end} onChange={event => { setEnd(event.target.value); setRequested(undefined); }} /></Field>
          </form>
          {overLimit ? <InlineError>{limitMessage}</InlineError> : null}
          {error ? <InlineError>{error}</InlineError> : null}
          {result.isError || sources.isError ? <InlineError>Availability could not be verified. Try reading again; no free time is confirmed.</InlineError> : null}
          {current ? <SettingsSection title="Busy intervals" variant="plain">
            <ItemGroup>
              <Row label="Observed" value={current.observedAt} />
            </ItemGroup>
            {current.sources.map(source => <ItemGroup key={source.sourceId}>
              <Row label={enabled.find(item => item.id === source.sourceId)?.label ?? "Availability source"} detail={source.status === "available" ? (source.intervals.length ? "Busy during these intervals (UTC)" : "No busy intervals in the requested range") : source.status === "reconnect-required" ? "Reconnect Google — free time is unknown" : "Unavailable — free time is unknown"} />
              {source.status === "available" ? source.intervals.map(interval => <Row key={`${interval.start}/${interval.end}`} label="Busy" detail={`${interval.start} – ${interval.end}`} />) : null}
            </ItemGroup>)}
          </SettingsSection> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="submit" form={formId} loading={result.isFetching} disabled={busy || sources.isFetching || sources.isError || overLimit}>Read busy intervals</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : null}
  </>;
}
