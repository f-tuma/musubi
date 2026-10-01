import * as React from "react";
import { cn } from "~/lib/utils";

/** The field owns its height: a drag handle would push the layer that holds it. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full min-w-0 resize-none rounded-control border border-border bg-raised px-3 py-3 text-14 leading-normal text-foreground transition-colors duration-fast placeholder:text-muted-foreground hover:border-border-strong focus-visible:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-shu",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
