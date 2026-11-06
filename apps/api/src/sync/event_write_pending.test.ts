import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { ProviderDispatchDeferred } from "@musubi/sync-runtime";
import { EventWriteError } from "@musubi/types";

process.env.ENVIRONMENT ??= "test";
process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

// CommonJS test module: the production modules read config at import time.
const modules = Promise.all([import("./delivery_policy"), import("./event_write_pending"), import("../middleware/error_handler")])
  .then(([policy, pending, middleware]) => ({ ...policy, ...pending, ...middleware }));

async function respond(error: Error) {
  const { middlewareErrorHandler } = await modules;
  const headers = new Map<string, string>(); let status = 0, body: Record<string, unknown> | undefined;
  const res = { setHeader(name: string, value: string) { headers.set(name.toLowerCase(), String(value)); return res; },
    status(code: number) { status = code; return res; }, json(value: Record<string, unknown>) { body = value; return res; } } as unknown as Response;
  const req = { requestId: "fixture-request", method: "POST", route: { path: "/events" }, user: { id: "fixture-user" } } as unknown as Request;
  middlewareErrorHandler(error, req, res, (() => {}) as NextFunction);
  return { status, headers, body: body! };
}

test("the actual bounded deadline yields the typed timeout and maps to a default retry hint", async () => {
  const { DeliveryAttemptInterrupted, withDeliveryDeadline, EVENT_WRITE_PENDING_RETRY_MS, EventWritePending, eventWritePending } = await modules;
  const caught = await withDeliveryDeadline(() => new Promise<never>(() => {}), { timeoutMs: 5 }).then(() => undefined, (error: unknown) => error);
  assert.ok(caught instanceof DeliveryAttemptInterrupted && caught.reason === "timeout");
  const pending = eventWritePending(caught, 1_000_000);
  assert.ok(pending instanceof EventWritePending);
  assert.equal(pending.reason, "timeout"); assert.equal(pending.retryAtMs, 1_000_000 + EVENT_WRITE_PENDING_RETRY_MS);
  assert.equal(pending.code, "provider-busy");
  assert.equal(pending.message, "Calendar writing is temporarily unavailable. No changes were saved. Try again shortly.");
});

test("a pre-dispatch scheduler or budget deferral keeps its exact eligibility", async () => {
  const { eventWritePending } = await modules;
  for (const reason of ["work-capacity", "cooldown", "credit", "budget-persistence-pending"] as const) {
    const pending = eventWritePending(new ProviderDispatchDeferred({ retryAtMs: 1_700_000_123_456, reason, blockedDimensions: [] }), 0);
    assert.ok(pending); assert.equal(pending.reason, "deferred"); assert.equal(pending.retryAtMs, 1_700_000_123_456);
  }
});

test("only the two typed classes qualify; lookalike timeouts, network codes and SQL states stay unclassified", async () => {
  const { DeliveryAttemptInterrupted, EventWritePending, eventWritePending } = await modules;
  const timeoutName = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const lookalikes: unknown[] = [
    Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    new Error("Delivery attempt timeout."),
    new Error("Provider dispatch deferred."),
    Object.assign(new Error("Provider dispatch deferred."), { deferral: { retryAtMs: 1, reason: "work-capacity", blockedDimensions: [] } }),
    timeoutName,
    new DOMException("aborted", "AbortError"),
    new DeliveryAttemptInterrupted("lease-lost"),
    new DeliveryAttemptInterrupted("finished"),
    Object.assign(new Error("deadlock"), { code: "40P01" }),
    new EventWriteError("event-write", "unknown"),
    undefined, null, "timeout",
  ];
  for (const error of lookalikes) assert.equal(eventWritePending(error), undefined);
  assert.throws(() => new EventWritePending("timeout", -1), RangeError);
  assert.throws(() => new EventWritePending("timeout", 0.5), RangeError);
});

test("Retry-After is whole seconds rounded up and never below one", async () => {
  const { EventWritePending, eventWritePendingRetryAfterSeconds } = await modules;
  assert.equal(eventWritePendingRetryAfterSeconds(new EventWritePending("deferred", 10_000), 9_999), 1);
  assert.equal(eventWritePendingRetryAfterSeconds(new EventWritePending("deferred", 10_000), 10_000), 1);
  assert.equal(eventWritePendingRetryAfterSeconds(new EventWritePending("deferred", 10_000), 20_000), 1);
  assert.equal(eventWritePendingRetryAfterSeconds(new EventWritePending("deferred", 11_001), 10_000), 2);
  assert.equal(eventWritePendingRetryAfterSeconds(new EventWritePending("timeout", 15_000), 10_000), 5);
  assert.equal(eventWritePendingRetryAfterSeconds(new EventWritePending("deferred", 130_000), 10_000), 120);
});

test("the HTTP contract is 503 + Retry-After, provider-busy, localCommitted false and an ISO retryAt", async () => {
  const { EventWritePending } = await modules;
  const retryAtMs = Date.now() + 4_200;
  const { status, headers, body } = await respond(new EventWritePending("deferred", retryAtMs));
  assert.equal(status, 503);
  assert.ok(["4", "5"].includes(headers.get("retry-after")!), headers.get("retry-after"));
  assert.deepEqual(body, { error: "Calendar writing is temporarily unavailable. No changes were saved. Try again shortly.",
    code: "provider-busy", localCommitted: false, retryAt: new Date(retryAtMs).toISOString(), requestId: "fixture-request" });
  const past = await respond(new EventWritePending("timeout", 1));
  assert.equal(past.status, 503); assert.equal(past.headers.get("retry-after"), "1");
  // Unchanged neighbours: the fail-closed preflight refusal stays a 403 without the pending fields.
  const refusal = await respond(new EventWriteError("event-write", "unknown"));
  assert.equal(refusal.status, 403); assert.equal(refusal.headers.has("retry-after"), false);
  assert.deepEqual(refusal.body, { error: "Event writing is unknown. No changes were saved.", reason: "unknown", capability: "event-write", requestId: "fixture-request" });
});
