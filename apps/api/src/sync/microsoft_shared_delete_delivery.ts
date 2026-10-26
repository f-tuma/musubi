import { reserveProviderMutation } from "./provider_budget";
import { randomUUID } from "node:crypto";
import {
  assertPinnedOutboxSource, completeEventOutbox, finishEventOutbox, getEventOutboxExpectedRef,
  getEventOutboxRow, getExternalLinkForCalendar, renewEventOutboxLease, type EventOutboxRow,
} from "@musubi/db";
import { EventWriteError, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import {
  runClaimedMicrosoftPersonalDelete, SyncRuntimeHostError, type MicrosoftPersonalDeletePolicy,
  type RuntimeAttemptOptions, type MicrosoftRuntimeDeleteCompletionEvidence,
  type MicrosoftRuntimeDeleteFinishOutcome, type MicrosoftRuntimeDeleteNativeFacts,
} from "@musubi/sync-runtime";
import type { CalendarAdapter, ExternalEventRef, MicrosoftPersonalDeleteV1Bridge } from "./adapter";
import { ProviderEventWriteError } from "./event_write";
import { ProviderAuthError } from "./errors";
import { deliveryNextAttemptAt } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";

const MUSUBI_DELETE_POLICY: MicrosoftPersonalDeletePolicy = Object.freeze({ preflightPasses: 2, ambiguousRecovery: "deferred" });

/** Family selection precedes full kernel validation. A malformed selected plan
 * cannot fall back to a second writer; unregistered adapters keep their path. */
export function usesSharedMicrosoftDelete(envelope: SyncOperationEnvelope, adapter: CalendarAdapter | null): boolean {
  return typeof adapter?.microsoftPersonalDeleteV1 === "function" && envelope.operation.kind === "event" &&
    envelope.operation.action === "delete" && envelope.locator.provider === "microsoft" &&
    envelope.serializer.id === "microsoft-personal-event" && envelope.serializer.version === 1;
}

/** One already-claimed guarded Graph DELETE. A native weak ETag is a comparison
 * before dispatch, never CAS authority. Host SQL still owns final acceptance. */
export async function deliverSharedMicrosoftDelete(row: EventOutboxRow & { reconciling: boolean }, envelope: SyncOperationEnvelope,
  factory: NonNullable<CalendarAdapter["microsoftPersonalDeleteV1"]>, options: RuntimeAttemptOptions = {}) {
  const token = row.leaseToken!, capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
  let expectedRef: ExternalEventRef | null = null, remoteSnapshot: EventOutboxRow["remoteSnapshot"] = null;
  let bridge: MicrosoftPersonalDeleteV1Bridge | undefined;
  const native = () => bridge ??= factory(row.userID, row.accountID, capture);
  const checkDestination = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!await assertPinnedOutboxSource(row, true)) throw new SyncRuntimeHostError({ code: "delivery-source-changed", outcome: "not-written" });
    signal.throwIfAborted(); const link = await getExternalLinkForCalendar(row.calendarID); signal.throwIfAborted();
    if (!link || link.id !== row.externalCalendarLinkID || link.userID !== row.userID || link.accountID !== row.accountID ||
        link.provider !== row.provider || link.externalCalendarID !== row.externalCalendarID || link.disabled || !link.supportsEvents)
      throw new SyncRuntimeHostError({ code: "destination-disconnected", outcome: "not-written" });
  };
  const record = (facts: MicrosoftRuntimeDeleteNativeFacts, retainPresent = false) => {
    if (facts.remote.kind === "unobserved") return;
    if (facts.remote.kind === "absent" && !retainPresent) { remoteSnapshot = null; return; }
    // A baseline or a failed fresh verification is not a saved comparison.
    // Recovery presence and explicit conflicts retain the same host evidence
    // as the old executor, including its subsequent explicit-resolution gate.
    if (!retainPresent) return;
    const observed = native().normalizeObservation(facts.remote.read);
    remoteSnapshot = { externalEventId: row.externalEventID!, etag: observed?.ref.etag ?? null,
      icalUid: observed?.ref.icalUid ?? expectedRef?.icalUid, deleted: !observed, observedAt: new Date().toISOString(),
      ...(observed ? { values: JSON.parse(JSON.stringify(observed.event)) } : {}),
    };
  };
  const finish = async (outcome: MicrosoftRuntimeDeleteFinishOutcome) => {
    const info = outcome.error, observeOnly = info.code === "runtime-possible-dispatch-present";
    if (info.deferral) {
      const uncertain = row.reconciling || outcome.facts.possibleDispatch || outcome.facts.provider.kind === "accepted" || outcome.facts.provider.kind === "uncertain";
      await finishEventOutbox(row.id, token, uncertain ? "unconfirmed" : "retry", "provider-budget-deferred", {
        uncertain, nextAttemptAt: new Date(info.deferral.retryAtMs),

      });
      return;
    }
    record(outcome.facts, outcome.status === "conflict" || observeOnly);
    let error: unknown = outcome.cause;
    if (info.code === "account-session-changed") error = new EventWriteError("event-write", "unknown");
    else if (info.code === "capability-evidence") error = new EventWriteError(info.capability ?? "event-write", info.evidence ?? "unknown");
    else if (outcome.status === "conflict") error = new ProviderEventWriteError("provider-conflict", info.outcome, info.providerStatus, info.retryAfterMs);
    else if (info.code === "runtime-baseline-validator-unavailable") error = new ProviderEventWriteError("provider-version-unavailable");
    else if (["provider-conflict", "provider-version-unavailable", "event-diff-unavailable", "provider-write-failed"].includes(info.code))
      error = new ProviderEventWriteError(info.code as ProviderEventWriteError["code"], info.outcome, info.providerStatus, info.retryAfterMs);
    const providerError = error instanceof ProviderEventWriteError ? error : undefined;
    const uncertain = row.reconciling || outcome.facts.possibleDispatch && providerError?.outcome !== "not-written";
    const conflict = providerError?.code === "provider-conflict" || outcome.status === "conflict";
    const retryableStatus = providerError?.providerStatus === 429 || providerError?.providerStatus === 408 || (providerError?.providerStatus ?? 0) >= 500;
    const sourceChanged = info.code === "delivery-source-changed", disconnected = info.code === "destination-disconnected";
    const protocolBlocked = info.phase === "decode" && info.code.startsWith("operation-");
    const blocked = sourceChanged || protocolBlocked || error instanceof EventWriteError || error instanceof ProviderAuthError && error.reconnectRequired ||
      !!providerError && !conflict && !retryableStatus && providerError.outcome !== "unconfirmed";
    const code = sourceChanged || disconnected || protocolBlocked ? info.code : providerError?.code ??
      (error instanceof ProviderAuthError && error.reconnectRequired ? "provider-reconnect-required" :
        error instanceof EventWriteError ? error.reason === "unknown" ? "provider-permission-unknown" : `provider-write-${error.reason}` :
          blocked ? "provider-permission-unavailable" : "provider-write-failed");
    await finishEventOutbox(row.id, token, disconnected ? "cancelled" : conflict ? "conflict" : blocked ? "blocked" : uncertain ? "unconfirmed" : "retry", code, {
      uncertain, nextAttemptAt: observeOnly ? new Date(Date.now() + 3_600_000) : deliveryNextAttemptAt(row.attempts, info.retryAfterMs),
      ...(remoteSnapshot ? { remoteSnapshot } : {}),
    });
  };
  const ack = async (evidence: MicrosoftRuntimeDeleteCompletionEvidence, signal: AbortSignal) => {
    signal.throwIfAborted(); record(evidence.facts);
    // Absence of this native target is not a new global tombstone and cannot
    // erase an independently retained pull conflict or mapping incarnation.
    const completed = await completeEventOutbox(row.id, token, null, expectedRef, undefined, signal);
    return completed && ["completed", "not-needed"].includes(completed.status)
      ? { kind: "acknowledged" as const } : { kind: completed?.status === "conflict" ? "mapping-conflict" as const : "authority-rejected" as const };
  };
  const resolution = row.payload.resolution;
  await withProviderCallMetrics(row.provider, "event", () => runClaimedMicrosoftPersonalDelete({
    operationId: row.id, attemptId: token, attemptNumber: row.attempts, payload: row.payload,
    binding: { kind: "event", action: "delete", operationId: row.id, commandId: row.mutationID, hostObjectId: row.eventID,
      provider: row.provider, connectionId: row.accountID, collectionId: row.externalCalendarID, resourceId: row.externalEventID,
      acceptedRevision: row.revision, predecessorOperationId: row.predecessorID,
      sourceEpoch: { sourceId: capture.sourceId, generation: capture.writeGeneration }, privacyEpoch: capture.privacyEpoch },
    nativeTarget: { connectionId: capture.connectionId, connectionGeneration: String(capture.connectionGeneration),
      calendarId: row.externalCalendarID, eventId: row.externalEventID! },
    acceptedEtag: row.expectedEtag, recovery: { required: row.reconciling, possibleDispatch: row.reconciling },
    priorProvider: row.reconciling ? { kind: "uncertain" } : { kind: "not-dispatched" },
    ...(resolution?.expectedRemoteExists === true && typeof resolution.expectedRemoteEtag === "string"
      ? { resolution: { expectedRemoteExists: true as const, expectedRemoteEtag: resolution.expectedRemoteEtag } } : {}),
  }, {
    async prepare(signal) {
      await checkDestination(signal); expectedRef = await getEventOutboxExpectedRef(row); signal.throwIfAborted();
      if (expectedRef?.externalEventId !== row.externalEventID) throw new ProviderEventWriteError("provider-version-unavailable");
      return { acceptedEtag: expectedRef?.etag };
    },
    renew: signal => { signal.throwIfAborted(); return renewEventOutboxLease(row.id, token); },
    accountSession: { open: (connection, signal) => native().ports.accountSession.open(connection, signal) },
    validateObservation(read, signal) {
      signal.throwIfAborted(); native().normalizeObservation(read); signal.throwIfAborted();
    },
    beforeMutation: async (_request, signal) => {
      return reserveProviderMutation({ url: `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(_request.target.calendarId)}/events/${encodeURIComponent(_request.target.eventId)}`, method: "DELETE" }, async () => {
      signal.throwIfAborted();
      if (!await renewEventOutboxLease(row.id, token)) throw new ProviderEventWriteError("provider-write-failed");
      await checkDestination(signal); signal.throwIfAborted();

      });
    },
    async recordEvidence(facts, signal) { signal.throwIfAborted(); record(facts); },
    ack, finish, observationId: randomUUID,
  }, {
    http: { fetch: (url, init) => native().ports.http.fetch(url, init),
      dispatch: (request, send) => native().ports.http.dispatch?.(request, send) ?? send(),
      isDispatchDeferred: error => native().ports.http.isDispatchDeferred?.(error) ?? false },
    clock: { nowEpochMs: () => native().ports.clock.nowEpochMs(), nowMonotonicMs: () => native().ports.clock.nowMonotonicMs() },
    telemetry: { record: metric => native().ports.telemetry.record(metric) },
  }, MUSUBI_DELETE_POLICY, options));
  return getEventOutboxRow(row.id);
}
