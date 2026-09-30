import * as React from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "~/lib/utils";

type InlineErrorProps = React.ComponentProps<"div"> & {
  requestId?: string;
};

/** What went wrong, next to where it went wrong. The request ID is for a bug report. */
function InlineError({ children, className, requestId, ...props }: InlineErrorProps) {
  return (
    <div
      data-slot="inline-error"
      role="alert"
      className={cn("flex gap-3 rounded-control border border-shu/30 bg-shu/5 px-4 py-3 text-13 leading-normal text-foreground", className)}
      {...props}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-shu" strokeWidth={1.8} />
      <div className="grid min-w-0 gap-1">
        <p>{children}</p>
        {requestId ? <span className="font-mono text-11 text-muted-foreground">Request ID: {requestId}</span> : null}
      </div>
    </div>
  );
}

export { InlineError, type InlineErrorProps };
