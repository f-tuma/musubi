import type { Calendar, Event } from "@musubi/types";
import { describe, expect, it } from "vitest";
import { acceptEventNotice, collectNotifications, connectionNotifications, deliveryNotifications, eventNotifications, type EventChangeNotice } from "./model";

const message = (revision = 3, actorID: string | undefined = "other") => ({ type: "event_updated", payload: { id: "meeting", revision, actorID, title: "Private SSE title" } });
const event = { id: "meeting", revision: 3, title: "Readable title" } as Event;

describe("notification sources", () => {
  it("ignores own, unknown, malformed, duplicate and stale changes", () => {
    expect(acceptEventNotice([], message(3, "me"), "me")).toEqual([]);
    expect(acceptEventNotice([], { type: "event_updated", payload: { id: "meeting", revision: 3 } }, "me")).toEqual([]);
    expect(acceptEventNotice([], message(-1), "me")).toEqual([]);
    const notices = acceptEventNotice([], message(), "me");
    expect(notices).toEqual([{ eventId: "meeting", revision: 3, kind: "event_updated" }]);
    expect(acceptEventNotice(notices, message(), "me")).toBe(notices);
    expect(acceptEventNotice(notices, message(2), "me")).toBe(notices);
    expect(acceptEventNotice(notices, message(4), "me")).toEqual([{ eventId: "meeting", revision: 4, kind: "event_updated" }]);
    expect(notices[0]).not.toHaveProperty("title");
  });
  it("uses current readable titles and drops revoked, stale and removed events", () => {
    const notices = acceptEventNotice([], message(), "me");
    expect(eventNotifications(notices, [event]).items[0].title).toBe("Readable title");
    expect(eventNotifications(notices, []).items).toEqual([]);
    expect(eventNotifications(notices, [{ ...event, revision: 2 }]).items).toEqual([]);
    expect(eventNotifications([{ ...notices[0], kind: "event_removed" }], [event]).items).toEqual([]);
  });
  it("caps session history and replaces one subject rather than stacking its revisions", () => {
    const current: EventChangeNotice[] = Array.from({ length: 100 }, (_, i) => ({ eventId: String(i), revision: 1, kind: "event_updated" }));
    const next = acceptEventNotice(current, message(), "me");
    expect(next).toHaveLength(100);
    expect(next[0].eventId).toBe("meeting");
    expect(next.some(item => item.eventId === "99")).toBe(false);
  });
  it("deduplicates paginated delivery and account sources with independent identities", () => {
    const delivery = deliveryNotifications([{ eventId: "meeting", savedTitle: "Saved title" }, { eventId: "meeting", savedTitle: "Fresh title" }]);
    const calendars = [
      { id: "a", name: "Work", provider: "google", accountId: "work", syncStatus: "reconnect_required" },
      { id: "b", name: "Personal", provider: "google", accountId: "work", syncStatus: "reconnect_required" },
    ] as Calendar[];
    const items = collectNotifications([delivery, eventNotifications(acceptEventNotice([], message(), "me"), [event]), connectionNotifications(calendars)]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: "Fresh title", needsAttention: true, action: { kind: "delivery", eventId: "meeting" } });
    expect(new Set(items.map(item => item.id)).size).toBe(3);
  });
});
