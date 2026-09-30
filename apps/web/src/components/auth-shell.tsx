import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/lib/utils";
import { BrandMark } from "~/components/BrandMark";
import { PageAmbient } from "~/components/page-ambient";
import { Button, type ButtonProps } from "~/components/ui/button";
import { InlineError } from "~/components/ui/inline-error";

type AuthShellProps = {
  /** A second way in, under an "or" rule: provider buttons. */
  aside?: ReactNode;
  children: ReactNode;
  /** The way to the other mode, at the foot of the card. */
  footer?: ReactNode;
  /** One short line under the title, only when the title cannot say it alone. */
  introduction?: ReactNode;
  /** Replaces nothing: sits above the title, for a flow's step marks. */
  progress?: ReactNode;
  title: ReactNode;
  /** Top-right control, such as the theme toggle. */
  utility?: ReactNode;
};

/**
 * Every screen before the calendar — sign in, sign up, confirm, invitation,
 * first run — is this one card. Same width, same place, same rhythm, so
 * moving between them changes only what is inside.
 */
export function AuthShell({ aside, children, footer, introduction, progress, title, utility }: AuthShellProps) {
  return (
    <main id="main-content" tabIndex={-1} className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-canvas outline-none">
      <PageAmbient />
      <header className="flex h-20 items-center justify-between px-6">
        <div aria-label="Musubi" className="flex items-center gap-2 text-10 tracking-wide text-foreground">
          <BrandMark aria-hidden="true" className="size-7" focusable="false" />
          <span>MUSUBI</span>
        </div>
        {utility}
      </header>

      <div className="flex flex-1 justify-center px-4 pt-6 pb-20 sm:items-center sm:pt-0">
        <section
          aria-labelledby="auth-title"
          className="flex w-full max-w-compact flex-col self-start rounded-sheet border border-border bg-panel p-8 shadow-overlay max-sm:px-5 max-sm:py-7 sm:self-center"
        >
          {progress ? <div className="mb-6">{progress}</div> : null}
          <div className="mb-7 grid gap-2">
            <h1 id="auth-title" className="font-serif text-display leading-tight font-normal text-balance text-foreground">
              {title}
            </h1>
            {introduction ? <p className="text-14 leading-relaxed text-muted-foreground">{introduction}</p> : null}
          </div>

          <div className="grid gap-5">{children}</div>

          {aside ? (
            <div className="mt-6 grid gap-3">
              <div className="flex items-center gap-3 text-11 tracking-label text-muted-foreground uppercase">
                <span className="h-px flex-1 bg-border-subtle" />
                or
                <span className="h-px flex-1 bg-border-subtle" />
              </div>
              {aside}
            </div>
          ) : null}

          {footer ? <div className="mt-7 border-t border-border-subtle pt-5">{footer}</div> : null}
        </section>
      </div>
    </main>
  );
}

export function AuthForm({ className, ...props }: ComponentProps<"form">) {
  return <form className={cn("grid gap-5", className)} {...props} />;
}

export function AuthMessage({ children, className }: { children?: ReactNode; className?: string }) {
  return children ? (
    <InlineError aria-live="polite" className={className}>
      {children}
    </InlineError>
  ) : null;
}

/** The provider buttons, one under another at full width. */
export function AuthProviders({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 *:w-full">{children}</div>;
}

/** A quiet footnote under a field: a way out, or what just happened. */
export function AuthHint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("-mt-3 flex justify-end text-12 leading-normal text-muted-foreground", className)}>{children}</p>;
}

/** The step's one commitment, full width at the foot of the form. */
export function AuthSubmit(props: ButtonProps) {
  return <Button className="w-full" {...props} />;
}

export function AuthSwitch({ action, children, onAction }: { action: string; children: ReactNode; onAction: () => void }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-2 text-13 text-muted-foreground">
      <span>{children}</span>
      <Button variant="link" onClick={onAction}>
        {action}
      </Button>
    </p>
  );
}

/** Step marks: a picture of progress, with the sentence it replaces for screen readers. */
export function StepDots({ step, total }: { step: number; total: number }) {
  return (
    <span aria-label={`Step ${step} of ${total}`} className="flex items-center gap-1.5" role="img">
      {Array.from({ length: total }, (_, index) => (
        <span
          aria-hidden="true"
          key={index}
          className={cn(
            "h-1 rounded-full transition-all duration-standard motion-reduce:transition-none",
            index + 1 === step ? "w-6 bg-shu" : index + 1 < step ? "w-2 bg-foreground-secondary" : "w-2 bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}
