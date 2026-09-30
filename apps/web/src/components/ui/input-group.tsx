import * as React from "react";
import { cn } from "~/lib/utils";

/**
 * An input with something attached: a search glyph, a unit, a clear button.
 * The group draws the field; the input inside is bare.
 */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-control w-full min-w-0 items-center rounded-control border border-border bg-raised text-foreground transition-colors duration-fast hover:border-border-strong has-[[data-slot=input-group-control]:focus-visible]:border-border-strong has-[[aria-invalid=true]]:border-shu",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & { align?: "inline-start" | "inline-end" }) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "flex h-full flex-none items-center gap-2 text-13 text-muted-foreground select-none [&>svg:not([class*='size-'])]:size-4",
        align === "inline-start" ? "order-first pl-3" : "order-last pr-1",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input-group-control"
      className={cn(
        "h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-14 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput };
