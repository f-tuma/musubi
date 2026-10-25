import { randomUUID } from "node:crypto";
import type { GoogleProviderPorts, GoogleRequestMetric } from "@musubi/provider-google";
import type { CaldavDeleteProviderPorts, CaldavRequestMetric } from "@musubi/provider-caldav";
import type { MicrosoftRequestMetric } from "@musubi/provider-microsoft";
import {
  runClaimedGooglePersonalUpdate, supportsGooglePersonalUpdateEnvelope, runClaimedGooglePersonalDelete, supportsGooglePersonalDeleteEnvelope,
  runClaimedGooglePersonalCreate, supportsGooglePersonalCreateEnvelope,
  SYNC_RUNTIME_TIMEOUT_MS, SYNC_RUNTIME_HEARTBEAT_MS, SyncRuntimeHostError,
  type GooglePersonalUpdatePolicy, type RuntimeNativeFacts, type RuntimeProviderFact,
  type GooglePersonalDeletePolicy, type RuntimeDeleteNativeFacts, type RuntimeDeleteProviderFact,
  type GooglePersonalCreatePolicy, type RuntimeCreateNativeFacts, type RuntimeCreateProviderFact,
  runClaimedMicrosoftPersonalDelete, supportsMicrosoftPersonalDeleteEnvelope,
  type MicrosoftPersonalDeletePolicy, type MicrosoftRuntimeDeleteNativeFacts, type MicrosoftRuntimeDeleteProviderFact,
  runClaimedCaldavPersonalDelete, supportsCaldavPersonalDeleteEnvelope,
  type CaldavPersonalDeletePolicy, type CaldavRuntimeDeleteNativeFacts, type CaldavRuntimeDeleteProviderFact,
  runClaimedMicrosoftPersonalCreate, supportsMicrosoftPersonalCreateEnvelope, projectMicrosoftCreatedEvent,
  type MicrosoftPersonalCreatePolicy, type MicrosoftRuntimeCreateNativeFacts, type MicrosoftRuntimeCreateProviderFact,
} from "@musubi/sync-runtime";
import { ReferenceHoldError, type ReferenceClaim } from "./model.js";
import type { ReferenceStore } from "./store.js";
import { REFERENCE_GRAPH_DELETE_PROFILE, REFERENCE_CALDAV_DELETE_PROFILE, REFERENCE_GRAPH_CREATE_PROFILE } from "./admission.js";

export const REFERENCE_DEADLINE_MS = SYNC_RUNTIME_TIMEOUT_MS;
export const REFERENCE_HEARTBEAT_MS = SYNC_RUNTIME_HEARTBEAT_MS;
export type ReferenceCheckpoint = "claim" | "afterCredentials" | "beforeDispatch" | "afterAcceptance" | "afterUncertain" | "afterReadback" | "afterAck";
export type ReferenceRunnerPorts = Pick<GoogleProviderPorts, "http" | "clock"> & { caldav?: Pick<CaldavDeleteProviderPorts, "network" | "http">; telemetry: { record(metric: GoogleRequestMetric | MicrosoftRequestMetric | CaldavRequestMetric): void } };
export type ReferenceRunnerStore = Pick<ReferenceStore, "claim" | "renew" | "getSession" | "markDispatch" | "recordEvidence" | "complete" | "completeDelete" | "finish"> & Partial<Pick<ReferenceStore, "completeCreate" | "completeGraphDelete" | "getCaldavSession" | "completeCaldavDelete" | "recordGraphCreateEvidence" | "completeGraphCreate">>;
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
export const supportsReferenceEnvelope = (envelope: Parameters<typeof supportsGooglePersonalUpdateEnvelope>[0]) =>
  supportsGooglePersonalUpdateEnvelope(envelope) || supportsGooglePersonalDeleteEnvelope(envelope) || supportsGooglePersonalCreateEnvelope(envelope) || supportsMicrosoftPersonalDeleteEnvelope(envelope) || supportsCaldavPersonalDeleteEnvelope(envelope) || supportsMicrosoftPersonalCreateEnvelope(envelope);
