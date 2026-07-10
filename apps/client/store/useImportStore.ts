import { create } from "zustand";
import type { ICSDraft } from "@/lib/ics";

// Bridge: an .ics opened via the OS (deep link listener in app/_layout) lands
// here; the calendar screen picks it up and opens the composer prefilled.
type ImportStore = {
  pending: ICSDraft | null;
  setPending: (d: ICSDraft | null) => void;
};

export const useImportStore = create<ImportStore>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));
