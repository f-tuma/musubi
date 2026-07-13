import { Event } from "@musubi/types";
import { create } from "zustand";

// Event-detail modal state, OUT of MainTab's useState on purpose: opening the
// detail from the (heavy) calendar must not re-render the whole tab — only the
// host component that renders the modal subscribes to this store. Writers use
// useEventDetailStore.getState() so they don't subscribe either.
type EventDetailStore = {
  event: Event | null;
  visible: boolean;
  open: (event: Event) => void;
  close: () => void;
};

export const useEventDetailStore = create<EventDetailStore>((set) => ({
  event: null,
  visible: false,
  open: (event) => set({ event, visible: true }),
  close: () => set({ visible: false }), // keep `event` so the close animation has content
}));

// Shared open path: resolve a tapped occurrence to its series master (synthetic
// ids look like "<originalId>_<timestamp>") but keep the tapped occurrence's
// times for display — edit/delete then target the full series. Used by every
// screen that shows events (home, agenda, calendar detail).
export function presentEventDetail(events: Event[], event: Event) {
  const original = events.find(e => e.id === event.id)
    ?? events.find(e => e.id === event.id?.replace(/_\d+$/, ""));
  useEventDetailStore.getState().open(
    original && original.id !== event.id
      ? { ...original, start: event.start, end: event.end }
      : event,
  );
}

// The classic edit composer (AddEventModal, non-docked), same treatment: global
// state + one host, so opening "Edit" doesn't re-render the screen underneath.
type EditComposerStore = {
  prefilled: Event | undefined;
  visible: boolean;
  open: (event?: Event) => void;
  close: () => void;
};

export const useEditComposerStore = create<EditComposerStore>((set) => ({
  prefilled: undefined,
  visible: false,
  open: (event) => set({ prefilled: event, visible: true }),
  close: () => set({ visible: false }),
}));
