import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The anatomy every object inspector shares — event preview, event editor,
 * new event, task: a serif title under the calendar's pigment bar, one
 * scrolling body, one footer of actions. Same insets everywhere, so moving
 * between a detail and its editor changes only what is inside.
 */
export function PanelHeader({ accent, children, className, ...props }: ComponentProps<"header"> & {
  /** The home calendar's colour, drawn as the bar beside the title. */
  accent?: string;
}) {
  return (
    <header
      data-inspector-header=""
      className={cn("relative flex flex-none items-start gap-4 px-6 pt-6 pb-4", className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className="absolute top-6 left-0 h-7 w-1 rounded-r-full bg-pigment"
        style={{ "--pigment": accent } as CSSProperties}
      />
      {children}
    </header>
  );
}

export function PanelTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("min-w-0 flex-1 font-serif text-22 leading-tight font-normal wrap-anywhere text-foreground", className)}
      {...props}
    />
  );
}

export function PanelBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 pt-1 pb-5", className)}
      {...props}
    />
  );
}

/** Actions, primary last. Leading slot for the overflow menu. */
export function PanelFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn("mb-safe-bottom flex flex-none items-center gap-2 border-t border-border-subtle px-6 py-4", className)}
      {...props}
    />
  );
}

/** Quiet facts, one per line, each behind a 20 px glyph column. */
export function DetailList({ className, ...props }: ComponentProps<"dl">) {
  return <dl className={cn("grid", className)} {...props} />;
}

export function DetailRow({ icon, label, children, trailing }: {
  icon: ReactNode;
  /** Named for assistive technology; the glyph names it on screen. */
  label: string;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 text-13 leading-normal text-foreground">
      <dt className="grid w-5 flex-none place-content-center self-start pt-1.5 text-foreground-secondary [&_svg]:size-4.5">
        <span className="sr-only">{label}</span><span aria-hidden="true">{icon}</span>
      </dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2 py-1">
        <div className="min-w-0 flex-1 wrap-anywhere">{children}</div>
        {trailing ? <div className="flex flex-none items-center">{trailing}</div> : null}
      </dd>
    </div>
  );
}

/** A link inside a detail: ink, with an underline that only strengthens on hover. */
export const detailLinkClassName =
  "text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-current";
