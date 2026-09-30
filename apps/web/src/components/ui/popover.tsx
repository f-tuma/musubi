import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { useElevatedLayer } from "~/components/ui/layer";

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverClose(props: React.ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

type PopoverContentProps = React.ComponentProps<typeof PopoverPrimitive.Content> & {
  /** Below 600 px the surface becomes a bottom sheet unless it must stay anchored. */
  mobileSurface?: "anchored" | "sheet";
  /** A small pointer back to the trigger, on anchored viewports. */
  showArrow?: boolean;
};

/**
 * A light anchored surface. Radix owns positioning, dismissal and focus; the
 * caller owns what goes inside and how wide it is (`w-*` is allowed).
 */
function PopoverContent({
  className,
  children,
  align = "center",
  sideOffset = 8,
  collisionPadding = 12,
  mobileSurface = "sheet",
  showArrow = false,
  ...props
}: PopoverContentProps) {
  const elevated = useElevatedLayer();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-ui="popover-content"
        data-mobile-surface={mobileSurface}
        data-elevated={elevated ? "" : undefined}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "w-popover max-w-(--radix-popover-content-available-width) origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-card border border-border bg-canvas text-foreground shadow-overlay outline-none duration-fast data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          "max-sm:data-[mobile-surface=sheet]:w-full max-sm:data-[mobile-surface=sheet]:max-w-full max-sm:data-[mobile-surface=sheet]:rounded-t-sheet max-sm:data-[mobile-surface=sheet]:rounded-b-none max-sm:data-[mobile-surface=sheet]:border-x-0 max-sm:data-[mobile-surface=sheet]:border-b-0 max-sm:data-[mobile-surface=sheet]:pb-safe-bottom",
          elevated ? "z-popover-elevated" : "z-popover",
          className,
        )}
        {...props}
      >
        {children}
        {showArrow ? (
          <PopoverPrimitive.Arrow
            aria-hidden="true"
            className="fill-canvas stroke-border max-sm:in-data-[mobile-surface=sheet]:hidden"
          />
        ) : null}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="popover-header" className={cn("flex flex-col gap-1 px-4 pt-4", className)} {...props} />;
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="popover-title" className={cn("text-14 font-medium text-foreground", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="popover-description" className={cn("text-12 leading-normal text-muted-foreground", className)} {...props} />;
}

export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  type PopoverContentProps,
};
