import * as React from "react";
import { cn } from "~/lib/utils";

type SectionLabelProps = React.ComponentProps<"h2"> & {
  level?: 2 | 3;
};

/** The small-caps heading over a group. It names the group; it does not explain it. */
function SectionLabel({ className, level = 2, ...props }: SectionLabelProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <Heading
      data-slot="section-label"
      className={cn("text-11 leading-none font-medium tracking-label text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export { SectionLabel, type SectionLabelProps };
