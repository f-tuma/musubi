import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ProviderDispatchDeferred } from "@musubi/sync-runtime";
import { ProviderAuthError } from "./errors";
import { ReadAttemptInterrupted } from "./read_attempt";
import { SyncWorkDeferred } from "./sync_outcome";
import { describeSyncWorkFailure, type SyncWorkFailureContext } from "./work_failure";

const context = { phase: "execute", family: "pull" } as const;
const budget = new ProviderDispatchDeferred({ retryAtMs: 1000, reason: "credit", blockedDimensions: ["account"] });
assert.deepEqual(describeSyncWorkFailure(budget, context), {
  level: "warn", fields: { code: "sync-work-unavailable", phase: "execute", family: "pull", reason: "deferred", deferralReason: "credit" },
});
assert.equal(describeSyncWorkFailure(new SyncWorkDeferred(1000)).fields.deferralReason, "queued-read");
for (const counterfeit of [
  Object.assign(new Error("Provider dispatch deferred."), { name: "ProviderDispatchDeferred", deferral: budget.deferral }),
  { name: "SyncWorkDeferred", message: "Synchronization is pending a later opportunity.", retryAtMs: 1000 },
  Object.assign(new Error("Wrapped failure"), { cause: budget }),
]) assert.equal(describeSyncWorkFailure(counterfeit).level, "error", "Only an explicit top-level deferral lowers severity");

for (const [message, reason] of [
  ["Cannot park an inactive work permit.", "work-permit-inactive"],
  ["Cannot dispatch HTTP under an inactive work permit.", "work-permit-inactive"],
  ["Work execution finished while HTTP was queued.", "work-execution-finished"],
  ["Provider budget connection changed.", "budget-connection-changed"],
  ["Provider execution budget context is closed.", "budget-context-closed"],
  ["Sync read work source or claim changed.", "read-work-changed"],
  ["Sync read source changed.", "read-source-changed"],
  ["Sync read lease lost before budget wait.", "read-lease-lost"],
] as const) {
  const result = describeSyncWorkFailure(new Error(message), context);
  assert.equal(result.level, "error"); assert.equal(result.fields.reason, reason);
}
for (const readFence of ["source-or-claim-changed", "missing-work-row", "current-binding-mismatch", "captured-binding-mismatch", "checkpoint-mismatch", "claim-guard-failed"] as const) {
  const error = Object.assign(new Error("Sync read work source or claim changed."), { cause: {
    code: "sync-read-work-changed", reason: readFence, sourceID: "private-source", capturedCursor: "private-cursor", accountID: "private-account",
  } });
  const result = describeSyncWorkFailure(error, context);
  assert.deepEqual(result, { level: "error", fields: { code: "sync-work-unavailable", phase: "execute", family: "pull", reason: "read-work-changed", readFence } });
  assert.equal(JSON.stringify(result).includes("private-"), false);
}
for (const [reason, expected] of [["idle", "read-idle"], ["lease-lost", "read-lease-lost"], ["cancelled", "read-cancelled"], ["finished", "read-finished"]] as const) {
  assert.equal(describeSyncWorkFailure(new ReadAttemptInterrupted(reason)).fields.reason, expected);
}
assert.equal(describeSyncWorkFailure(new DOMException("private abort details", "AbortError")).fields.reason, "aborted");
assert.equal(describeSyncWorkFailure(new DOMException("private deadline details", "TimeoutError")).fields.reason, "deadline");
assert.equal(describeSyncWorkFailure(new ProviderAuthError("google", "private grant details", undefined, true)).level, "error");
assert.equal(describeSyncWorkFailure(new ProviderAuthError("google", "private grant details", undefined, true)).fields.reason, "provider-authentication");

const privateValue = "SENTINEL_private_sql_token_account_payload_894218";
const databaseError = Object.assign(new Error(privateValue), { code: "40001", detail: privateValue, query: privateValue, parameters: [privateValue] });
assert.deepEqual(describeSyncWorkFailure(Object.assign(new Error(privateValue), { cause: databaseError }), { phase: "candidates" }), {
  level: "error", fields: { code: "sync-work-unavailable", phase: "candidates", reason: "database-error", sqlState: "40001" },
});
const network = Object.assign(new Error(privateValue), { code: "ECONNRESET" });
assert.equal(describeSyncWorkFailure(Object.assign(new Error(privateValue), { cause: network })).fields.networkCode, "ECONNRESET");
assert.equal(describeSyncWorkFailure(Object.assign(new Error(privateValue), { cause: network })).level, "error");
const provider = Object.assign(new Error(privateValue), { name: "GraphTaskListDiscoveryHttpError", cause: { httpStatus: 400, graphCode: privateValue, url: privateValue } });
assert.equal(describeSyncWorkFailure(provider).fields.httpStatus, 400);
assert.equal(describeSyncWorkFailure(provider).level, "error");

