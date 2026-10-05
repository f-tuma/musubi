import { EventSchema, TaskMutationResponseSchema } from "@musubi/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerDiagnostics } from "@/lib/serverDiagnostics";
import { z } from "zod";
import { EventsResponse, readWire, wireTimestamp } from "./wire";

const event = {
  calendars: ["home"],
  color: "#c8553d",
  creatorID: "user-1",
  end: "2026-08-20T11:00:00.000Z",
  hasAttendees: false,
  id: "event-1",
  isAllDay: false,
  isCanceled: false,
  organizer: "user-1",
  start: "2026-08-20T10:00:00.000Z",
  title: "Review",
};

const withDev = (value: boolean, run: () => void) => {
  const globals = globalThis as { __DEV__?: boolean };
  const before = globals.__DEV__;
  globals.__DEV__ = value;
  try {
    run();
  } finally {
    globals.__DEV__ = before;
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readWire", () => {
  it("converts what the type has always claimed", () => {
    const before = getServerDiagnostics();
    const parsed = readWire(EventSchema, event, "GET /events");

    // Assert the silence too. A fixture missing a required field takes the
    // degrade path, and without this the test reads as a pass.
    expect(getServerDiagnostics()).toBe(before);

    // The point of parsing, not a side effect of it: this arrives as a string
    // and every caller used to rebuild the Date by hand, or forget to.
    expect(parsed.start).toBeInstanceOf(Date);
    expect(parsed.start.toISOString()).toBe("2026-08-20T10:00:00.000Z");
    expect(parsed.title).toBe("Review");
  });

  it("hands back a mismatch rather than refusing to render", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const older = { ...event, title: undefined };

    // A self-hosted server older than the app is ordinary, not exceptional.
    // Throwing here would kill the screen for exactly those people.
    withDev(false, () => {
      const parsed = readWire(EventSchema, older, "GET /events");
      expect(parsed).toBe(older);
    });

    // But it must not be silent, or the app is back where it started.
    expect(getServerDiagnostics()).toContain("GET /events does not match");
    expect(getServerDiagnostics()).toContain("title");
  });

  it("rejects a required mutation receipt in production while ordinary reads still degrade", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    withDev(false, () => {
      expect(() => readWire(TaskMutationResponseSchema, { task: null, localCommitted: false },
        "POST /task-mutations", { requireValid: true })).toThrow("The server did not confirm the change");
      expect(readWire(TaskMutationResponseSchema, { task: null, localCommitted: true },
        "POST /task-mutations", { requireValid: true })).toEqual({ task: null, localCommitted: true });
    });
  });

  it("throws where it can still be fixed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    withDev(true, () => {
      expect(() =>
        readWire(EventSchema, { ...event, start: "not a date" }, "GET /events"),
      ).toThrow(/GET \/events does not match this build/);
    });
  });
});

describe("wireTimestamp", () => {
  // Better Auth's client revives every ISO-8601 string into a Date before any
  // schema runs, so `GET /events` handed `serverTime` over as a Date and the
  // shared `z.string()` refused it — on the phone only.
  const response = z.object({ serverTime: wireTimestamp });

  it("takes the Date this transport actually delivers", () => {
    const parsed = response.parse({
      serverTime: new Date("2026-08-20T10:00:00.000Z"),
    });
    expect(parsed.serverTime).toBe("2026-08-20T10:00:00.000Z");
  });

  it("still takes the string the wire carries", () => {
    const parsed = response.parse({ serverTime: "2026-08-20T10:00:00.000Z" });
    expect(parsed.serverTime).toBe("2026-08-20T10:00:00.000Z");
  });
});

describe("GET /events", () => {
  it("survives a payload whose timestamps arrived revived", () => {
    // Exactly what Better Auth's parser hands over: every ISO-8601 string in
    // the body is already a Date. Written as Dates rather than run through the
    // real parser, which is not a public export — the shape is the point.
    const parsed = readWire(
      EventsResponse,
      {
        deletedIds: [],
        events: [
          {
            ...event,
            end: new Date(event.end),
            start: new Date(event.start),
          },
        ],
        serverTime: new Date("2026-08-20T12:00:00.000Z"),
      },
      "GET /events",
    );

    // A string, because that is what `setLastSync` stores and what expo-sqlite
    // on iOS can bind.
    expect(parsed.serverTime).toBe("2026-08-20T12:00:00.000Z");
    expect(parsed.events[0]!.start).toBeInstanceOf(Date);
  });
});
