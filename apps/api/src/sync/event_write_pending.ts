import { ProviderDispatchDeferred } from "@musubi/sync-runtime";
import { DeliveryAttemptInterrupted } from "./delivery_policy";

/** Default client retry hint when the bounded preflight deadline expired. */
export const EVENT_WRITE_PENDING_RETRY_MS = 5_000;

/** The pre-commit provider preflight could not run: the scheduler or budget
 * deferred it before any raw dispatch, or its bounded attempt deadline expired
 * while it waited. Nothing was written locally or remotely, so the same event
 * identity may be retried. This is not a permission answer (403), not a
 * provider failure and not an uncertain post-dispatch outcome. */
export class EventWritePending extends Error {
  readonly code = "provider-busy" as const;
  constructor(readonly reason: "deferred" | "timeout", readonly retryAtMs: number) {
    super("Calendar writing is temporarily unavailable. No changes were saved. Try again shortly.");
    this.name = "EventWritePending";
    if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253_402_300_799_999) throw new RangeError("Invalid pending retry time.");
  }
}

/** Only the two typed pre-commit classes qualify. Messages, error codes such as
 * ETIMEDOUT, AbortError/TimeoutError names, SQL states and every other failure
 * keep their existing classification; a lease-lost or finished interruption is
 * not a deadline. */
export function eventWritePending(error: unknown, nowMs = Date.now()): EventWritePending | undefined {
  if (error instanceof ProviderDispatchDeferred) return new EventWritePending("deferred", error.deferral.retryAtMs);
  if (error instanceof DeliveryAttemptInterrupted && error.reason === "timeout")
    return new EventWritePending("timeout", nowMs + EVENT_WRITE_PENDING_RETRY_MS);
  return undefined;
}

/** RFC 9110 delay-seconds: whole seconds, never below one, rounded up. */
export function eventWritePendingRetryAfterSeconds(error: EventWritePending, nowMs = Date.now()): number {
  return Math.max(1, Math.ceil((error.retryAtMs - nowMs) / 1000));
}
