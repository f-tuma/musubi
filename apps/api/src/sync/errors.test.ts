// Runnable self-check (no framework): `npx tsx src/sync/errors.test.ts` from
// apps/api. Cases are the real shapes seen in production logs.
import assert from "node:assert";

import { isOptionalTaskError, isTransientSyncError, ProviderAuthError, TaskScopeMissingError } from "./errors";

// undici wraps the DNS failure as a bare "fetch failed" with the code on cause.
const dnsFailure = Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("getaddrinfo EAI_AGAIN www.googleapis.com"), { code: "EAI_AGAIN" }),
});
assert.equal(isTransientSyncError(dnsFailure), true);

const socketClosed = Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("other side closed"), { name: "SocketError" }),
});
assert.equal(isTransientSyncError(socketClosed), true);

// Adapters and tsdav both put the provider's status in the message.
assert.equal(isTransientSyncError(new Error("Outlook 503: Service Unavailable")), true);
assert.equal(isTransientSyncError(new Error("Collection query failed: 500 Internal Server Error. ")), true);
assert.equal(isTransientSyncError(new Error("Google 429 Too Many Requests")), true);
assert.equal(isTransientSyncError(new Error("Could not resolve p145-caldav.icloud.com.")), true);

// A revoked grant is permanent and needs the user to reconnect.
assert.equal(isTransientSyncError(new ProviderAuthError("google", "invalid_grant", undefined, true)), false);
// Anything else from the token endpoint is retryable and keeps the account on.
assert.equal(isTransientSyncError(new ProviderAuthError("google", "token_endpoint_unreachable", undefined, false)), true);
const rejectedFreshToken = new ProviderAuthError("google", "resource_401", undefined, false);
assert.equal(isTransientSyncError(rejectedFreshToken), true);
assert.equal(isOptionalTaskError(rejectedFreshToken), false);
assert.match(rejectedFreshToken.message, /API authentication failed/);

// Our own bugs and the provider's 4xx verdicts must stay visible.
assert.equal(isTransientSyncError(new TypeError("x is not a function")), false);
assert.equal(isTransientSyncError(new Error("Google 404 Not Found")), false);
assert.equal(isTransientSyncError(new Error("cannot find homeUrl")), false);
assert.equal(isTransientSyncError(undefined), false);

assert.equal(isOptionalTaskError(new TaskScopeMissingError()), true);
for (const message of ["Google 403: Forbidden", "Google Tasks 403 Forbidden", "Outlook 503: Unavailable"]) {
  assert.equal(isOptionalTaskError(new Error(message)), true);
}
assert.equal(isOptionalTaskError(dnsFailure), true);
for (const error of [new Error("Google Tasks 401 Unauthorized"), new Error("Outlook 401: Unauthorized"), new TypeError("bug"), new ProviderAuthError("google", "invalid_grant", undefined, true), new ProviderAuthError("microsoft", "token_endpoint_unreachable", undefined, false)]) {
  assert.equal(isOptionalTaskError(error), false);
}

console.log("sync/errors self-check passed");
