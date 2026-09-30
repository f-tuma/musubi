import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";

type SwitchProps = Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "aria-label"> & {
  /** The switch has no visible text of its own; its row names it. */
  label: string;
};

/** On/off that applies at once. A 24 px track inside a 44 px hit area. */
function Switch({ className, label, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      aria-label={label}
      className={cn(
        "peer group/switch relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-raised transition-colors duration-fast before:absolute before:-inset-2.5 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-muted-foreground transition-transform duration-fast data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch, type SwitchProps };
