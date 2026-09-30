import type { ComponentProps, CSSProperties } from "react";
import { cn } from "~/lib/utils";

type CalendarDotProps = Omit<ComponentProps<"span">, "children" | "color" | "style"> & {
  color: string;
};

/**
 * The colour that ties a calendar to its events.
 *
 * Decorative on purpose: every place it appears already names the calendar in
 * text beside it, so announcing the colour would only repeat that. The hairline
 * keeps a pale pigment from dissolving into the surface behind it.
 */
export function CalendarDot({ className, color, ...props }: CalendarDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 flex-none rounded-full border border-foreground/10 bg-pigment", className)}
      style={{ "--pigment": color } as CSSProperties}
      {...props}
    />
  );
}
