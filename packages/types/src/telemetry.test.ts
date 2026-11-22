import assert from "node:assert/strict";
import { scrubBreadcrumb, scrubTelemetry } from "./telemetry";

const circular: Record<string, unknown> = { name: "loop" };
circular.self = circular;

const event = scrubTelemetry({
  transaction: "GET /api/v1/calendars/tokens/:token",
  request: {
    url: "https://musubi.example/invite/abcDEF123?ref=mail",
    query_string: "code=oauth-code&state=s",
    headers: { Authorization: "Bearer x", cookie: "session=y", "user-agent": "UA" },
  },
  breadcrumbs: [
    { category: "fetch", data: { url: "/api/v1/calendars/tokens/member-secret", method: "GET" } },
    { category: "navigation", data: { from: "/login", to: "/app/p/page-1/week#focus" } },
  ],
  exception: { values: [{ value: "GET https://accounts.example/callback?code=abc failed" }] },
  spans: [{ description: "GET https://www.googleapis.com/calendar/v3/events?pageToken=t", data: { "url.query": "?a=1", "db.statement": "select $1" } }],
  sdkProcessingMetadata: { normalizedRequest: { url: "/invite/kept-internal" } },
  extra: { circular },
});

assert.equal(event.transaction, "GET /api/v1/calendars/tokens/:token", "route patterns stay readable");
assert.equal(event.request.url, "https://musubi.example/invite/[redacted]");
assert.equal("query_string" in event.request, false);
assert.equal(event.request.headers.Authorization, "[redacted]");
assert.equal(event.request.headers.cookie, "[redacted]");
assert.equal(event.request.headers["user-agent"], "UA");
assert.equal(event.breadcrumbs[0]!.data.url, "/api/v1/calendars/tokens/[redacted]");
assert.equal(event.breadcrumbs[1]!.data.to, "/app/p/page-1/week");
assert.equal(event.exception.values[0]!.value, "GET https://accounts.example/callback failed");
assert.equal(event.spans[0]!.description, "GET https://www.googleapis.com/calendar/v3/events");
assert.deepEqual(event.spans[0]!.data, { "db.statement": "select $1" });
assert.equal(event.sdkProcessingMetadata.normalizedRequest.url, "/invite/kept-internal", "SDK internals untouched");
assert.equal(circular.self, circular);

// DOM descriptions (click breadcrumbs, INP span names) drop labels with event titles.
assert.equal(
  scrubTelemetry({ message: 'div.grid > button.event[aria-label="Dentist "Dr. X", 9:00, Family"]' }).message,
  "div.grid > button.event",
);

// Console breadcrumbs carry live app objects: never rewritten, only detached.
const conflict = { url: "https://zoom.us/j/1?pwd=abc" };
const crumb = scrubBreadcrumb({ category: "console", message: "API error", data: { arguments: ["API error", conflict] } });
assert.equal(conflict.url, "https://zoom.us/j/1?pwd=abc");
assert.equal("data" in crumb, false);
console.log("telemetry scrub: ok");
