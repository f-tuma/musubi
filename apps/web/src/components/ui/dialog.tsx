import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ElevatedLayerContext } from "~/components/ui/layer";

type FocusTarget = HTMLElement | React.RefObject<HTMLElement | null> | null | undefined;

function resolveFocusTarget(target: FocusTarget) {
  return target && "current" in target ? target.current : target;
}

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * Widths are roles, not screens: `compact` asks one question, `form` edits one
 * thing, `default` holds a list or a short page, `wide` is a workspace with a
 * navigation beside it. `tall` holds the shared dialog height so moving
 * between standing dialogs never resizes the window.
 */
const dialogContentVariants = cva(
  "pointer-events-auto relative flex max-h-full w-full flex-col overflow-hidden border border-border bg-canvas text-foreground shadow-overlay outline-none duration-standard data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 max-sm:rounded-t-sheet max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-safe-bottom sm:rounded-sheet sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
  {
    variants: {
      size: {
        compact: "sm:max-w-compact",
        form: "sm:max-w-form",
        default: "sm:max-w-default",
        wide: "sm:max-w-wide",
      },
      tall: {
        true: "h-full sm:h-dialog",
        false: "",
      },
      side: {
        center: "",
        // The object inspector: docked to the right edge from 1024 px up.
        right: "md:h-full md:max-h-none md:max-w-inspector md:rounded-none md:rounded-l-sheet md:border-y-0 md:border-r-0",
      },
    },
    defaultVariants: {
      size: "default",
      tall: false,
      side: "center",
    },
  },
);

type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> &
  VariantProps<typeof dialogContentVariants> & {
    /** Accessible name of the close button; omit to hide it. */
    closeLabel?: string;
    /** Paint above anchored surfaces, for a dialog opened from a popover. */
    elevated?: boolean;
    /** Focus this instead of the first focusable element on open. */
    initialFocus?: React.RefObject<HTMLElement | null>;
    /** Return focus here on close, for dialogs opened by a gesture rather than a trigger. */
    returnFocus?: FocusTarget;
    /** Block dismissal by pointer outside the dialog. Escape still closes it. */
    dismissOnOutsideInteraction?: boolean;
    /** Leave the page interactive: no backdrop, no focus trap. */
    modal?: boolean;
  };

/**
 * The one modal shell. Radix owns the focus trap, Escape and trigger focus
 * restoration. Below 600 px the dialog becomes a bottom sheet.
 */
function DialogContent({
  className,
  children,
  size,
  tall,
  side = "center",
  closeLabel = "Close",
  elevated = false,
  initialFocus,
  returnFocus,
  dismissOnOutsideInteraction = true,
  modal = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  ...props
}: DialogContentProps) {
  const content = (
    <DialogPrimitive.Content
      data-slot="dialog-content"
      className={cn(dialogContentVariants({ size, tall, side }), className)}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (event.defaultPrevented || !initialFocus?.current) return;
        event.preventDefault();
        initialFocus.current.focus();
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        const target = resolveFocusTarget(returnFocus);
        if (event.defaultPrevented || !target?.isConnected) return;
        event.preventDefault();
        target.focus();
      }}
      onInteractOutside={(event) => {
        onInteractOutside?.(event);
        if (!dismissOnOutsideInteraction) event.preventDefault();
      }}
      {...props}
    >
      <ElevatedLayerContext.Provider value={elevated}>
        {children}
        {closeLabel ? (
          <DialogPrimitive.Close asChild>
            <Button
              aria-label={closeLabel}
              title={closeLabel}
              className="absolute top-4 right-4"
              size="icon-compact"
              variant="ghost"
            >
              <XIcon aria-hidden="true" strokeWidth={1.6} />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </ElevatedLayerContext.Provider>
    </DialogPrimitive.Content>
  );

  return (
    <DialogPrimitive.Portal>
      {modal ? (
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          /* Names the backdrop for hit-tests that walk the layer stack, so a
             calendar gesture can tell it is buried rather than on the grid. */
          data-dialog-overlay=""
          className={cn(
            "fixed inset-0 flex items-end justify-center bg-foreground/40 duration-standard data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 sm:items-center sm:p-6 dark:bg-canvas/70",
            side === "right" && "md:items-stretch md:justify-end md:p-0",
            // A child dialog's backdrop replaces this one instead of doubling it.
            "has-[~[data-slot=dialog-overlay][data-state=open]]:bg-transparent",
            elevated ? "z-dialog-overlay-elevated" : "z-dialog-overlay",
          )}
        >
          {content}
        </DialogPrimitive.Overlay>
      ) : (
        <div
          className={cn(
            "pointer-events-none fixed inset-0 flex items-end justify-center sm:items-center sm:p-6",
            side === "right" && "md:items-stretch md:justify-end md:p-0",
            elevated ? "z-dialog-elevated" : "z-dialog",
          )}
        >
          {content}
        </div>
      )}
    </DialogPrimitive.Portal>
  );
}

/** Title block. Keep it to the title: the controls below should explain themselves. */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-1 py-5 pr-16 pl-6", className)}
      {...props}
    />
  );
}

/** The scrolling middle. Header and footer stay put while it moves. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-6 pb-6", className)}
      {...props}
    />
  );
}

/** Actions, trailing. The primary one is last, so it sits under the thumb and the eye. */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-border-subtle px-6 py-4 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-serif text-22 leading-tight font-normal text-foreground", className)}
      {...props}
    />
  );
}

/** One line at most. If a dialog needs a paragraph to be understood, redesign the dialog. */
function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-13 leading-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  type DialogContentProps,
};
