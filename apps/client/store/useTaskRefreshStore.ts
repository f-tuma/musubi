import { create } from "zustand";

/** Task invalidation only; private snapshots remain scoped to their API session. */
export const useTaskRefreshStore = create<{ version: number; refresh: () => void }>((set) => ({
  version: 0,
  refresh: () => set(state => ({ version: state.version + 1 })),
}));
