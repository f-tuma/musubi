import type { Calendar, Event } from "@musubi/types";
import { describe, expect, it } from "vitest";
import { acceptEventNotice, collectNotifications, connectionNotifications, deliveryNotifications, eventNotifications, type EventChangeNotice } from "./model";
import { TaskSchema } from "@musubi/types";
import { acceptTaskNotice, taskNotifications, taskDeliveryNotifications } from "./model";

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

it("deduplicates shared task activity, never infers an actor, and drops revoked content", () => {
  const frame = { type: "task_updated", payload: { id: "shared", revision: 4, actorID: "other", title: "Private frame title" } };
  const notices = acceptTaskNotice([], frame, "me");
  expect(acceptTaskNotice(notices, frame, "me")).toBe(notices);
  expect(acceptTaskNotice(notices, { ...frame, payload: { ...frame.payload, revision: 3 } }, "me")).toBe(notices);
  expect(acceptTaskNotice([], { ...frame, payload: { ...frame.payload, actorID: "me" } }, "me")).toEqual([]);
  expect(acceptTaskNotice([], { type: "task_updated", payload: { id: "shared", revision: 4, creatorID: "other" } }, "me")).toEqual([]);
  expect(notices[0]).not.toHaveProperty("title");
  const task = TaskSchema.parse({ id: "shared", calendarID: "home", creatorID: "other", revision: 4, title: "Authorized task", status: "completed" });
  expect(taskNotifications(notices, [task]).items[0]).toMatchObject({ title: task.title, detail: "Changed by another member", action: { kind: "task", taskId: task.id } });
  expect(taskNotifications(notices, [{ ...task, revision: 3 }]).items).toEqual([]);
  expect(taskNotifications(notices, []).items).toEqual([]);
  const items = collectNotifications([taskNotifications(notices, [task]), taskDeliveryNotifications([{ taskId: task.id, savedTitle: task.title }])]);
  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ needsAttention: true, action: { kind: "task-delivery" } });
});
