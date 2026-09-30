import assert from "node:assert/strict";
import type { Request } from "express";
import { BadRequestError } from "@musubi/types";
import { eventStreamPayload, parseAttendanceBody, parseEventReadQuery } from "./events";

assert.deepEqual(eventStreamPayload({ id: "event", revision: 2, actorID: "untrusted" }, "authenticated"), {
  id: "event", revision: 2, actorID: "authenticated",
});
assert.deepEqual(eventStreamPayload({ id: "event", revision: 2 }, "authenticated"), {
  id: "event", revision: 2, actorID: "authenticated",
});

const query = (value: Record<string, string>) => value as Request["query"];

assert.deepEqual(
  parseEventReadQuery(query({ since: "2026-07-01T00:00:00.000Z" })),
  { since: new Date("2026-07-01T00:00:00.000Z") },
);
assert.deepEqual(
  parseEventReadQuery(query({
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
  })),
  {
    start: new Date("2026-07-01T00:00:00.000Z"),
    end: new Date("2026-08-01T00:00:00.000Z"),
    since: undefined,
  },
);
assert.throws(
  () => parseEventReadQuery(query({
    since: "2026-07-15T00:00:00.000Z",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
  })),
  (error: unknown) =>
    error instanceof BadRequestError &&
    error.message === "since cannot be combined with start and end.",
);
assert.throws(
  () => parseEventReadQuery(query({
    start: "2026-01-01T00:00:00.000Z",
    end: "2030-01-01T00:00:00.000Z",
  })),
  (error: unknown) =>
    error instanceof BadRequestError &&
    error.message === "Requested event range is too large.",
);

console.log("event read query self-check: OK");

// ── Attendance ───────────────────────────────────────────────────────────────
assert.equal(parseAttendanceBody({ status: "going" }), "going");
assert.equal(parseAttendanceBody({ status: "maybe" }), "maybe");
assert.equal(parseAttendanceBody({ status: "declined" }), "declined");
assert.equal(parseAttendanceBody({ status: "none" }), "none");
// The build on Play sends a boolean. Deploying the API must not wait on a store
// review, so the old shape keeps working.
assert.equal(parseAttendanceBody({ attending: true }), "going");
assert.equal(parseAttendanceBody({ attending: false }), "none");
// Status wins if a client sends both.
assert.equal(parseAttendanceBody({ attending: false, status: "maybe" }), "maybe");
assert.throws(
  () => parseAttendanceBody({ status: "perhaps" }),
  (error: unknown) => error instanceof BadRequestError,
);
assert.throws(
  () => parseAttendanceBody({}),
  (error: unknown) => error instanceof BadRequestError,
);
assert.throws(
  () => parseAttendanceBody(undefined),
  (error: unknown) => error instanceof BadRequestError,
);