export const REFERENCE_MICROSOFT_CREATE_POLICY: MicrosoftPersonalCreatePolicy = Object.freeze({ completion: "correlated-readback", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference" });
export const REFERENCE_CALDAV_DELETE_POLICY: CaldavPersonalDeletePolicy = Object.freeze({ completion: "exact-absence", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", observeConflict: false });
export const REFERENCE_MICROSOFT_DELETE_POLICY: MicrosoftPersonalDeletePolicy = Object.freeze({ preflightPasses: 1, ambiguousRecovery: "within-attempt" });
export const REFERENCE_CREATE_POLICY: GooglePersonalCreatePolicy = Object.freeze({
  completion: "exact-readback", ambiguousRecovery: "within-attempt", compareContent: "literal", nativeProfile: "strict-reference", requireStrongReadback: true,
});
export const REFERENCE_DELETE_POLICY: GooglePersonalDeletePolicy = Object.freeze({
  completion: "exact-absence", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", observeConflict: false,
});
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
  const expectedProfile = claim.binding.provider === "google" ? `google-personal-event-${claim.binding.action}-v1` : claim.binding.provider === "microsoft" ? (claim.binding.action === "create" ? REFERENCE_GRAPH_CREATE_PROFILE : REFERENCE_GRAPH_DELETE_PROFILE) : REFERENCE_CALDAV_DELETE_PROFILE;
  if ((claim.binding.provider !== "google" && claim.binding.provider !== "microsoft" && claim.binding.provider !== "caldav") ||
    claim.binding.provider === "microsoft" && (!["create", "delete"].includes(claim.binding.action) || claim.endpointProfile !== expectedProfile) ||
    claim.binding.provider === "caldav" && (claim.binding.action !== "delete" || claim.endpointProfile !== REFERENCE_CALDAV_DELETE_PROFILE) ||
    claim.endpointProfile !== undefined && claim.endpointProfile !== expectedProfile) {
    await store.finish(claim, "hold", { code: "reference-provider-profile-unavailable" });
    return { status: "hold", operationId, attemptId, code: "reference-provider-profile-unavailable" };
  }
  if (claim.binding.provider === "microsoft" && claim.binding.action === "create") return deliverClaimedMicrosoftCreate(store, claim, ports, options, bounds);
  // All other bounded profiles require the already admitted physical ID.
  if (typeof claim.locator.eventId !== "string" || !claim.locator.eventId) {
    await store.finish(claim, "hold", { code: "reference-resource-identity-unavailable" });
    return { status: "hold", operationId, attemptId, code: "reference-resource-identity-unavailable" };
  }
  if (claim.binding.provider === "caldav") return deliverClaimedCaldavDelete(store, claim, ports, options, bounds);
  if (claim.binding.provider === "microsoft") return deliverClaimedMicrosoftDelete(store, claim, ports, options, bounds);
  if (claim.binding.action === "delete") return deliverClaimedDelete(store, claim, ports, options, bounds);
  if (claim.binding.action === "create") return deliverClaimedCreate(store, claim, ports, options, bounds);
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
      calendarId: claim.locator.calendarId, eventId: claim.locator.eventId! },
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

function deleteProtocolEvidence(facts: RuntimeDeleteNativeFacts): Evidence {
  return { provider: facts.provider.kind,
    ...(facts.provider.kind === "accepted" ? { acceptanceStatus: facts.provider.status } : {}),
    ...(facts.provider.kind === "rejected" ? { error: facts.provider.error } : {}),
    remote: facts.remote.kind === "absent" ? "confirmed" : facts.remote.kind,
    ...(facts.remote.kind === "unobserved" ? {} : { observationId: facts.remote.observationId }),
  };
}
/** DELETE shares the bounded attempt but keeps its absence completion distinct from UPDATE content/ETag ACK. */
async function deliverClaimedDelete(store: ReferenceRunnerStore, claim: ReferenceClaim, ports: ReferenceRunnerPorts,
  options: ReferenceRunnerOptions, bounds: { deadline: number; heartbeat: number }): Promise<ReferenceRunResult> {
  const saved = claim.receipt.provider;
  const priorProvider: RuntimeDeleteProviderFact = saved.kind === "accepted" && claim.deleteAcceptanceStatus != null
    ? { kind: "accepted", status: claim.deleteAcceptanceStatus }
    : saved.kind === "rejected" ? { kind: "rejected", error: saved.error }
    : saved.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: RuntimeDeleteNativeFacts, signal?: AbortSignal) => {
    const evidence = deleteProtocolEvidence(facts);
    await hostCall(() => store.recordEvidence(claim, evidence, signal)); recorded = JSON.stringify(evidence);
  };
  const result = await runClaimedGooglePersonalDelete({
    operationId: claim.operationId, attemptId: claim.attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration),
      calendarId: claim.locator.calendarId, eventId: claim.locator.eventId! },
    acceptedEtag: claim.etag, recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
  }, {
    renew: () => store.renew(claim),
    async prepare(signal) { signal.throwIfAborted(); await options.checkpoint?.("claim"); signal.throwIfAborted(); return { acceptedEtag: claim.etag }; },
    accountSession: { open: (_connection, signal) => hostCall(() => store.getSession(claim, ports.clock.nowEpochMs(), signal)) },
    async beforeMutation(_request, signal) {
      if (!await hostCall(() => store.markDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "account-session-changed", outcome: "not-written" });
    },
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "exact-absence") throw new SyncRuntimeHostError({ code: "reference-confirmation-missing", outcome: "not-written" });
      return await hostCall(() => store.completeDelete(claim, { kind: "exact-absence", read: { ...evidence.read } }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      const evidence = deleteProtocolEvidence(outcome.facts);
      if (outcome.error.phase !== "decode" && JSON.stringify(evidence) !== recorded) await record(outcome.facts);
      const delay = outcome.retryAfterMs;
      const retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: referenceCode(outcome.error.code), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID,
    checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_DELETE_POLICY, { timeoutMs: bounds.deadline, heartbeatMs: bounds.heartbeat, signal: options.signal });
  return { status: result.status, operationId: claim.operationId, attemptId: claim.attemptId,
    ...(result.error ? { code: referenceCode(result.error.code) } : {}) };
}

function createProtocolEvidence(facts: RuntimeCreateNativeFacts): Evidence {
  return { provider: facts.provider.kind,
    ...(facts.provider.kind === "accepted" && facts.provider.validator ? { validator: facts.provider.validator } : {}),
    ...(facts.provider.kind === "rejected" ? { error: facts.provider.error } : {}),
    remote: facts.remote.kind,
    ...(facts.remote.kind === "unobserved" ? {} : { observationId: facts.remote.observationId }),
  };
}
async function deliverClaimedCreate(store: ReferenceRunnerStore, claim: ReferenceClaim, ports: ReferenceRunnerPorts,
  options: ReferenceRunnerOptions, bounds: { deadline: number; heartbeat: number }): Promise<ReferenceRunResult> {
  const saved = claim.receipt.provider;
  const priorProvider: RuntimeCreateProviderFact = saved.kind === "accepted"
    ? { kind: "accepted", validator: saved.validator?.kind === "etag" ? saved.validator.value : null }
    : saved.kind === "rejected" ? { kind: "rejected", error: saved.error }
    : saved.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: RuntimeCreateNativeFacts, signal?: AbortSignal) => {
    const evidence = createProtocolEvidence(facts);
    await hostCall(() => store.recordEvidence(claim, evidence, signal)); recorded = JSON.stringify(evidence);
  };
  const result = await runClaimedGooglePersonalCreate({
    operationId: claim.operationId, attemptId: claim.attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration), calendarId: claim.locator.calendarId, eventId: claim.locator.eventId! },
    recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
  }, {
    renew: () => store.renew(claim),
    async prepare(signal) {
      signal.throwIfAborted();
      if (!store.completeCreate) throw new SyncRuntimeHostError({ code: "reference-create-completion-unavailable", outcome: "not-written" });
      await options.checkpoint?.("claim"); signal.throwIfAborted();
    },
    accountSession: { open: (_connection, signal) => hostCall(() => store.getSession(claim, ports.clock.nowEpochMs(), signal)) },
    async beforeMutation(_request, signal) {
      if (!await hostCall(() => store.markDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "account-session-changed", outcome: "not-written" });
    },
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "exact-readback" || !evidence.validator || !store.completeCreate)
        throw new SyncRuntimeHostError({ code: "reference-confirmation-missing", outcome: "not-written" });
      return await hostCall(() => store.completeCreate!(claim, { eventId: evidence.eventId, etag: evidence.validator!, projection: { ...evidence.projection } }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      const evidence = createProtocolEvidence(outcome.facts);
      if (outcome.error.phase !== "decode" && JSON.stringify(evidence) !== recorded) await record(outcome.facts);
      const delay = outcome.retryAfterMs;
      const retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: referenceCode(outcome.error.code), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID,
    checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_CREATE_POLICY, { timeoutMs: bounds.deadline, heartbeatMs: bounds.heartbeat, signal: options.signal });
  return { status: result.status, operationId: claim.operationId, attemptId: claim.attemptId,
    ...(result.error ? { code: referenceCode(result.error.code) } : {}) };
}

function microsoftDeleteProtocolEvidence(facts: MicrosoftRuntimeDeleteNativeFacts): Evidence {
  return { provider: facts.provider.kind,
    ...(facts.provider.kind === "accepted" ? { acceptanceStatus: facts.provider.status } : {}),
    ...(facts.provider.kind === "rejected" ? { error: facts.provider.error } : {}),
    remote: facts.remote.kind === "absent" ? "confirmed" : facts.remote.kind === "present" ? "conflict" : "unobserved",
    ...(facts.remote.kind === "unobserved" ? {} : { observationId: facts.remote.observationId }),
  };
}
async function deliverClaimedMicrosoftDelete(store: ReferenceRunnerStore, claim: ReferenceClaim, ports: ReferenceRunnerPorts,
  options: ReferenceRunnerOptions, bounds: { deadline: number; heartbeat: number }): Promise<ReferenceRunResult> {
  const saved = claim.receipt.provider;
  const priorProvider: MicrosoftRuntimeDeleteProviderFact = saved.kind === "accepted" && [204, 404].includes(claim.deleteAcceptanceStatus ?? 0)
    ? { kind: "accepted", status: claim.deleteAcceptanceStatus as 204 | 404 }
    : saved.kind === "rejected" ? { kind: "rejected", error: saved.error }
    : saved.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: MicrosoftRuntimeDeleteNativeFacts, signal?: AbortSignal) => {
    const evidence = microsoftDeleteProtocolEvidence(facts);
    await hostCall(() => store.recordEvidence(claim, evidence, signal)); recorded = JSON.stringify(evidence);
  };
  const result = await runClaimedMicrosoftPersonalDelete({
    operationId: claim.operationId, attemptId: claim.attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration), calendarId: claim.locator.calendarId, eventId: claim.locator.eventId! },
    acceptedEtag: claim.etag, attemptNumber: claim.attemptNumber ?? 0,
    recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
    // Reference deliberately has no resolution/supersession admission capability.
  }, {
    renew: () => store.renew(claim),
    async prepare(signal) {
      signal.throwIfAborted();
      if (!store.completeGraphDelete) throw new SyncRuntimeHostError({ code: "reference-graph-completion-unavailable", outcome: "not-written" });
      await options.checkpoint?.("claim"); signal.throwIfAborted(); return { acceptedEtag: claim.etag };
    },
    accountSession: { open: (_connection, signal) => hostCall(() => store.getSession(claim, ports.clock.nowEpochMs(), signal)) },
    async beforeMutation(_request, signal) {
      if (!await hostCall(() => store.markDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "account-session-changed", outcome: "not-written" });
    },
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "exact-absence" || evidence.read.kind !== "absent" || evidence.read.status !== 404 || !store.completeGraphDelete)
        throw new SyncRuntimeHostError({ code: "reference-confirmation-missing", outcome: "not-written" });
      return await hostCall(() => store.completeGraphDelete!(claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      const evidence = microsoftDeleteProtocolEvidence(outcome.facts);
      if (outcome.error.phase !== "decode" && JSON.stringify(evidence) !== recorded) await record(outcome.facts);
      const delay = outcome.retryAfterMs;
      const retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: referenceCode(outcome.error.code), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID, checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_MICROSOFT_DELETE_POLICY, { timeoutMs: bounds.deadline, heartbeatMs: bounds.heartbeat, signal: options.signal });
  return { status: result.status, operationId: claim.operationId, attemptId: claim.attemptId,
    ...(result.error ? { code: referenceCode(result.error.code) } : {}) };
}

