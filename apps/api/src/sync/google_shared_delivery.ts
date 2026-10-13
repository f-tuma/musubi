import { randomUUID } from "node:crypto";
import {
  assertPinnedOutboxSource, completeEventOutbox, finishEventOutbox, getEventOutboxExpectedRef,
  getEventOutboxRow, getExternalLinkForCalendar, hasEventOutboxRevisionCoverage, renewEventOutboxLease,
  type EventOutboxRow,
} from "@musubi/db";
import { EventWriteError, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import {
  runClaimedGooglePersonalUpdate, supportsGooglePersonalUpdateEnvelope, SyncRuntimeHostError,
  type GooglePersonalUpdatePolicy, type RuntimeAttemptOptions, type RuntimeCompletionEvidence,
  type RuntimeFinishOutcome, type RuntimeNativeFacts,
} from "@musubi/sync-runtime";
import type { CalendarAdapter, ExternalEventRef, GooglePersonalContentV1Bridge } from "./adapter";
import { ProviderEventWriteError } from "./event_write";
import { ProviderAuthError } from "./errors";
import { deliveryNextAttemptAt } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";

const MUSUBI_PERSONAL_POLICY: GooglePersonalUpdatePolicy = Object.freeze({
  completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty",
  untouchedPreflight: false, nativeProfile: "existing-google", observeConflict: true,
});

/** Availability is separate from format recognition. An unregistered custom
 * adapter stays in its existing pinned handler; it never selects this writer. */
export function usesSharedGoogleDelivery(envelope: SyncOperationEnvelope, adapter: CalendarAdapter | null): boolean {
  return typeof adapter?.googlePersonalContentV1 === "function" && supportsGooglePersonalUpdateEnvelope(envelope);
}

/** Host bridge for one already-claimed attempt. SQL, canonical/successor proof,
 * source authority and atomic mapping acceptance remain Musubi responsibilities. */
export async function deliverSharedGoogleEvent(row: EventOutboxRow & { reconciling: boolean }, envelope: SyncOperationEnvelope,
  factory: NonNullable<CalendarAdapter["googlePersonalContentV1"]>, options: RuntimeAttemptOptions = {}) {
  const token = row.leaseToken!;
  const capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
  let expectedRef: ExternalEventRef | null = null;
  let resultRef: ExternalEventRef | null = row.resultRef;
  let remoteSnapshot: EventOutboxRow["remoteSnapshot"] = null;
  let bridge: GooglePersonalContentV1Bridge | undefined;
  // Native creation is lazy: the kernel decoder runs before account/transport
  // factories. One registered adapter owns the credential resolver and HTTP.
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
  };
  const record = (facts: RuntimeNativeFacts) => {
    if (facts.provider.kind === "accepted") resultRef = {
      externalEventId: row.externalEventID!, etag: facts.provider.validator,
      ...(expectedRef?.icalUid ? { icalUid: expectedRef.icalUid } : {}),
    };
    if (facts.remote.kind === "unobserved") return;
    const observed = native().normalizeObservation(facts.remote.read);
    if (facts.remote.kind === "confirmed") {
      if (observed) resultRef = observed.ref;
      // Keep existing pulled conflict evidence owned by the DB ACK. An exact
      // recovery GET is not an instruction to overwrite that retained state.
      remoteSnapshot = null;
      return;
    }
    remoteSnapshot = {
      externalEventId: row.externalEventID!, etag: observed?.ref.etag ?? null,
      icalUid: observed?.ref.icalUid ?? expectedRef?.icalUid, deleted: !observed,
      observedAt: new Date().toISOString(),
      ...(observed ? { values: JSON.parse(JSON.stringify(observed.event)) } : {}),
    };
  };
  const finish = async (outcome: RuntimeFinishOutcome) => {
    // Final facts survive an interrupted active evidence callback as well.
    record(outcome.facts);
    const info = outcome.error;
    let error: unknown = outcome.cause;
    if (info.code === "account-session-changed") error = new EventWriteError("event-write", "unknown");
    else if (info.code === "capability-evidence") error = new EventWriteError(info.capability ?? "event-write", info.evidence ?? "unknown");
    else if (outcome.status === "conflict") error = new ProviderEventWriteError("provider-conflict", info.outcome, info.providerStatus, info.retryAfterMs);
    else if (info.code === "runtime-baseline-validator-unavailable") error = new ProviderEventWriteError("provider-version-unavailable");
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
  const ack = async (evidence: RuntimeCompletionEvidence, signal: AbortSignal) => {
    signal.throwIfAborted(); record(evidence.facts);
    resultRef = evidence.kind === "provider-response"
      ? { externalEventId: row.externalEventID!, etag: evidence.validator, icalUid: expectedRef?.icalUid }
      : native().normalizeObservation(evidence.read)?.ref ?? null;
    const completed = await completeEventOutbox(row.id, token, resultRef, expectedRef, undefined, signal);
    return completed && ["completed", "not-needed"].includes(completed.status)
      ? { kind: "acknowledged" as const } : { kind: completed?.status === "conflict" ? "mapping-conflict" as const : "authority-rejected" as const };
  };
  await withProviderCallMetrics(row.provider, "event", () => runClaimedGooglePersonalUpdate({
    operationId: row.id, attemptId: token, payload: row.payload,
    binding: { kind: "event", action: "update", operationId: row.id, commandId: row.mutationID,
      hostObjectId: row.eventID, provider: row.provider, connectionId: row.accountID,
      collectionId: row.externalCalendarID, resourceId: row.externalEventID, acceptedRevision: row.revision,
      predecessorOperationId: row.predecessorID, sourceEpoch: { sourceId: capture.sourceId, generation: capture.writeGeneration }, privacyEpoch: capture.privacyEpoch },
    nativeTarget: { connectionId: capture.connectionId, connectionGeneration: String(capture.connectionGeneration),
      calendarId: row.externalCalendarID, eventId: row.externalEventID! },
    acceptedEtag: row.expectedEtag, recovery: { required: row.reconciling, possibleDispatch: row.reconciling },
    priorProvider: row.reconciling ? { kind: "uncertain" } : { kind: "not-dispatched" },
  }, {
    async prepare(signal) {
      await checkDestination(signal);
      if (!await hasEventOutboxRevisionCoverage(row)) throw new ProviderEventWriteError("provider-write-failed", row.reconciling ? "unconfirmed" : "not-written");
      signal.throwIfAborted(); expectedRef = await getEventOutboxExpectedRef(row); signal.throwIfAborted();
      return { acceptedEtag: expectedRef?.etag };
    },
    renew: signal => { signal.throwIfAborted(); return renewEventOutboxLease(row.id, token); },
    accountSession: { open: (connection, signal) => native().ports.accountSession.open(connection, signal) },
    beforeMutation: async (_request, signal) => {
      signal.throwIfAborted();
      if (!await renewEventOutboxLease(row.id, token)) throw new ProviderEventWriteError("provider-write-failed");
      await checkDestination(signal); signal.throwIfAborted();
    },
    async recordEvidence(facts, signal) { signal.throwIfAborted(); record(facts); },
    ack, finish, observationId: randomUUID,
  }, {
    http: { fetch: (url, init) => native().ports.http.fetch(url, init) },
    clock: { nowEpochMs: () => native().ports.clock.nowEpochMs(), nowMonotonicMs: () => native().ports.clock.nowMonotonicMs() },
    telemetry: { record: metric => native().ports.telemetry.record(metric) },
  }, MUSUBI_PERSONAL_POLICY, options));
  return getEventOutboxRow(row.id);
}
