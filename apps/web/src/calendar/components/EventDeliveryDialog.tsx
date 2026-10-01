import { discardEventAlarm } from "~/api/resources";
import { caldavAlarmDescription } from "@musubi/calendar";
import { EventMutationError } from "@musubi/types";
import type {
  EventDeliveryConflict,
  EventDeliveryContent,
  EventDeliveryResolutionRequest,
} from "@musubi/types";
import {
  eventDeliveryActions,
  eventDeliveryRetryLabel,
  eventDeliveryExplanation,
  eventDeliveryLabel,
  providerReminderDescription,
  providerRsvpNotice,
  providerRsvpResponseLabel,
} from "@musubi/calendar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "~/api/http";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import {
  getEventDelivery,
  getEventDeliveryConflict,
  resolveEventDelivery,
  retryEventDelivery,
} from "~/api/resources";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { ItemGroup } from "~/components/ui/item";
import { Row } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { focusDialogBody } from "./dialog-focus";

type Props = {
  eventId: string;
  userId: string;
  connectionId?: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
};

// Mount only while open and key by server/user/connection/event at the caller.
// Preview is deliberate local state: SSE never replaces a comparison mid-read.
export function EventDeliveryDialog({
  eventId,
  userId,
  connectionId,
  onClose,
  returnFocus,
}: Props) {
  const client = useQueryClient();
  const prefix = queryKeys.delivery(getServerOrigin(), userId, connectionId);
  const query = useQuery({
    queryKey: [...prefix, "event", eventId],
    queryFn: ({ signal }) => getEventDelivery(eventId, signal, connectionId),
    retry: false,
    refetchOnMount: "always",
    refetchInterval: 15_000,
  });
  const busyRef = useRef(false);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const discardReturnFocus = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [comparison, setComparison] = useState<{
    preview: EventDeliveryConflict;
    request: EventDeliveryResolutionRequest;
    trigger: HTMLElement;
  }>();
  const [discard, setDiscard] = useState<{ id: string; revision: number; trigger: HTMLElement }>();
  const [reviewTarget, setReviewTarget] = useState<{
    id: string;
    trigger: HTMLElement;
  }>();

  async function run(action: () => Promise<void | boolean>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let refreshed = false;
    try {
      refreshed = (await action()) === true;
    } catch (cause) {
      setError(
        cause instanceof ApiError || cause instanceof EventMutationError
          ? cause.message
          : "Could not reach the server. Try again; the saved operation will keep its identity.",
      );
      if (discard || comparison?.preview.graphCreateAdoption) {
        await query.refetch();
        refreshed = true;
        if (discard) discardReturnFocus.current = refreshRef.current;
        if (comparison?.preview.graphCreateAdoption) adoptionReturnFocus.current = refreshRef.current;
      }
      if ((cause instanceof ApiError && cause.status === 409) ||
        (cause instanceof EventMutationError && cause.code === "provider-conflict")) {
        setComparison(undefined);
        if (discard) setDiscard(undefined);
        setError(
          discard
            ? "The saved alarm delivery state changed. Check the refreshed status before discarding again."
            : "The delivery state changed or cannot be resolved safely. Load a fresh comparison before trying again.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (!refreshed) void client.invalidateQueries({ queryKey: prefix });
    }
  }

  const adoptionReturnFocus = useRef<HTMLElement | null>(null);
  function review(id: string, trigger: HTMLElement) {
    adoptionReturnFocus.current = trigger;
    setReviewTarget({ id, trigger });
    void run(async () => {
      const preview = await getEventDeliveryConflict(
        eventId,
        id,
        undefined,
        connectionId,
      );
      setComparison({
        preview,
        trigger,
        request: preview.graphCreateAdoption ? { kind: "graph-create-adoption", mutationID: crypto.randomUUID(), expectedRevision: preview.localRevision!, stateVersion: preview.graphCreateAdoption.stateVersion } : {
          mutationId: crypto.randomUUID(),
          expectedLocalRevision: preview.localRevision,
          expectedLatestOperationId: preview.latestOperationId,
          expectedRemoteExists: preview.remote !== null,
          expectedRemoteEtag: preview.remoteEtag,
          ...(preview.scopeResolution ? { expectedScopeResolution: preview.scopeResolution } : {}),
          ...(preview.rsvpResolution ? { expectedRsvpBaselineVersion: preview.rsvpResolution.baselineVersion } : {}),
          ...(preview.caldavAlarmResolution ? { expectedReminderStateVersion: preview.caldavAlarmResolution.stateVersion } : preview.reminderResolution ? { expectedReminderStateVersion: preview.reminderResolution.stateVersion } : {}),
          ...(preview.masterRevision !== undefined
            ? { expectedMasterRevision: preview.masterRevision }
            : {}),
        },
      });
    });
  }

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
          if (!open && !busyRef.current) onClose();
        }}
      >
        <DialogContent onOpenAutoFocus={focusDialogBody} size="form" closeLabel="Close delivery" returnFocus={returnFocus} aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>Delivery</DialogTitle>
            <HelpTooltip label="About delivery status">Status of saved changes. Unsaved edits in a form are not included.</HelpTooltip>
          </div>
        </DialogHeader>
        <DialogBody>
        {query.isError ? (
          <InlineError>
            Could not verify delivery. Refresh when the connection is
            available.
          </InlineError>
        ) : null}
        {error ? <InlineError>{error}</InlineError> : null}
        {/* A deleted event keeps only its delivery records; the heading says which. */}
        <SettingsSection
          title={
            query.data && query.data.localRevision == null
              ? "Retained delivery records"
              : "Destinations"
          }
        >
          {query.isPending ? <Row label="Checking delivery…" /> : null}
          {notice ? <Row role="status" label={notice} /> : null}
          {!query.isError && query.data?.targets.length === 0 ? (
            <Row
              label="No external destinations are visible"
              detail="This does not confirm writes to other destinations."
            />
          ) : null}
          {!query.isError
            ? query.data?.targets.map((target) => {
                const actions = eventDeliveryActions(target);
                return (
                  <Row layout="responsive-actions"
                    key={target.targetId}
                    label={`${target.calendarName ?? "Former calendar"} · ${target.provider}`}
                    detail={
                      <span className="whitespace-normal">
                        {eventDeliveryLabel(target)}.{" "}
                        {eventDeliveryExplanation(target)}
                        {target.latestRevision !== target.revision
                          ? " A newer saved change is waiting behind this operation."
                          : ""}
                        {target.updatedAt
                          ? ` Record updated ${target.updatedAt.toLocaleString()}.`
                          : ""}
                        {target.retryAt
                          ? ` Next attempt no earlier than ${target.retryAt.toLocaleString()}.`
                          : ""}
                        {!target.owned
                          ? " Only the connection owner can retry or resolve it."
                          : ""}
                      </span>
                    }
                    trailing={
                      <>
                        {actions.retry ? (
                          <Button
                            size="compact"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await retryEventDelivery(
                                  eventId,
                                  target.operationId!,
                                  connectionId,
                                );
                                setNotice(
                                  target.graphCreateCheck ? "Creation check requested. No new copy will be created." : "Retry requested. Provider confirmation is still pending.",
                                );
                              })
                            }
                          >
                            {eventDeliveryRetryLabel(target)}
                          </Button>
                        ) : null}
                        {target.alarmDiscardRevision !== undefined ? <Button size="compact" variant="secondary" disabled={busy} onClick={event => { setError(""); discardReturnFocus.current = event.currentTarget; setDiscard({ id: target.operationId!, revision: target.alarmDiscardRevision!, trigger: event.currentTarget }); }}>Discard saved alarm change</Button> : null}
                        {actions.review ? (
                          <Button
                            size="compact"
                            variant="secondary"
                            disabled={busy}
                            onClick={(event) =>
                              review(target.operationId!, event.currentTarget)
                            }
                          >
                            Review changes
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                );
              })
            : null}
          {reviewTarget && !comparison ? (
            <Row
              label="Review saved and remote versions"
              trailing={
                <Button
                  disabled={busy}
                  size="compact"
                  variant="secondary"
                  onClick={() => review(reviewTarget.id, reviewTarget.trigger)}
                >
                  Load comparison
                </Button>
              }
            />
          ) : null}
        </SettingsSection>
        </DialogBody>
        <DialogFooter>
          <Button
            ref={refreshRef}
            variant="secondary"
            disabled={busy || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh status
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>
      {discard ? <ConfirmationDialog open title="Discard saved alarm change" description="Stop trying to apply this saved alarm. The current CalDAV event will be read again on the next sync. This does not undo a change the calendar server may already have accepted." confirmLabel="Discard saved alarm change" closeLabel="Close discard confirmation" returnFocus={discardReturnFocus} children={<><p>The saved request remains in delivery history. No calendar server write is sent.</p>{error ? <InlineError>{error}</InlineError> : null}</>} loading={busy} onOpenChange={open => { if (!open && !busyRef.current) setDiscard(undefined); }} onConfirm={() => { const saved = discard; void run(async () => { await discardEventAlarm(eventId, saved.id, saved.revision, connectionId); await query.refetch(); discardReturnFocus.current = refreshRef.current; setDiscard(undefined); setNotice("Saved alarm change discarded. The current CalDAV event will be read on the next sync."); return true; }); }} /> : null}
      {comparison ? (
        <ConfirmationDialog
          open
          onOpenChange={(open) => {
            if (!open && !busyRef.current) {
              setComparison(undefined);
              setReviewTarget(undefined);
            }
          }}
          title="Review remote changes"
          description={comparison.preview.graphCreateAdoption ? "Review the current Outlook family before accepting it into Musubi." : comparison.preview.caldavAlarmResolution ? (comparison.preview.caldavAlarmResolution.scope === "series" ? "Compare the saved series alarm with the current CalDAV alarm for every occurrence." : "Compare the saved event alarm with the current CalDAV event alarm.") : comparison.preview.rsvpResolution ? "Compare your saved response with your current response in Google Calendar." : comparison.preview.reminderResolution ? "Compare your saved reminder settings with your current settings in Google Calendar." : "Compare the current remote copy with the version saved in Musubi."}
          closeLabel="Close comparison"
          returnFocus={comparison.preview.graphCreateAdoption ? adoptionReturnFocus : comparison.trigger}
          confirmLabel={
            comparison.preview.graphCreateAdoption ? "Use provider version" : comparison.preview.caldavAlarmResolution ? (comparison.preview.caldavAlarmResolution.scope === "series" ? "Apply saved series alarm" : "Apply saved event alarm") : comparison.preview.scopeResolution ? (comparison.preview.scopeResolution.kind === "following-delete" ? "Delete following occurrences" : comparison.preview.scopeResolution.kind === "following-create" ? "Finish future series" : comparison.preview.scopeResolution.kind === "following-update" ? "Apply following changes" : "Delete entire series") : comparison.preview.rsvpResolution ? "Send saved response" : comparison.preview.reminderResolution ? "Apply saved reminders" : comparison.preview.action === "delete"
              ? "Delete remote copy"
              : comparison.preview.action === "create"
                ? "Recreate remote copy"
                : "Apply saved changes"
          }
          confirmDisabled={!comparison.preview.canResolve || ((comparison.preview.scopeResolution?.kind === "following-update" && !comparison.preview.splitFuture) || (comparison.preview.scopeResolution?.kind === "following-create" && !comparison.preview.local))}
          loading={busy}
          onConfirm={() =>
            void run(async () => {
              await resolveEventDelivery(
                eventId,
                comparison.preview.operationId,
                comparison.request,
                connectionId,
              );
              if (comparison.preview.graphCreateAdoption) { await query.refetch(); adoptionReturnFocus.current = refreshRef.current; }
              setComparison(undefined);
              setReviewTarget(undefined);
              setNotice(
                comparison.preview.graphCreateAdoption ? "Provider version accepted in Musubi. No provider write was sent." : comparison.preview.rsvpResolution ? "Saved response queued. Google confirmation is still pending; email delivery cannot be verified." : "Saved changes queued. Provider confirmation is still pending.",
              );
              return comparison.preview.graphCreateAdoption ? true : undefined;
            })
          }
        >
          <DeliveryNotice>
            {comparison.preview.graphCreateAdoption ? "This replaces the local draft with the observed provider family. The original request remains in history. No provider write is sent." : comparison.preview.caldavAlarmResolution ? `${comparison.preview.caldavAlarmResolution.scope === "series" ? "This applies to every occurrence in the series. " : ""}This replaces only the supported alarm on the CalDAV event. Calendar apps deliver this alarm; Musubi reminders are separate and both may notify you.` : comparison.preview.scopeResolution ? (comparison.preview.scopeResolution.kind === "following-delete" ? "This removes the selected occurrence and all later occurrences from the remote series. Earlier occurrences remain. The saved deletion in Musubi remains." : comparison.preview.scopeResolution.kind === "following-create" ? "The earlier series is already saved. This finishes only the saved future series at its original destination. If the complete future series is already present, it is confirmed without another write." : comparison.preview.scopeResolution.kind === "following-update" ? "This applies the saved following changes in two steps: shorten the earlier series, then create the saved future series. Delivery may finish one step at a time; retry keeps the same future series identity." : "This removes the entire remote series, including all occurrences and exceptions. The saved deletion in Musubi remains.") : comparison.preview.rsvpResolution ? `This applies only your saved response and preserves the other current Google fields. ${providerRsvpNotice}` : comparison.preview.reminderResolution ? "This replaces your personal Google Calendar reminders. Event time, participants and Musubi reminders stay unchanged. Google Calendar sends these notifications; other apps may notify separately." : comparison.preview.action === "delete"
              ? "This removes the remote copy. The saved deletion in Musubi remains."
              : "This applies the saved version to the remote copy. Remote differences may be replaced; unsaved form edits are not sent."}
          </DeliveryNotice>
          {comparison.preview.scopeResolution ? <ItemGroup>{comparison.preview.scopeResolution.kind === "following-create" ? <Row label="Finish future series" detail={`Original start: ${comparison.preview.scopeResolution.originalStart.value}. Earlier series already saved.`} /> : comparison.preview.scopeResolution?.kind === "following-delete" ? <Row label="Delete this and following" detail={`Original start: ${comparison.preview.scopeResolution.originalStart.value}`} /> : comparison.preview.scopeResolution?.kind === "following-update" ? <Row label="Change this and following" detail={`Original start: ${comparison.preview.scopeResolution.originalStart.value}`} /> : comparison.preview.scopeResolution?.kind === "series-delete" ? <Row label="Entire series" detail="All occurrences and exceptions" /> : null}</ItemGroup> : null}
          {comparison.preview.rsvpResolution ? <ItemGroup>
            <Row label="Saved Google response" detail={providerRsvpResponseLabel(comparison.preview.rsvpResolution.desired)} />
            <Row label="Current Google response" detail={providerRsvpResponseLabel(comparison.preview.rsvpResolution.remote)} />
          </ItemGroup> : comparison.preview.caldavAlarmResolution ? <ItemGroup>
            <Row label="Saved CalDAV event alarm" detail={caldavAlarmDescription(comparison.preview.caldavAlarmResolution.desired)} />
            <Row label="Current CalDAV event alarm" detail={caldavAlarmDescription(comparison.preview.caldavAlarmResolution.remote)} />
          </ItemGroup> : comparison.preview.reminderResolution ? (
            <ItemGroup>
              <Row label="Saved Google reminders" detail={providerReminderDescription({ provider: "google", overrides: [], ...comparison.preview.reminderResolution.desired })} />
              <Row label="Current Google reminders" detail={providerReminderDescription(comparison.preview.reminderResolution.remote)} />
            </ItemGroup>
          ) : <>
          {comparison.preview.splitFuture ? <DeliveryContent title="Saved future series" content={comparison.preview.splitFuture} absent="Future series unavailable" /> : null}
          <DeliveryContent
            title={comparison.preview.scopeResolution?.kind === "following-create" ? "Saved future series" : comparison.preview.splitFuture ? "Saved earlier series" : "Saved in Musubi"}
            content={comparison.preview.local}
            absent="Saved deletion / no local copy"
          />
          <DeliveryContent
            title="Remote copy"
            content={comparison.preview.remote}
            absent="Not found at the provider"
          />
          </>}
          {!comparison.preview.canResolve ? (
            <InlineError>
              {comparison.preview.reason === "reconnect-required"
                ? "Reconnect this account in Connections, then load a new comparison."
                : "The provider state or write permission does not allow a safe resolution. Check the connection and load a new comparison."}
            </InlineError>
          ) : null}
          {error ? <InlineError>{error}</InlineError> : null}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}

function DeliveryContent({
  title,
  content,
  absent,
}: {
  title: string;
  content: EventDeliveryContent | null;
  absent: string;
}) {
  return (
    <section aria-label={title} tabIndex={0}>
      <ItemGroup>
      <Row label={title} detail={content?.title ?? absent} />
      {content ? (
        <>
          {content.originalStart ? (
            <Row
              size="compact"
              label="Scope"
              detail={`One occurrence · original ${content.originalStart.value}`}
            />
          ) : null}
          {content.isCanceled !== undefined ? (
            <Row
              size="compact"
              label="Status"
              detail={content.isCanceled ? "Cancelled" : "Active"}
            />
          ) : null}
          {content.timeModel?.kind === "zoned" ? (
            <Row
              size="compact"
              label="Series time zone"
              detail={`${content.timeModel.timeZone} · ${content.timeModel.startLocal} – ${content.timeModel.endLocal}`}
            />
          ) : null}
          <Row
            size="compact"
            label={content.isAllDay ? "All day" : "Time"}
            detail={
              content.isAllDay
                ? `${content.start.toISOString().slice(0, 10)} – ${content.end.toISOString().slice(0, 10)}`
                : `${content.start.toLocaleString()} – ${content.end.toLocaleString()}`
            }
          />
          <Row
            size="compact"
            label="Location"
            detail={content.location || "None"}
          />
          <Row
            size="compact"
            label="Description"
            detail={<span className="whitespace-normal">{content.description || "None"}</span>}
          />
          <Row
            size="compact"
            label="Recurrence"
            detail={
              content.originalStart
                ? "Occurrence of a series"
                : content.recurrence || "Does not repeat"
            }
          />
        </>
      ) : null}
      </ItemGroup>
    </section>
  );
}

/** What a resolution will do, beside the comparison it resolves. */
function DeliveryNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-control bg-warning-fill px-4 py-3 text-13 leading-normal text-foreground">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning" strokeWidth={1.8} />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
