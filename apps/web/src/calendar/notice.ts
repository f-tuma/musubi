import type { ToastTone } from "~/components/ui/toast";

export type NoticeOptions = {
  tone?: ToastTone;
  undo?: () => Promise<unknown> | void;
};

/**
 * A toast message, optionally with the action that puts things back.
 *
 * Offering Undo is what lets a mutation be immediate instead of guarded by a
 * confirm step: the cheapest way out of a mistake is doing it and taking it
 * back, not answering a question before every action.
 */
export type Notify = (
  message: string,
  options?: NoticeOptions,
) => void;
