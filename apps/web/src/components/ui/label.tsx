import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";

/**
 * The name over a control, in sentence case. Small caps are kept for section
 * headings, so a label never reads as the start of a new group.
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-13 leading-snug font-medium text-foreground select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
