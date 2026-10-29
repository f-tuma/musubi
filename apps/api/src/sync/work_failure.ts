import { createHash } from "node:crypto";
import type { WorkFamily } from "@musubi/sync-runtime";
import type { SyncReadWorkChangeReason } from "@musubi/db";
import { ProviderAuthError } from "./errors";
import { ReadAttemptInterrupted } from "./read_attempt";
import { syncDeferral, type SyncDeferralReason } from "./sync_outcome";

export type SyncWorkFailureContext = Readonly<{
  phase: "candidates" | "execute";
  family?: WorkFamily;
}>;
export type SyncWorkFailureReason =
  | "deferred" | "read-work-changed" | "read-source-changed" | "read-lease-lost"
  | "read-idle" | "read-cancelled" | "read-finished"
  | "work-permit-inactive" | "work-permit-expired" | "work-coordinator-closed" | "work-execution-finished"
  | "budget-connection-changed" | "budget-connection-unavailable" | "budget-context-closed" | "budget-context-missing"
  | "provider-authentication" | "provider-http" | "database-error" | "network-error" | "aborted" | "deadline" | "unknown";
export type SyncWorkFailureFields = Readonly<{
  code: "sync-work-unavailable";
  phase: SyncWorkFailureContext["phase"] | "unknown";
  family?: WorkFamily;
  reason: SyncWorkFailureReason;
  deferralReason?: SyncDeferralReason;
  sqlState?: string;
  networkCode?: string;
  httpStatus?: number;
  readFence?: SyncReadWorkChangeReason;
  messageFingerprint?: string;
  messageFingerprintTruncated?: true;
}>;

const families = new Set<unknown>(["pull", "event-delivery", "task-delivery", "outlook-move"]);
const deferralReasons = new Set<unknown>(["queued-read", "credit", "cooldown", "budget-persistence-pending", "work-capacity"]);
const readFences = new Set<unknown>(["source-or-claim-changed", "missing-work-row", "current-binding-mismatch",
  "captured-binding-mismatch", "checkpoint-mismatch", "claim-guard-failed"]);
const sqlStates = new Set<unknown>([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01", "23503", "23505", "23514", "25006",
  "28000", "28P01", "40001", "40P01", "42501", "42601", "42703", "42804", "42883", "42P01",
  "53300", "55P03", "57014", "57P01", "57P02", "57P03",
]);
const networkCodes = new Set<unknown>([
  "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const messages = new Map<string, SyncWorkFailureReason>([
  ["Sync read work source or claim changed.", "read-work-changed"],
  ["Sync read source changed.", "read-source-changed"],
  ["Sync read source or membership changed.", "read-source-changed"],
  ["Connected account not found or not eligible for sync", "read-source-changed"],
  ["Sync read lease lost before budget wait.", "read-lease-lost"],
  ["Sync read source or lease changed during budget wait.", "read-lease-lost"],
  ["Cannot park an inactive work permit.", "work-permit-inactive"],
  ["Cannot dispatch HTTP under an inactive work permit.", "work-permit-inactive"],
  ["Inactive or unrelated inherited work permit.", "work-permit-inactive"],
  ["Inherited work permit expired.", "work-permit-expired"],
  ["Fair work coordinator is closed.", "work-coordinator-closed"],
  ["Fair work execution finished.", "work-execution-finished"],
  ["Work execution finished while parked.", "work-execution-finished"],
  ["Work execution finished while awaiting a dependency.", "work-execution-finished"],
  ["Work execution finished while HTTP was queued.", "work-execution-finished"],
  ["Provider budget connection changed.", "budget-connection-changed"],
  ["Refresh budget grant changed.", "budget-connection-changed"],
  ["Native budget account changed.", "budget-connection-changed"],
  ["Native budget grant changed.", "budget-connection-changed"],
  ["Native DAV budget material changed.", "budget-connection-changed"],
  ["Current provider budget connection is unavailable.", "budget-connection-unavailable"],
  ["Provider execution budget context is closed.", "budget-context-closed"],
  ["Provider budget activation changed.", "budget-context-closed"],
  ["Provider budget scope is not verified.", "budget-context-missing"],
  ["Provider HTTP requires an explicit live execution budget context.", "budget-context-missing"],
  ["Provider mutation requires an explicit live budget context.", "budget-context-missing"],
]);
const httpErrorNames = new Set<unknown>(["GraphCalendarDiscoveryHttpError", "GraphTaskListDiscoveryHttpError", "GraphTaskReadHttpError"]);

/** Diagnostics must not evaluate arbitrary error getters, stringify thrown
 * objects, or copy their fields: messages can contain SQL, payloads and secrets. */
