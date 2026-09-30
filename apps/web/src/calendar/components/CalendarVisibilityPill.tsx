import type { Calendar } from "@musubi/types";
import type { CSSProperties } from "react";
import { Button } from "~/components/ui/button";

type CalendarVisibilityPillProps = {
  calendar: Calendar;
  onVisibleChange: (visible: boolean) => void;
  visible: boolean;
};

/**
 * One calendar, shown or hidden, as a toggle button you tap.
 *
 * A Page's saved visibility control. The pressed state answers "is this on" by
 * how it looks rather than by placing a separate switch beside every calendar;
 * the dot dims with it, so colour is never the only signal.
 */
export function CalendarVisibilityPill({
  calendar,
  onVisibleChange,
  visible,
}: CalendarVisibilityPillProps) {
  return (
    <Button
      aria-pressed={visible}
      className="max-w-full"
      size="compact"
      style={{ "--pigment": calendar.color } as CSSProperties}
      variant="secondary"
      onClick={() => onVisibleChange(!visible)}
    >
      <span
        aria-hidden="true"
        className="size-2 flex-none rounded-full bg-pigment opacity-40 in-aria-pressed:opacity-100"
      />
      <span className="truncate">{calendar.name}</span>
    </Button>
  );
}