const privateError = Object.assign(new Error(privateValue), {
  name: privateValue, stack: privateValue, code: "SECRT", token: privateValue, accountID: privateValue, query: privateValue, params: [privateValue],
  cause: { message: privateValue, name: privateValue, code: privateValue, httpStatus: privateValue, url: privateValue },
});
const unsafeContext = { phase: privateValue, family: privateValue, request: privateValue } as unknown as SyncWorkFailureContext;
const diagnostic = describeSyncWorkFailure(privateError, unsafeContext);
assert.deepEqual(diagnostic, { level: "error", fields: {
  code: "sync-work-unavailable", phase: "unknown", reason: "unknown", messageFingerprint: createHash("sha256").update(privateValue).digest("hex"),
} });
assert.equal(JSON.stringify(diagnostic).includes(privateValue), false);
assert.equal("sqlState" in diagnostic.fields, false, "Unknown five-character codes must not become telemetry labels");
assert.equal("family" in describeSyncWorkFailure(new Error("x"), { phase: "candidates", family: "pull" }).fields, false);
for (const cause of [{ code: "sync-read-work-changed", reason: privateValue }, { code: privateValue, reason: "checkpoint-mismatch" }]) {
  const result = describeSyncWorkFailure(Object.assign(new Error("Sync read work source or claim changed."), { cause }));
  assert.equal(result.fields.reason, "read-work-changed"); assert.equal("readFence" in result.fields, false);
  assert.equal(JSON.stringify(result).includes(privateValue), false);
}

let getters = 0;
const opaque = new Error();
for (const key of ["name", "message", "stack", "cause", "code", "url", "query", "accountID"])
  Object.defineProperty(opaque, key, { configurable: true, get() { getters++; throw new Error(privateValue); } });
assert.deepEqual(describeSyncWorkFailure(opaque), { level: "error", fields: { code: "sync-work-unavailable", phase: "unknown", reason: "unknown" } });
assert.equal(getters, 0, "Failure reporting must not evaluate arbitrary exception accessors");
const accessorDeferral = new SyncWorkDeferred(1000);
Object.defineProperty(accessorDeferral, "retryAtMs", { get() { getters++; throw new Error(privateValue); } });
assert.equal(describeSyncWorkFailure(accessorDeferral).level, "error");
const malformedBudget = new ProviderDispatchDeferred({ retryAtMs: 1000, reason: "credit", blockedDimensions: [] });
Object.defineProperty(malformedBudget, "deferral", { value: { retryAtMs: 1000, reason: privateValue, url: privateValue } });
assert.equal(describeSyncWorkFailure(malformedBudget).level, "error");
assert.equal(JSON.stringify(describeSyncWorkFailure(malformedBudget)).includes(privateValue), false);
assert.equal(getters, 0);
const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(privateValue); }, getOwnPropertyDescriptor() { throw new Error(privateValue); } });
assert.doesNotThrow(() => describeSyncWorkFailure(proxy));
const circular = new Error(privateValue); Object.assign(circular, { cause: circular });
assert.equal(describeSyncWorkFailure(circular).fields.reason, "unknown");
for (const thrown of [undefined, null, privateValue, 5, Symbol(privateValue)]) {
  const result = describeSyncWorkFailure(thrown);
  assert.equal(result.level, "error"); assert.equal(result.fields.reason, "unknown");
  assert.equal(JSON.stringify(result).includes(privateValue), false);
}
const huge = describeSyncWorkFailure(new Error(privateValue.repeat(10000)));
assert.match(huge.fields.messageFingerprint!, /^[a-f0-9]{64}$/);
assert.equal(huge.fields.messageFingerprintTruncated, true);
assert.equal(JSON.stringify(huge).includes(privateValue), false);
console.log("sync work failure diagnostics: PASS");
