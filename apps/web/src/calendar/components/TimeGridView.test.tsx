import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TimeGridView } from "./TimeGridView";
import { fixtureCalendars, fixtureEvents } from "../fixtures";
import { createTimeGeometry } from "../time-geometry";
vi.mock("./EventDetailsPopover", () => ({ EventDetailsPopover: ({ children }: { children: ReactNode }) => children }));
afterEach(cleanup);
const geometry = createTimeGeometry();
function props(date = "2026-10-25"): ComponentProps<typeof TimeGridView> {
  return { anchor: new Date(`${date}T12:00:00`), calendars: fixtureCalendars, events: [], geometry, view: "day", timeFormat: "24h", weekStartsOn: "monday", getEventMaster: event => event, onForkEvent: vi.fn(), onLinkEvent: vi.fn(), onNotice: vi.fn(), onRemoveEvent: vi.fn(), onSetAttendance: vi.fn(), onUpdateEvent: vi.fn(), user: { id: "alex", name: "Alex" } };
}
it.each([[150, "00"], [210, "01"]])("creates exact fold from row %s and keeps the draft aligned", (row, hour) => {
  const onCreateAtTime = vi.fn();
  const view = render(<TimeGridView {...props()} onCreateAtTime={onCreateAtTime} />);
  const column = view.container.querySelector('[data-time-grid-column]')!;
  fireEvent.click(column, { clientY: Number(row) * geometry.pxPerMinute });
  const exactRange = onCreateAtTime.mock.calls[0]![4];
  expect(exactRange.start.toISOString()).toBe(`2026-10-25T${hour}:30:00.000Z`);
  view.rerender(<TimeGridView {...props()} pendingCreate={{ date: "2026-10-25", startTime: "02:30", exactRange }} />);
  const draft = view.container.querySelector('[aria-hidden="true"][data-time-grid-selection]') as HTMLElement;
  expect(parseFloat(draft.style.getPropertyValue("--event-top"))).toBeCloseTo(Number(row) * geometry.pxPerMinute);
});
it("refuses a spring week hole without cancelling the previous draft", () => {
  const onCreateAtTime = vi.fn(), onCancelDraft = vi.fn();
  const view = render(<TimeGridView {...props("2026-03-29")} view="week" onCreateAtTime={onCreateAtTime} onCancelDraft={onCancelDraft} />);
  const column = view.container.querySelector('[data-time-grid-column="2026-03-29"]')!;
  fireEvent.pointerDown(column, { button: 0, clientY: 150 * geometry.pxPerMinute });
  fireEvent.click(column, { clientY: 150 * geometry.pxPerMinute });
  expect(onCreateAtTime).not.toHaveBeenCalled(); expect(onCancelDraft).not.toHaveBeenCalled();
  expect(column.querySelector('[data-time-axis-hole]')).toBeTruthy();
});
it("links cross-hole pieces with one focus identity and only the true outside resize edges", () => {
  const event = { ...fixtureEvents[0]!, id: "linked", title: "Linked meeting", start: new Date("2026-10-24T00:30:00Z"), end: new Date("2026-10-24T01:30:00Z"), isAllDay: false };
  const view = render(<TimeGridView {...props()} view="week" events={[event]} onMoveEvent={vi.fn()} />);
  const button = screen.getByRole("button", { name: /Linked meeting/ });
  const pieces = button.querySelectorAll('[data-linked-segment]');
  expect(pieces).toHaveLength(2);
  expect(button.querySelectorAll('[data-resize-handle="start"]:not([hidden])')).toHaveLength(1);
  expect(button.querySelectorAll('[data-resize-handle="end"]:not([hidden])')).toHaveLength(1);
  expect(view.container.querySelectorAll('[data-time-event="linked"]')).toHaveLength(1);
});
it("keyboard movement selects the second repeated occurrence exactly", async () => {
  const onMoveEvent = vi.fn<NonNullable<ComponentProps<typeof TimeGridView>["onMoveEvent"]>>(async () => undefined);
  const event = { ...fixtureEvents[0]!, title: "Fold move", start: new Date("2026-10-25T00:45:00Z"), end: new Date("2026-10-25T01:00:00Z"), isAllDay: false };
  render(<TimeGridView {...props()} events={[event]} onMoveEvent={onMoveEvent} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /Fold move/ }), { key: "ArrowDown", altKey: true });
  expect(onMoveEvent.mock.calls[0]![0]).toMatchObject({ start: new Date("2026-10-25T01:00:00Z"), end: new Date("2026-10-25T01:15:00Z") });
});
it("keyboard slot creation reaches each repeated occurrence", () => {
  const onCreateAtTime = vi.fn();
  const view = render(<TimeGridView {...props()} onCreateAtTime={onCreateAtTime} />);
  const column = view.container.querySelector('[data-time-grid-column]')!;
  // Civil 07:00 is physical row 480 on this 25-hour day.
  for (let index = 0; index < 22; index++) fireEvent.keyDown(column, { key: "ArrowUp" });
  fireEvent.keyDown(column, { key: "Enter" });
  expect(onCreateAtTime.mock.calls[0]![4].start.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  for (let index = 0; index < 4; index++) fireEvent.keyDown(column, { key: "ArrowDown" });
  fireEvent.keyDown(column, { key: "Enter" });
  expect(onCreateAtTime.mock.calls[1]![4].start.toISOString()).toBe("2026-10-25T01:30:00.000Z");
});
it("does not expand a short event into a reserved week hole", () => {
  const event = { ...fixtureEvents[0]!, title: "Short meeting", start: new Date("2026-10-24T00:59:00Z"), end: new Date("2026-10-24T01:00:00Z"), isAllDay: false };
  render(<TimeGridView {...props()} view="week" events={[event]} />);
  const piece = screen.getByRole("button", { name: /Short meeting/ }).firstElementChild as HTMLElement;
  expect(piece.style.getPropertyValue("--piece-height")).toBe("100%");
  expect(parseFloat((piece.parentElement as HTMLElement).style.getPropertyValue("--event-height"))).toBeCloseTo(geometry.pxPerMinute);
});
it("keeps zero-duration imported events visible", () => {
  const event = { ...fixtureEvents[0]!, title: "Instant event", start: new Date("2026-10-25T01:30:00Z"), end: new Date("2026-10-25T01:30:00Z"), isAllDay: false };
  render(<TimeGridView {...props()} events={[event]} />);
  expect(screen.getByRole("button", { name: /Instant event/ }).firstElementChild).toBeTruthy();
});
it("resizes cross-midnight events only at their real outside edges", () => {
  const event = { ...fixtureEvents[0]!, title: "Overnight", start: new Date("2026-10-23T21:00:00Z"), end: new Date("2026-10-23T23:00:00Z"), isAllDay: false };
  const onMoveEvent = vi.fn();
  render(<TimeGridView {...props()} view="week" events={[event]} onMoveEvent={onMoveEvent} />);
  const [first, second] = screen.getAllByRole("button", { name: /Overnight/ });
  expect(first!.querySelector('[data-resize-handle="end"]:not([hidden])')).toBeNull();
  expect(second!.querySelector('[data-resize-handle="start"]:not([hidden])')).toBeNull();
  expect(second!.querySelector('[data-resize-handle="end"]:not([hidden])')).toBeTruthy();
  fireEvent.keyDown(first!, { key: "ArrowDown", altKey: true, shiftKey: true });
  expect(onMoveEvent).not.toHaveBeenCalled();
});
it("moving an overnight draft preserves the end clock after midnight", async () => {
  const onMoveDraft = vi.fn();
  const exactRange = { start: new Date("2026-10-24T21:00:00Z"), end: new Date("2026-10-24T23:00:00Z") };
  const view = render(<TimeGridView {...props("2026-10-24")} geometry={{ ...geometry, pxPerMinute: 1, hourHeight: 60 }} pendingCreate={{ date: "2026-10-24", startTime: "23:00", endTime: "01:00", exactRange }} onMoveDraft={onMoveDraft} />);
  const draft = view.container.querySelector('[data-draft]')!;
  function pointer(target: Element | Window, type: string, y: number) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 70, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(target, event);
  }
  pointer(draft, "pointerdown", 1380);
  pointer(window, "pointermove", 1365);
  pointer(window, "pointerup", 1365);
  await waitFor(() => expect(onMoveDraft).toHaveBeenCalledOnce());
  expect(onMoveDraft.mock.calls[0]![0]).toMatchObject({ date: "2026-10-24", startTime: "22:45", endTime: "00:45", exactRange: { start: new Date("2026-10-24T20:45:00Z"), end: new Date("2026-10-24T22:45:00Z") } });
});
