import { randomUUID } from "node:crypto";
import {
  createGooglePersonalEventProvider, GoogleProviderError, strongGoogleEtag,
  type GoogleNativeEvent, type GooglePersonalUpdate, type GoogleProviderPorts,
} from "@musubi/provider-google";
import { decodeSyncOperationPayload, type SyncError, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { ReferenceHoldError, type ReferenceClaim as Claim } from "./model.js";
import type { ReferenceStore } from "./store.js";

export const REFERENCE_DEADLINE_MS = 45_000;
export const REFERENCE_HEARTBEAT_MS = 20_000;
export type ReferenceCheckpoint = "claim" | "afterCredentials" | "beforeDispatch" | "afterAcceptance" | "afterUncertain" | "afterReadback" | "afterAck";
export type ReferenceRunnerPorts = Pick<GoogleProviderPorts, "http" | "clock" | "telemetry">;
export type ReferenceRunnerStore = Pick<ReferenceStore, "claim" | "renew" | "getSession" | "markDispatch" | "recordEvidence" | "complete" | "finish">;
export interface ReferenceRunnerOptions {
  attemptId?: string;
  /** Shorter bounds are useful for cancellation fixtures; production defaults remain C01. */
  deadlineMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
  checkpoint?: (phase: ReferenceCheckpoint) => void | Promise<void>;
}
export type ReferenceRunResult = {
  status: "acked" | "hold" | "conflict" | "unclaimed";
  operationId: string;
  attemptId: string;
  code?: string;
};
type Evidence = Parameters<ReferenceStore["recordEvidence"]>[1];
type Projection = Record<string, unknown>;

/** Only inspect the two saved views; never invoke a current Event/Task encoder. */
export function supportsReferenceEnvelope(envelope: SyncOperationEnvelope): boolean {
  if (envelope.operation.kind !== "event" || envelope.operation.action !== "update" ||
      envelope.locator.provider !== "google" || envelope.locator.resourceId === null ||
      envelope.serializer.id !== "google-personal-event" || envelope.serializer.version !== 1 ||
      envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") return false;
  const plan = parseNativeWritePlanV1(envelope.serializer, "update", "event", envelope.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !plan.body || !Object.keys(plan.body).length ||
      Object.keys(plan.body).some(key => !["summary", "description", "location"].includes(key))) return false;
  const projection = envelope.admittedProjection.data;
  return projection.isAllDay === false && projection.recurrence === null &&
    matchesPinnedProjectionV1(envelope.serializer, "update", projection, envelope.nativePlan.data);
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left), b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) => Object.prototype.hasOwnProperty.call(right, key) &&
    equal(value, (right as Record<string, unknown>)[key]));
}
function projectionOf(event: GoogleNativeEvent): Projection | null {
  if (event.status !== undefined && !["confirmed", "tentative"].includes(event.status) ||
      event.eventType !== undefined && event.eventType !== "default" ||
      !event.start.dateTime || !event.end.dateTime || event.start.date || event.end.date ||
      event.recurringEventId || event.originalStartTime || event.recurrence?.length) return null;
  return {
    title: event.summary ?? "(untitled)", description: event.description ?? null, location: event.location ?? null,
    start: new Date(event.start.dateTime).toISOString(), end: new Date(event.end.dateTime).toISOString(),
    isAllDay: false, recurrence: null,
  };
}
function preservedProvider(claim: Claim): Evidence["provider"] {
  const kind = claim.receipt.provider.kind;
  return kind === "accepted" || kind === "uncertain" || kind === "rejected" ? kind :
    claim.recovery ? "uncertain" : "not-dispatched";
}
function rejectionError(error: GoogleProviderError): SyncError {
  if (error.providerStatus === 412) return { code: "conflict", retry: "never" };
  if (error.providerStatus === 401 || error.providerStatus === 403) return { code: "permission-denied", retry: "after-reconnect" };
  if (error.providerStatus === 429) {
    const retryAfterMs = error.retryAfterMs === undefined || error.retryAfterMs > Number.MAX_SAFE_INTEGER
      ? undefined : Math.ceil(error.retryAfterMs);
    return { code: "rate-limited", retry: "after-delay", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  return { code: "transport-failed", retry: "never" };
}
function validOptions(options: ReferenceRunnerOptions, ports: ReferenceRunnerPorts) {
  const deadline = options.deadlineMs ?? REFERENCE_DEADLINE_MS;
  const heartbeat = options.heartbeatMs ?? REFERENCE_HEARTBEAT_MS;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > REFERENCE_DEADLINE_MS ||
      !Number.isSafeInteger(heartbeat) || heartbeat < 1 || heartbeat > REFERENCE_HEARTBEAT_MS ||
      options.attemptId !== undefined && (typeof options.attemptId !== "string" || !options.attemptId || options.attemptId.length > 2048) ||
      options.checkpoint !== undefined && typeof options.checkpoint !== "function" ||
      !ports || typeof ports.http?.fetch !== "function" || typeof ports.clock?.nowEpochMs !== "function" ||
      typeof ports.clock?.nowMonotonicMs !== "function" || typeof ports.telemetry?.record !== "function")
    throw new TypeError("Invalid reference runner options.");
  return { deadline, heartbeat };
}

/** This independent host owns the durable admission/attempt/ACK boundary. The
 * provider returns native evidence only. Every retry begins with exact readback
 * after possible dispatch; no HTTP mutation is automatically retried. */
export async function deliverReferenceOperation(store: ReferenceRunnerStore, operationId: string,
  ports: ReferenceRunnerPorts, options: ReferenceRunnerOptions = {}): Promise<ReferenceRunResult> {
  const bounds = validOptions(options, ports); // Invalid options must not acquire a lease.
  options.signal?.throwIfAborted();
  const attemptId = options.attemptId ?? randomUUID();
  const claim = await store.claim(operationId, attemptId);
  if (!claim) return { status: "unclaimed", operationId, attemptId };
  let providerAxis = preservedProvider(claim);
  let providerValidator: string | undefined;
  let providerError = claim.receipt.provider.kind === "rejected" ? claim.receipt.provider.error : undefined;
  if (claim.receipt.provider.kind === "accepted" && claim.receipt.provider.validator?.kind === "etag")
    providerValidator = claim.receipt.provider.validator.value;
  let possibleDispatch = claim.recovery;
  let mutationError: GoogleProviderError | null = null;
  const fromMutation = (error: GoogleProviderError) => error === mutationError;
  let acknowledged = false;
  const controller = new AbortController();
  const aborted = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const timer = setTimeout(() => controller.abort(new Error("Reference attempt deadline.")), bounds.deadline);
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    void store.renew(claim).then(alive => { if (!alive) controller.abort(new Error("Reference lease lost.")); },
      () => controller.abort(new Error("Reference heartbeat failed."))).finally(() => { renewing = false; });
  }, bounds.heartbeat);
  const checkpoint = async (phase: ReferenceCheckpoint) => {
    controller.signal.throwIfAborted();
    await options.checkpoint?.(phase);
    controller.signal.throwIfAborted();
  };
  const evidence = async (remote: Evidence["remote"], extra: Partial<Evidence> = {}) => {
    await store.recordEvidence(claim, { provider: providerAxis, ...(providerValidator ? { validator: providerValidator } : {}),
      ...(providerAxis === "rejected" && providerError ? { error: providerError } : {}),
      remote, ...(remote === "unobserved" ? {} : { observationId: randomUUID() }), ...extra });
  };
  const finish = async (status: "hold" | "conflict", code: string, retryAfterMs?: number): Promise<ReferenceRunResult> => {
    const delay = retryAfterMs === undefined ? undefined : retryAfterMs > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(retryAfterMs);
    await store.finish(claim, status, { code, ...(delay === undefined ? {} : { retryAfterMs: delay }) });
    return { status, operationId, attemptId, code };
  };
  try {
    await checkpoint("claim");
    const decoded = decodeSyncOperationPayload(claim.payload, claim.binding, { supports: supportsReferenceEnvelope });
    if (decoded.kind !== "pinned-v1") return await finish("hold", decoded.kind === "blocked" ? decoded.code : "reference-legacy-unsupported");
    const envelope = decoded.envelope;
    if (!strongGoogleEtag(claim.etag)) return await finish("hold", "reference-baseline-validator-unavailable");
    const plan = parseNativeWritePlanV1(envelope.serializer, "update", "event", envelope.nativePlan.data)!;
    if (plan.planKind !== "json-body" || !plan.body) return await finish("hold", "reference-native-plan-unavailable");
    const acceptedProjection = Object.freeze({ ...envelope.admittedProjection.data });
    const input: GooglePersonalUpdate = {
      operationId, attemptId, target: Object.freeze({ connectionId: envelope.locator.connectionId,
        connectionGeneration: String(claim.capture.connectionGeneration), calendarId: envelope.locator.collectionId,
        eventId: envelope.locator.resourceId! }),
      acceptedEtag: claim.etag, body: Object.freeze({ ...plan.body }), serializer: Object.freeze({ id: "google-personal-event", version: 1 }),
    };
    const provider = createGooglePersonalEventProvider({
      ...ports,
      accountSession: { async open(connection, signal) {
        signal?.throwIfAborted();
        const session = await store.getSession(claim, ports.clock.nowEpochMs(), signal);
        signal?.throwIfAborted();
        if (session.connectionId !== connection.connectionId || session.connectionGeneration !== connection.connectionGeneration)
          throw new GoogleProviderError("account-session-changed");
        await checkpoint("afterCredentials");
        return session;
      } },
      beforeMutation: async (_request, signal) => {
        signal?.throwIfAborted();
        if (!await store.markDispatch(claim)) throw new GoogleProviderError("account-session-changed");
        possibleDispatch = true;
        await checkpoint("beforeDispatch"); // Possible dispatch is durable before this crash seam.
        signal?.throwIfAborted();
      },
    });
    const confirm = async (current: GoogleNativeEvent, etag: string): Promise<ReferenceRunResult | null> => {
      const projection = projectionOf(current);
      if (!projection || !equal(projection, acceptedProjection)) return null;
      await evidence("confirmed");
      await checkpoint("afterReadback");
      if (!await store.complete(claim, { etag, projection })) return await finish("hold", "reference-ack-authority-changed");
      acknowledged = true;
      await options.checkpoint?.("afterAck");
      return { status: "acked", operationId, attemptId };
    };
    const readForConfirmation = async (): Promise<ReferenceRunResult> => {
      const read = await provider.readEvent(input.target, controller.signal);
      if (read.kind !== "present") {
        await evidence("conflict");
        return finish("conflict", read.kind === "absent" ? "reference-resource-absent" : "reference-resource-cancelled");
      }
      const confirmed = await confirm(read.event, read.etag);
      if (confirmed) return confirmed;
      await evidence("conflict");
      return finish("conflict", "reference-readback-differs");
    };
    if (claim.recovery) {
      const read = await provider.readEvent(input.target, controller.signal);
      if (read.kind !== "present") {
        await evidence("conflict");
        return await finish("conflict", read.kind === "absent" ? "reference-resource-absent" : "reference-resource-cancelled");
      }
      const confirmed = await confirm(read.event, read.etag);
      if (confirmed) return confirmed;
      if (read.etag !== claim.etag) {
        await evidence("conflict");
        return await finish("conflict", "reference-recovery-validator-changed");
      }
      // Exact GET has proved the accepted baseline is still current. A new
      // conditional attempt still requires fresh ACL/organizer preflight.
    }
    const preflight = await provider.preflightUpdate(input, controller.signal);
    const existing = projectionOf(preflight.event);
    const changed = new Set(Object.keys(plan.body).map(key => key === "summary" ? "title" : key));
    if (!existing || Object.entries(acceptedProjection).some(([key, value]) => !changed.has(key) && !equal(existing[key], value))) {
      await evidence("conflict");
      return await finish("conflict", "reference-untouched-fields-differ");
    }
    try {
      const write = await provider.update(input, controller.signal);
      if (write.kind !== "written") return await finish("hold", "reference-empty-update");
      providerAxis = "accepted";
      providerError = undefined;
      providerValidator = write.etag ?? undefined;
      await evidence("unobserved");
      await checkpoint("afterAcceptance");
    } catch (error) {
      mutationError = error instanceof GoogleProviderError ? error : null;
      if (error instanceof GoogleProviderError && possibleDispatch && error.outcome === "unconfirmed") {
        providerAxis = "uncertain";
        providerError = undefined;
        providerValidator = undefined;
        await evidence("unobserved", { code: error.code });
        await checkpoint("afterUncertain");
        // GET can confirm content after a lost reply, but never invent the
        // missing HTTP acceptance or notification delivery evidence.
        return await readForConfirmation();
      }
      throw error;
    }
    return await readForConfirmation();
  } catch (error) {
    if (acknowledged) return { status: "acked", operationId, attemptId };
    const native = error instanceof GoogleProviderError ? error : null;
    const code = controller.signal.aborted ? "reference-attempt-aborted" : native?.code ??
      (error instanceof ReferenceHoldError && /^[a-z][a-z0-9-]{0,127}$/.test(error.code) ? error.code : "reference-attempt-failed");
    if (native && fromMutation(native) && possibleDispatch && native.outcome === "unconfirmed") { providerAxis = "uncertain"; providerError = undefined; providerValidator = undefined; }
    else if (native && fromMutation(native) && possibleDispatch && native.providerStatus !== undefined && native.outcome === "not-written" && providerAxis !== "accepted") {
      providerAxis = "rejected"; providerError = rejectionError(native); providerValidator = undefined;
    } else if (possibleDispatch && providerAxis === "not-dispatched") providerAxis = "uncertain";
    await evidence("unobserved", { code });
    const reconnectRequired = native && fromMutation(native) && [401, 403].includes(native.providerStatus ?? 0);
    return await finish(native?.code === "provider-conflict" ? "conflict" : "hold", code, reconnectRequired ? Infinity : native?.retryAfterMs);
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", aborted);
  }
}
