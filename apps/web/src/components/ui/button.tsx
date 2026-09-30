import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "~/lib/utils";
import { Spinner } from "~/components/ui/spinner";

/**
 * Musubi's one action. Primary is sumi ink on washi; destructive is the only
 * place the shu accent fills a control. Focus rings come from the global
 * keyboard focus mode, never from the button.
 */
const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-control border border-transparent font-sans text-13 font-medium whitespace-nowrap no-underline transition-colors duration-fast select-none disabled:cursor-not-allowed disabled:opacity-50 data-[loading]:cursor-wait [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:enabled:bg-primary/90",
        secondary:
          "border-border bg-transparent text-foreground hover:enabled:border-border-strong hover:enabled:bg-raised aria-expanded:border-border-strong aria-expanded:bg-raised aria-pressed:border-border-strong aria-pressed:bg-raised",
        // Inside a sumi-filled surface (`data-inverse`, e.g. the selected page
        // row) the quiet action takes the fill's ink instead of vanishing into it.
        ghost:
          "bg-transparent text-foreground-secondary hover:enabled:bg-raised hover:enabled:text-foreground aria-expanded:bg-raised aria-expanded:text-foreground aria-pressed:bg-raised aria-pressed:text-foreground in-data-[inverse]:text-primary-foreground/70 in-data-[inverse]:hover:enabled:bg-primary-foreground/15 in-data-[inverse]:hover:enabled:text-primary-foreground in-data-[inverse]:aria-expanded:bg-primary-foreground/15 in-data-[inverse]:aria-expanded:text-primary-foreground",
        destructive: "bg-shu text-shu-foreground hover:enabled:bg-shu/90",
        link: "rounded-sm text-foreground underline decoration-border-strong underline-offset-4 hover:enabled:decoration-current",
      },
      size: {
        default: "h-control px-4",
        compact: "h-control-compact px-3",
        icon: "size-control",
        "icon-compact": "size-control-compact",
        // The phone's floating create action: round, in thumb reach, lifted off the grid.
        fab: "size-14 rounded-full shadow-overlay [&_svg:not([class*='size-'])]:size-5",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Keeps the button's width and announces the wait through aria-busy. */
    loading?: boolean;
  };

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          <span className={cn("inline-flex min-w-0 items-center justify-center gap-2", loading && "invisible")}>
            {children}
          </span>
          {loading ? (
            <span className="absolute inset-0 grid place-items-center">
              <Spinner />
            </span>
          ) : null}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants, type ButtonProps };
