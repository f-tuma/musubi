import type { Task } from "@musubi/types";
import { create } from "zustand";

export type TaskCollectionStatus = "not-loaded" | "cached" | "ready" | "error" | "unauthorized";
export type TaskCollectionState = {
  scope: string | null;
  tasks: Task[];
  ready: boolean;
  status: TaskCollectionStatus;
  refreshing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
};

export const emptyTaskCollection: TaskCollectionState = {
  scope: null, tasks: [], ready: false, status: "not-loaded",
  refreshing: false, lastSyncedAt: null, error: null,
};

/** One readable collection for the app and widgets; session ownership lives in taskCollection. */
export const useTasksStore = create<TaskCollectionState>(() => ({ ...emptyTaskCollection }));
