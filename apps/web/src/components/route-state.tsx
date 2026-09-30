import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { BrandMark } from "~/components/BrandMark";
import { PageAmbient } from "~/components/page-ambient";

type RouteStateProps = Omit<ComponentProps<"main">, "children" | "title"> & {
  actions?: ReactNode;
  busy?: boolean;
  description?: ReactNode;
  requestId?: string;
  title: ReactNode;
};

/**
 * Full-page feedback: loading, unavailable, not found, failed. The mark, one
 * title, at most one sentence, and the way forward.
 */
export function RouteState({
  actions,
  "aria-labelledby": labelledBy,
  busy = false,
  className,
  description,
  id = "main-content",
  requestId,
  title,
  ...props
}: RouteStateProps) {
  const generatedTitleId = useId();
  const titleId = labelledBy ?? generatedTitleId;

  return (
    <main
      aria-busy={busy || undefined}
      aria-labelledby={titleId}
      className={cn("relative isolate grid min-h-dvh w-full place-items-center overflow-hidden bg-canvas p-6 text-center outline-none sm:p-8", className)}
      id={id}
      tabIndex={-1}
      {...props}
    >
      <PageAmbient />
      <section className="grid w-full max-w-form justify-items-center gap-3">
        <BrandMark aria-hidden="true" className={cn("mb-2 size-16", busy && "animate-pulse motion-reduce:animate-none")} focusable="false" />
        <h1 id={titleId} className="font-serif text-display leading-tight font-normal text-balance text-foreground">
          {title}
        </h1>
        {description ? <p className="max-w-96 text-15 leading-relaxed text-muted-foreground">{description}</p> : null}
        {requestId ? <p className="font-mono text-11 text-muted-foreground">Request ID: {requestId}</p> : null}
        {actions ? <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </section>
    </main>
  );
}
