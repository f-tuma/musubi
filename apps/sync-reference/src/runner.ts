import { randomUUID } from "node:crypto";
import type { GoogleProviderPorts } from "@musubi/provider-google";
import {
  runClaimedGooglePersonalUpdate, supportsGooglePersonalUpdateEnvelope,
  SYNC_RUNTIME_TIMEOUT_MS, SYNC_RUNTIME_HEARTBEAT_MS, SyncRuntimeHostError,
  type GooglePersonalUpdatePolicy, type RuntimeNativeFacts, type RuntimeProviderFact,
} from "@musubi/sync-runtime";
import { ReferenceHoldError } from "./model.js";
import type { ReferenceStore } from "./store.js";

export const REFERENCE_DEADLINE_MS = SYNC_RUNTIME_TIMEOUT_MS;
export const REFERENCE_HEARTBEAT_MS = SYNC_RUNTIME_HEARTBEAT_MS;
export type ReferenceCheckpoint = "claim" | "afterCredentials" | "beforeDispatch" | "afterAcceptance" | "afterUncertain" | "afterReadback" | "afterAck";
export type ReferenceRunnerPorts = Pick<GoogleProviderPorts, "http" | "clock" | "telemetry">;
export type ReferenceRunnerStore = Pick<ReferenceStore, "claim" | "renew" | "getSession" | "markDispatch" | "recordEvidence" | "complete" | "finish">;
export interface ReferenceRunnerOptions {
  attemptId?: string;
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
export const supportsReferenceEnvelope = supportsGooglePersonalUpdateEnvelope;
export const REFERENCE_UPDATE_POLICY: GooglePersonalUpdatePolicy = Object.freeze({
  completion: "exact-readback", ambiguousRecovery: "within-attempt", compareContent: "literal",
  untouchedPreflight: true, nativeProfile: "strict-reference", observeConflict: false,
});
const referenceCode = (code: string) => code.startsWith("runtime-") ? `reference-${code.slice(8)}` : code;
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
async function hostCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (error instanceof ReferenceHoldError) throw new SyncRuntimeHostError({
      code: /^[a-z][a-z0-9-]{0,127}$/.test(error.code) ? error.code : "reference-attempt-failed", outcome: "not-written",
    });
    throw error;
  }
}
function protocolEvidence(facts: RuntimeNativeFacts): Evidence {
  const provider = facts.provider;
  return { provider: provider.kind,
    ...(provider.kind === "accepted" && provider.validator ? { validator: provider.validator } : {}),
    ...(provider.kind === "rejected" ? { error: provider.error } : {}),
    remote: facts.remote.kind,
    ...(facts.remote.kind === "unobserved" ? {} : { observationId: facts.remote.observationId }),
  };
}

/** This host owns one claim and its durable authority/receipt/atomic ACK ports.
 * The shared runtime owns the sole bounded attempt and native decision flow. */
export async function deliverReferenceOperation(store: ReferenceRunnerStore, operationId: string,
  ports: ReferenceRunnerPorts, options: ReferenceRunnerOptions = {}): Promise<ReferenceRunResult> {
  const bounds = validOptions(options, ports); // Invalid options must not acquire a lease.
  options.signal?.throwIfAborted();
  const attemptId = options.attemptId ?? randomUUID();
  const claimed = await store.claim(operationId, attemptId);
  if (!claimed) return { status: "unclaimed", operationId, attemptId };
  // These private authority identities never follow later caller DTO mutation.
  const claim = Object.freeze({ ...claimed, capture: Object.freeze({ ...claimed.capture }),
    locator: Object.freeze({ ...claimed.locator }), binding: Object.freeze({ ...claimed.binding }) });
  const saved = claim.receipt.provider;
  const priorProvider: RuntimeProviderFact = saved.kind === "accepted"
    ? { kind: "accepted", validator: saved.validator?.kind === "etag" ? saved.validator.value : null }
    : saved.kind === "rejected" ? { kind: "rejected", error: saved.error }
    : saved.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: RuntimeNativeFacts, signal?: AbortSignal) => {
    const evidence = protocolEvidence(facts);
    await hostCall(() => store.recordEvidence(claim, evidence, signal));
    recorded = JSON.stringify(evidence);
  };
  const result = await runClaimedGooglePersonalUpdate({
    operationId, attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration),
      calendarId: claim.locator.calendarId, eventId: claim.locator.eventId },
    acceptedEtag: claim.etag, recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
  }, {
    renew: () => store.renew(claim),
    async prepare(signal) { signal.throwIfAborted(); await options.checkpoint?.("claim"); signal.throwIfAborted(); return { acceptedEtag: claim.etag }; },
    accountSession: { open: (_connection, signal) => hostCall(() => store.getSession(claim, ports.clock.nowEpochMs(), signal)) },
    async beforeMutation(_request, signal) {
      if (!await hostCall(() => store.markDispatch(claim, signal)))
        throw new SyncRuntimeHostError({ code: "account-session-changed", outcome: "not-written" });
    },
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "exact-readback") throw new SyncRuntimeHostError({ code: "reference-confirmation-missing", outcome: "not-written" });
      return await hostCall(() => store.complete(claim, { etag: evidence.validator, projection: { ...evidence.projection } }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      // Final settlement may persist known evidence after interruption, under
      // the host lease fence; no detached worker may invoke another port.
      const evidence = protocolEvidence(outcome.facts);
      if (outcome.error.phase !== "decode" && JSON.stringify(evidence) !== recorded) await record(outcome.facts);
      const delay = outcome.retryAfterMs;
      const retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: referenceCode(outcome.error.code),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID,
    checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_UPDATE_POLICY, { timeoutMs: bounds.deadline, heartbeatMs: bounds.heartbeat, signal: options.signal });
  return { status: result.status, operationId, attemptId,
    ...(result.error ? { code: referenceCode(result.error.code) } : {}) };
}
