import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "~/lib/utils";

/**
 * A group of rows on one washi panel, divided by hairlines. Settings, lists
 * of calendars, connected accounts: anything that reads as a list of things.
 */
function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-group"
      className={cn(
        "group/item-group flex flex-col divide-y divide-border-subtle overflow-hidden rounded-card border border-border bg-panel",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One row. Every row in Musubi has the same height floor, the same inset and
 * the same slots, so lists line up wherever they appear.
 */
const itemVariants = cva(
  "group/item flex w-full min-w-0 items-center gap-3 bg-transparent text-left text-foreground-secondary",
  {
    variants: {
      size: {
        default: "min-h-row px-4 py-2",
        compact: "min-h-control px-3 py-1.5",
      },
      interactive: {
        true: "cursor-pointer transition-colors duration-fast focus-inset hover:enabled:bg-raised/60 disabled:cursor-not-allowed disabled:opacity-50 data-[selected]:bg-primary data-[selected]:text-primary-foreground data-[selected]:hover:enabled:bg-primary/90",
        false: "",
      },
      tone: {
        default: "",
        destructive: "text-shu hover:enabled:bg-shu/5",
      },
    },
    defaultVariants: {
      size: "default",
      interactive: false,
      tone: "default",
    },
  },
);

function Item({
  className,
  size,
  interactive,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="item"
      data-size={size ?? "default"}
      data-tone={tone && tone !== "default" ? tone : undefined}
      className={cn(itemVariants({ size, interactive, tone }), className)}
      {...props}
    />
  );
}

/** Leading glyph, avatar or colour dot. Takes a 20 px column so labels align down the list. */
function ItemMedia({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="item-media"
      className={cn(
        "grid min-w-5 flex-none place-content-center text-muted-foreground group-data-[selected]/item:text-current [&_svg:not([class*='size-'])]:size-4.5",
        className,
      )}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="item-content" className={cn("grid min-w-0 flex-1 gap-0.5", className)} {...props} />;
}

function ItemTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-title"
      className={cn("flex min-w-0 items-center gap-2 text-14 font-medium text-foreground group-data-[selected]/item:text-current", className)}
      {...props}
    />
  );
}

/** One short line. A row that needs two lines to explain itself should be two rows or a help "?". */
function ItemDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-description"
      className={cn("truncate text-12 leading-snug text-muted-foreground group-data-[selected]/item:text-current", className)}
      {...props}
    />
  );
}

/** A value read at a glance, trailing: "10 min", "Monday". */
function ItemValue({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-value"
      className={cn("max-w-2/5 truncate text-13 text-muted-foreground group-data-[selected]/item:text-current", className)}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="item-actions" className={cn("flex flex-none items-center gap-1", className)} {...props} />;
}

export { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle, ItemValue, itemVariants };
