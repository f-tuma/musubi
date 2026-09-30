import { cn } from "~/lib/utils";

/** A ring with one open quarter, turning. Decorative: the owner announces the busy state. */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="spinner"
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