function caldavDeleteProtocolEvidence(facts: CaldavRuntimeDeleteNativeFacts): Evidence {
  return { provider: facts.provider.kind,
    ...(facts.provider.kind === "accepted" ? { acceptanceStatus: facts.provider.status } : {}),
    ...(facts.provider.kind === "rejected" ? { error: facts.provider.error } : {}),
    remote: facts.remote.kind === "absent" ? "confirmed" : facts.remote.kind === "present" ? "conflict" : "unobserved",
    ...(facts.remote.kind === "unobserved" ? {} : { observationId: facts.remote.observationId }),
  };
}
async function deliverClaimedCaldavDelete(store: ReferenceRunnerStore, claim: ReferenceClaim, ports: ReferenceRunnerPorts,
  options: ReferenceRunnerOptions, bounds: { deadline: number; heartbeat: number }): Promise<ReferenceRunResult> {
  // A missing guarded transport must never fall back to the generic OAuth fetch.
  if (!store.getCaldavSession || !store.completeCaldavDelete || !ports.caldav || typeof ports.caldav.http?.fetchPinned !== "function" ||
    typeof ports.caldav.network?.lookupImpl !== "function" || typeof ports.caldav.network.allowPrivate !== "boolean") {
    await store.finish(claim, "hold", { code: "reference-caldav-ports-unavailable" });
    return { status: "hold", operationId: claim.operationId, attemptId: claim.attemptId, code: "reference-caldav-ports-unavailable" };
  }
  const saved = claim.receipt.provider;
  const priorProvider: CaldavRuntimeDeleteProviderFact = saved.kind === "accepted" && [200, 201, 204, 404].includes(claim.deleteAcceptanceStatus ?? 0)
    ? { kind: "accepted", status: claim.deleteAcceptanceStatus as 200 | 201 | 204 | 404 }
    : saved.kind === "rejected" ? { kind: "rejected", error: saved.error }
    : saved.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: CaldavRuntimeDeleteNativeFacts, signal?: AbortSignal) => {
    const evidence = caldavDeleteProtocolEvidence(facts); await hostCall(() => store.recordEvidence(claim, evidence, signal)); recorded = JSON.stringify(evidence);
  };
  const result = await runClaimedCaldavPersonalDelete({
    operationId: claim.operationId, attemptId: claim.attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration),
      calendarUrl: claim.locator.calendarId, resourceUrl: claim.locator.eventId!, uid: claim.acceptedUid ?? "" },
    acceptedEtag: claim.etag, recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
  }, {
    renew: () => store.renew(claim),
    async prepare(signal) { signal.throwIfAborted(); await options.checkpoint?.("claim"); signal.throwIfAborted(); return { acceptedEtag: claim.etag, acceptedUid: claim.acceptedUid ?? null }; },
    accountSession: { open: (_connection, signal) => hostCall(() => store.getCaldavSession!(claim, ports.clock.nowEpochMs(), signal)) },
    async beforeMutation(_request, signal) {
      if (!await hostCall(() => store.markDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "account-session-changed", outcome: "not-written" });
    },
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "exact-absence" || evidence.read.kind !== "absent" || evidence.read.status !== 404)
        throw new SyncRuntimeHostError({ code: "reference-confirmation-missing", outcome: "not-written" });
      return await hostCall(() => store.completeCaldavDelete!(claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      const evidence = caldavDeleteProtocolEvidence(outcome.facts);
      if (outcome.error.phase !== "decode" && JSON.stringify(evidence) !== recorded) await record(outcome.facts);
      const delay = outcome.retryAfterMs, retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: referenceCode(outcome.error.code), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID, checkpoint: phase => options.checkpoint?.(phase),
  }, { ...ports.caldav, clock: ports.clock, telemetry: ports.telemetry }, REFERENCE_CALDAV_DELETE_POLICY,
  { timeoutMs: bounds.deadline, heartbeatMs: bounds.heartbeat, signal: options.signal });
  return { status: result.status, operationId: claim.operationId, attemptId: claim.attemptId, ...(result.error ? { code: referenceCode(result.error.code) } : {}) };
}

function microsoftCreateProtocolEvidence(facts: MicrosoftRuntimeCreateNativeFacts): Parameters<ReferenceStore["recordGraphCreateEvidence"]>[1] {
  const provider = facts.provider, remote = facts.remote;
  return { provider: provider.kind,
    ...(provider.kind === "accepted" ? { candidateEventId: provider.eventId, createAcceptance: { status: provider.status, validator: provider.validator } } :
      provider.kind === "uncertain" && remote.kind === "confirmed" ? { candidateEventId: remote.read.event.id } : {}),
    ...(provider.kind === "rejected" ? { error: provider.error } : {}),
    remote: remote.kind === "missing" ? "conflict" : remote.kind,
    ...(remote.kind === "unobserved" ? {} : { observationId: remote.observationId }),
  };
}
async function deliverClaimedMicrosoftCreate(store: ReferenceRunnerStore, claim: ReferenceClaim, ports: ReferenceRunnerPorts,
  options: ReferenceRunnerOptions, bounds: { deadline: number; heartbeat: number }): Promise<ReferenceRunResult> {
  if (!store.recordGraphCreateEvidence || !store.completeGraphCreate) {
    await store.finish(claim, "hold", { code: "reference-graph-create-ports-unavailable" });
    return { status: "hold", operationId: claim.operationId, attemptId: claim.attemptId, code: "reference-graph-create-ports-unavailable" };
  }
  const saved = claim.receipt.provider, native = claim.graphCreate;
  const accepted = saved.kind === "accepted" && native && native.candidateEventId && native.acceptanceStatus !== null;
  const priorProvider: MicrosoftRuntimeCreateProviderFact = accepted
    ? { kind: "accepted", eventId: native.candidateEventId!, validator: native.acceptanceValidator, status: native.acceptanceStatus! }
    : saved.kind === "rejected" ? { kind: "rejected", error: saved.error }
    : saved.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: MicrosoftRuntimeCreateNativeFacts, signal?: AbortSignal) => {
    const evidence = microsoftCreateProtocolEvidence(facts); await hostCall(() => store.recordGraphCreateEvidence!(claim, evidence, signal)); recorded = JSON.stringify(evidence);
  };
  const result = await runClaimedMicrosoftPersonalCreate({ operationId: claim.operationId, attemptId: claim.attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration), calendarId: claim.locator.calendarId },
    recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider, priorCandidateEventId: native?.candidateEventId ?? null,
  }, {
    renew: () => store.renew(claim),
    async prepare(signal) {
      signal.throwIfAborted();
      if (claim.locator.eventId !== null || claim.binding.resourceId !== null || saved.kind === "accepted" && !accepted) throw new SyncRuntimeHostError({ code: "reference-graph-create-history-unavailable", outcome: "not-written" });
      await options.checkpoint?.("claim"); signal.throwIfAborted();
    },
    accountSession: { open: (_connection, signal) => hostCall(() => store.getSession(claim, ports.clock.nowEpochMs(), signal)) },
    async beforeMutation(_request, signal) {
      if (!await hostCall(() => store.markDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "account-session-changed", outcome: "not-written" });
    },
    normalizeObservation: read => projectMicrosoftCreatedEvent(read.event),
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "correlated-readback") throw new SyncRuntimeHostError({ code: "reference-confirmation-missing", outcome: "not-written" });
      return await hostCall(() => store.completeGraphCreate!(claim, { kind: "correlated-readback", eventId: evidence.eventId, etag: evidence.validator,
        projection: { ...evidence.projection }, read: evidence.read,
        correlation: { kind: "complete-scoped-listing", operationId: claim.operationId, calendarId: claim.locator.calendarId, matches: 1 } }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      const evidence = microsoftCreateProtocolEvidence(outcome.facts);
      if (outcome.error.phase !== "decode" && JSON.stringify(evidence) !== recorded) await record(outcome.facts);
      const delay = outcome.retryAfterMs, retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: referenceCode(outcome.error.code), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID, checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_MICROSOFT_CREATE_POLICY, { timeoutMs: bounds.deadline, heartbeatMs: bounds.heartbeat, signal: options.signal });
  return { status: result.status, operationId: claim.operationId, attemptId: claim.attemptId, ...(result.error ? { code: referenceCode(result.error.code) } : {}) };
}
