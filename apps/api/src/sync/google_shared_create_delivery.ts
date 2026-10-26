import { reserveProviderMutation } from "./provider_budget";
import { randomUUID } from "node:crypto";
import {
  assertPinnedOutboxSource, completeEventOutbox, finishEventOutbox, getEventOutboxDeletion,
  getEventOutboxExpectedRef, getEventOutboxRow, getExternalLinkForCalendar,
  hasEventOutboxRevisionCoverage, renewEventOutboxLease, type EventOutboxRow,
} from "@musubi/db";
import { EventWriteError, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import {
  runClaimedGooglePersonalCreate, SyncRuntimeHostError,
  type GooglePersonalCreatePolicy, type RuntimeAttemptOptions, type RuntimeCreateCompletionEvidence,
  type RuntimeCreateFinishOutcome, type RuntimeCreateNativeFacts,
} from "@musubi/sync-runtime";
import type { CalendarAdapter, ExternalEventRef, GooglePersonalCreateV1Bridge } from "./adapter";
import { ProviderEventWriteError } from "./event_write";
import { ProviderAuthError } from "./errors";
import { deliveryNextAttemptAt } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";

const MUSUBI_CREATE_POLICY: GooglePersonalCreatePolicy = Object.freeze({
  completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty",
  nativeProfile: "existing-google", requireStrongReadback: false,
});

/** Select by the declared family after the host's personal-event gate. The
 * kernel validates identity and the admitted profile; invalid pinned data
 * must not select a second writer. Unregistered adapters retain their executor. */
export function usesSharedGoogleCreate(envelope: SyncOperationEnvelope, adapter: CalendarAdapter | null): boolean {
  return typeof adapter?.googlePersonalCreateV1 === "function" && envelope.operation.kind === "event" &&
    envelope.operation.action === "create" && envelope.locator.provider === "google" &&
    envelope.serializer.id === "google-personal-event" && envelope.serializer.version === 1;
}

/** One already-claimed CREATE. Musubi retains source authority, deletion
 * history, successor coverage, pull adoption and atomic mapping acceptance. */
export async function deliverSharedGoogleCreate(row: EventOutboxRow & { reconciling: boolean }, envelope: SyncOperationEnvelope,
  factory: NonNullable<CalendarAdapter["googlePersonalCreateV1"]>, options: RuntimeAttemptOptions = {}) {
  const token = row.leaseToken!;
  const capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
  const plannedID = envelope.locator.resourceId!;
  let expectedRef: ExternalEventRef | null = null;
  let resultRef: ExternalEventRef | null = row.resultRef;
  let remoteSnapshot: EventOutboxRow["remoteSnapshot"] = null;
  let bridge: GooglePersonalCreateV1Bridge | undefined;
  const native = () => bridge ??= factory(row.userID, row.accountID, capture);
  const checkDestination = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!await assertPinnedOutboxSource(row, false))
      throw new SyncRuntimeHostError({ code: "delivery-source-changed", outcome: "not-written" });
    signal.throwIfAborted();
    const link = await getExternalLinkForCalendar(row.calendarID);
    signal.throwIfAborted();
    if (!link || link.id !== row.externalCalendarLinkID || link.userID !== row.userID ||
      link.accountID !== row.accountID || link.provider !== row.provider ||
      link.externalCalendarID !== row.externalCalendarID || link.disabled || !link.supportsEvents)
      throw new SyncRuntimeHostError({ code: "destination-disconnected", outcome: "not-written" });
    // Absence from a GET cannot erase a retained deletion or restore ownership.
    const deleted = await getEventOutboxDeletion(row, plannedID);
    signal.throwIfAborted();
    if (deleted) {
      remoteSnapshot = { externalEventId: plannedID, etag: null, deleted: true, observedAt: deleted.observedAt.toISOString() };
      throw new ProviderEventWriteError("provider-conflict");
    }
  };
  const record = (facts: RuntimeCreateNativeFacts) => {
    if (facts.provider.kind === "accepted") resultRef = { externalEventId: plannedID, etag: facts.provider.validator };
    if (facts.remote.kind === "unobserved") return;
    const observed = native().normalizeObservation(facts.remote.read);
    if (facts.remote.kind === "confirmed") {
      if (observed) resultRef = observed.ref;
      // The host ACK preserves any independently pulled state. Exact recovery
      // is not permission to overwrite a newer retained remote conflict.
      remoteSnapshot = null;
      return;
    }
    remoteSnapshot = { externalEventId: plannedID, etag: observed?.ref.etag ?? null,
      icalUid: observed?.ref.icalUid, deleted: !observed, observedAt: new Date().toISOString(),
      ...(observed ? { values: JSON.parse(JSON.stringify(observed.event)) } : {}),
    };
  };
  const finish = async (outcome: RuntimeCreateFinishOutcome) => {
    record(outcome.facts);
    const info = outcome.error;
    if (info.deferral) {
      const uncertain = row.reconciling || outcome.facts.possibleDispatch || outcome.facts.provider.kind === "accepted" || outcome.facts.provider.kind === "uncertain";
      await finishEventOutbox(row.id, token, uncertain ? "unconfirmed" : "retry", "provider-budget-deferred", {
        uncertain, nextAttemptAt: new Date(info.deferral.retryAtMs), ...(resultRef ? { resultRef } : {}),
        ...(remoteSnapshot ? { remoteSnapshot } : {}),
      });
      return;
    }

    let error: unknown = outcome.cause;
    if (info.code === "account-session-changed") error = new EventWriteError("event-write", "unknown");
    else if (info.code === "capability-evidence") error = new EventWriteError(info.capability ?? "event-write", info.evidence ?? "unknown");
    else if (outcome.status === "conflict") error = new ProviderEventWriteError("provider-conflict", info.outcome, info.providerStatus, info.retryAfterMs);
    else if (["provider-conflict", "provider-version-unavailable", "event-diff-unavailable", "provider-write-failed"].includes(info.code))
      error = new ProviderEventWriteError(info.code as ProviderEventWriteError["code"], info.outcome, info.providerStatus, info.retryAfterMs);
    const providerError = error instanceof ProviderEventWriteError ? error : undefined;
    const uncertain = row.reconciling || (outcome.facts.possibleDispatch && providerError?.outcome !== "not-written");
    const conflict = providerError?.code === "provider-conflict" || outcome.status === "conflict";
    const retryableStatus = providerError?.providerStatus === 429 || providerError?.providerStatus === 408 || (providerError?.providerStatus ?? 0) >= 500;
    const sourceChanged = info.code === "delivery-source-changed";
    const disconnected = info.code === "destination-disconnected";
    const protocolBlocked = info.phase === "decode" && info.code.startsWith("operation-");
    const blocked = sourceChanged || protocolBlocked || error instanceof EventWriteError || error instanceof ProviderAuthError && error.reconnectRequired ||
      !!providerError && !conflict && !retryableStatus && providerError.outcome !== "unconfirmed";
    const code = sourceChanged || disconnected || protocolBlocked ? info.code : providerError?.code ??
      (error instanceof ProviderAuthError && error.reconnectRequired ? "provider-reconnect-required" :
        error instanceof EventWriteError ? error.reason === "unknown" ? "provider-permission-unknown" : `provider-write-${error.reason}` :
          blocked ? "provider-permission-unavailable" : "provider-write-failed");
    await finishEventOutbox(row.id, token, disconnected ? "cancelled" : conflict ? "conflict" : blocked ? "blocked" : uncertain ? "unconfirmed" : "retry", code, {
      uncertain, nextAttemptAt: deliveryNextAttemptAt(row.attempts, info.retryAfterMs),
      ...(remoteSnapshot ? { remoteSnapshot } : {}), ...(resultRef ? { resultRef } : {}),
    });
  };
  const ack = async (evidence: RuntimeCreateCompletionEvidence, signal: AbortSignal) => {
    signal.throwIfAborted(); record(evidence.facts);
    if (evidence.eventId !== plannedID) throw new ProviderEventWriteError("provider-conflict");
    resultRef = evidence.kind === "provider-response"
      ? { externalEventId: plannedID, etag: evidence.validator }
      : native().normalizeObservation(evidence.read)?.ref ?? null;
    if (!resultRef) throw new ProviderEventWriteError("provider-conflict");
    const completed = await completeEventOutbox(row.id, token, resultRef, expectedRef, undefined, signal);
    return completed && ["completed", "not-needed"].includes(completed.status)
      ? { kind: "acknowledged" as const } : { kind: completed?.status === "conflict" ? "mapping-conflict" as const : "authority-rejected" as const };
  };
  await withProviderCallMetrics(row.provider, "event", () => runClaimedGooglePersonalCreate({
    operationId: row.id, attemptId: token, payload: row.payload,
    binding: { kind: "event", action: "create", operationId: row.id, commandId: row.mutationID,
      hostObjectId: row.eventID, provider: row.provider, connectionId: row.accountID,
      collectionId: row.externalCalendarID, resourceId: row.externalEventID, acceptedRevision: row.revision,
      predecessorOperationId: row.predecessorID, sourceEpoch: { sourceId: capture.sourceId, generation: capture.writeGeneration }, privacyEpoch: capture.privacyEpoch },
    nativeTarget: { connectionId: capture.connectionId, connectionGeneration: String(capture.connectionGeneration),
      calendarId: row.externalCalendarID, eventId: plannedID },
    recovery: { required: row.reconciling, possibleDispatch: row.reconciling },
    priorProvider: row.reconciling ? { kind: "uncertain" } : { kind: "not-dispatched" },
  }, {
    async prepare(signal) {
      await checkDestination(signal);
      if (!await hasEventOutboxRevisionCoverage(row)) throw new ProviderEventWriteError("provider-write-failed", row.reconciling ? "unconfirmed" : "not-written");
      signal.throwIfAborted(); expectedRef = await getEventOutboxExpectedRef(row); signal.throwIfAborted();
    },
    renew: signal => { signal.throwIfAborted(); return renewEventOutboxLease(row.id, token); },
    accountSession: { open: (connection, signal) => native().ports.accountSession.open(connection, signal) },
    beforeMutation: async (_request, signal) => {
      return reserveProviderMutation({ url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(_request.target.calendarId)}/events`, method: "POST" }, async () => {
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
  }, MUSUBI_CREATE_POLICY, options));
  return getEventOutboxRow(row.id);
}