function data(object: unknown, key: string): unknown {
  if (!object || typeof object !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(object, key)?.value; }
  catch { return undefined; }
}

function nativeExceptionName(error: unknown): unknown {
  try {
    if (error instanceof DOMException) return Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get?.call(error);
  } catch { /* An opaque thrown object has no diagnostic authority. */ }
  return undefined;
}

/** This classification has no scheduling, settlement or authorization effect.
 * Only explicit production deferral classes lower severity. All other failures,
 * including stale read fences, cancellations and provider hiccups, stay errors. */
export function describeSyncWorkFailure(error: unknown, context?: SyncWorkFailureContext): Readonly<{
  level: "warn" | "error";
  fields: SyncWorkFailureFields;
}> {
  const phase = data(context, "phase"), family = data(context, "family");
  const fields: Omit<SyncWorkFailureFields, "reason"> = {
    code: "sync-work-unavailable",
    phase: phase === "candidates" || phase === "execute" ? phase : "unknown",
    ...(phase === "execute" && typeof family === "string" && family.length <= 32 && families.has(family) ? { family: family as WorkFamily } : {}),
  };
  try {
    // Explicit class predicates may read their constructor-owned metadata. Do
    // not call them for an object which replaced that data with an accessor.
    const directRetry = data(error, "retryAtMs"), directBudget = data(error, "deferral");
    const deferral = typeof directRetry === "number" || directBudget && typeof directBudget === "object" ? syncDeferral(error) : undefined;
    const reason = data(deferral, "reason"), retryAtMs = data(deferral, "retryAtMs");
    if (typeof reason === "string" && reason.length <= 32 && deferralReasons.has(reason) &&
        typeof retryAtMs === "number" && Number.isSafeInteger(retryAtMs) && retryAtMs >= 0 && retryAtMs <= 253_402_300_799_999)
      return { level: "warn", fields: { ...fields, reason: "deferred", deferralReason: reason as SyncDeferralReason } };
  } catch { /* A malformed thrown object must not break failure reporting. */ }
  const failure = (reason: SyncWorkFailureReason, detail: Partial<SyncWorkFailureFields> = {}) =>
    ({ level: "error" as const, fields: { ...fields, reason, ...detail } });
  const seen = new Set<unknown>();
  let cursor = error;
  for (let depth = 0; cursor && typeof cursor === "object" && !seen.has(cursor) && depth < 4; depth++) {
    seen.add(cursor);
    const message = data(cursor, "message"), code = data(cursor, "code"), name = data(cursor, "name") ?? nativeExceptionName(cursor);
    if (typeof message === "string" && message.length <= 256 && messages.has(message)) {
      const reason = messages.get(message)!;
      const cause = data(cursor, "cause"), fence = data(cause, "reason");
      return failure(reason, reason === "read-work-changed" && data(cause, "code") === "sync-read-work-changed" &&
        typeof fence === "string" && fence.length <= 32 && readFences.has(fence) ? { readFence: fence as SyncReadWorkChangeReason } : {});
    }
    try {
      if (cursor instanceof ReadAttemptInterrupted) {
        const reason = data(cursor, "reason");
        if (reason === "idle") return failure("read-idle");
        if (reason === "lease-lost") return failure("read-lease-lost");
        if (reason === "cancelled") return failure("read-cancelled");
        if (reason === "finished") return failure("read-finished");
      }
      if (cursor instanceof ProviderAuthError) return failure("provider-authentication");
    } catch { /* Proxies and malformed exceptions remain unknown. */ }
    if (typeof code === "string" && code.length === 5 && sqlStates.has(code)) return failure("database-error", { sqlState: code });
    if (typeof code === "string" && code.length <= 64 && networkCodes.has(code)) return failure("network-error", { networkCode: code });
    if (typeof name === "string" && name.length <= 64 && httpErrorNames.has(name)) {
      const status = data(data(cursor, "cause"), "httpStatus");
      return failure("provider-http", typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {});
    }
    if (name === "AbortError") return failure("aborted");
    if (name === "TimeoutError") return failure("deadline");
    cursor = data(cursor, "cause");
  }
  const message = data(error, "message");
  // Bound work even for malformed errors containing an entire response. Short
  // public literals keep their ordinary SHA-256 for source-only correlation.
  return failure("unknown", typeof message === "string" && message.length ? {
    messageFingerprint: createHash("sha256").update(message.slice(0, 2048)).digest("hex"),
    ...(message.length > 2048 ? { messageFingerprintTruncated: true as const } : {}),
  } : {});
}
