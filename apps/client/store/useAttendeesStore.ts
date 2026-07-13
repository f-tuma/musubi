import { Attendee } from "@/services/api";
import { create } from "zustand";

// Ephemeral attendee lists keyed by event id — fetched when a detail modal
// opens, live-updated by the SSE "attendance_changed" frame. Not persisted,
// not delta-synced; missing entry = not loaded yet.
type AttendeesStore = {
  byEvent: Record<string, Attendee[]>;
  setAttendees: (eventID: string, attendees: Attendee[]) => void;
}

export const useAttendeesStore = create<AttendeesStore>((set) => ({
  byEvent: {},
  setAttendees: (eventID, attendees) =>
    set((s) => ({ byEvent: { ...s.byEvent, [eventID]: attendees } })),
}));
