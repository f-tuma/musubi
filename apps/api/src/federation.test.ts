import assert from "node:assert/strict";
import {
  MEMBER_TOKEN_ROTATION_WINDOW_MS,
  MEMBER_TOKEN_TTL_MS,
  memberTokenExpiresAt,
  memberTokenIssuedAt,
  shouldRotateMemberToken,
} from "@musubi/types";
import { canonicalHttpOrigin } from "./federation_origin";
import {
  bearerMemberToken,
  hashMemberToken,
  issueMemberToken,
} from "./federation_tokens";
import { buildInvitePreview } from "./invite_preview";

const now = new Date("2026-07-23T12:00:00.000Z");
const issued = issueMemberToken(now);
assert.match(issued.raw, /^mt1_[0-9a-z]+_[0-9a-f]{64}$/);
assert.equal(memberTokenIssuedAt(issued.raw)?.toISOString(), now.toISOString());
assert.equal(
  memberTokenExpiresAt(issued.raw)?.getTime(),
  now.getTime() + MEMBER_TOKEN_TTL_MS,
);
assert.equal(issued.expiresAt.getTime(), now.getTime() + MEMBER_TOKEN_TTL_MS);
assert.equal(shouldRotateMemberToken(issued.raw, now), false);
assert.equal(
  shouldRotateMemberToken(
    issued.raw,
    new Date(issued.expiresAt.getTime() - MEMBER_TOKEN_ROTATION_WINDOW_MS),
  ),
  true,
);
assert.equal(shouldRotateMemberToken("legacy-token", now), true);
assert.equal(hashMemberToken(issued.raw).length, 64);
assert.equal(bearerMemberToken(`Bearer ${issued.raw}`), issued.raw);
assert.equal(bearerMemberToken("Basic nope"), null);

assert.equal(canonicalHttpOrigin("https://calendar.example"), "https://calendar.example");
assert.equal(canonicalHttpOrigin("http://localhost:7531"), "http://localhost:7531");
for (const unsafe of [
  "ftp://calendar.example",
  "https://user:pass@calendar.example",
  "https://calendar.example/path",
  "https://calendar.example/?query=1",
  "not a url",
]) {
  assert.equal(canonicalHttpOrigin(unsafe), null);
}

const member = {
  user: {
    id: "member-1",
    name: "Member",
    email: "private@example.test",
    image: null,
  },
};
const event = (overrides: Record<string, unknown> = {}) => ({
  events: {
    id: "event-current",
    title: "Visible title",
    color: "#123456",
    start: new Date("2026-07-24T12:00:00.000Z"),
    end: new Date("2026-07-24T13:00:00.000Z"),
    isAllDay: false,
    recurrence: null,
    deletedAt: null,
    description: "must not leak",
    location: "must not leak",
    ...overrides,
  },
});
const preview = buildInvitePreview(
  { id: "calendar-1", name: "Shared", color: "#abcdef" },
  [member],
  [
    event(),
    event({
      id: "event-past",
      start: new Date("2026-07-01T12:00:00.000Z"),
      end: new Date("2026-07-01T13:00:00.000Z"),
    }),
    event({
      id: "event-future",
      start: new Date("2026-09-01T12:00:00.000Z"),
      end: new Date("2026-09-01T13:00:00.000Z"),
    }),
    event({ id: "event-recurring", recurrence: "FREQ=WEEKLY" }),
    event({ id: "event-deleted", deletedAt: now }),
  ],
  now,
);

assert.deepEqual(preview.members, [{ id: "member-1", name: "Member", image: null }]);
assert.ok(preview.events.some((item) => item.id === "event-current"));
assert.ok(preview.events.some((item) => item.id.startsWith("event-recurring_")));
assert.equal(preview.events.some((item) => item.id === "event-past"), false);
assert.equal(preview.events.some((item) => item.id === "event-future"), false);
assert.equal(preview.events.some((item) => item.id === "event-deleted"), false);
assert.ok(preview.events.every((item) =>
  item.end >= now
  && item.start <= new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  && item.recurrence === null,
));
assert.equal(Object.prototype.hasOwnProperty.call(preview.members[0], "email"), false);
assert.equal(Object.prototype.hasOwnProperty.call(preview.events[0], "description"), false);
assert.equal(Object.prototype.hasOwnProperty.call(preview.events[0], "location"), false);

console.log("federation security self-check: OK");
