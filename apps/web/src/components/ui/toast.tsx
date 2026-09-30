import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

function subscribeToPortalTarget() {
  return () => undefined;
}

function getPortalTarget() {
  return document.body;
}

type ToastTone = "neutral" | "error";

type ToastAction = {
  label: string;
  onClick: () => void;
};

type ToastProps = {
  /** At most one, and it should be Undo. */
  action?: ToastAction;
  message: ReactNode;
  /** `workspace` centres on the calendar grid and clears the create button. */
  placement?: "page" | "workspace";
  tone?: ToastTone;
};

/**
 * A non-modal notice that never takes focus. The parent owns timing, so an
 * undo can stay for as long as the operation behind it can be reversed.
 */
function Toast({ action, message, placement = "page", tone = "neutral" }: ToastProps) {
  const portalTarget = useSyncExternalStore(subscribeToPortalTarget, getPortalTarget, () => null);
  const isError = tone === "error";

  const content = (
    <div
      data-slot="toast-region"
      data-placement={placement}
      className="pointer-events-none fixed bottom-(--toast-bottom) left-(--toast-left) z-popover-elevated flex w-96 max-w-full -translate-x-1/2 justify-center px-3"
    >
      <div
        data-tone={tone}
        className={cn(
          "pointer-events-auto flex min-h-12 w-max max-w-full items-center gap-3 rounded-control border border-border bg-overlay py-1.5 pl-4 text-13 text-foreground shadow-overlay duration-fast animate-in fade-in-0 zoom-in-95",
          action ? "pr-1.5" : "pr-4",
          isError && "border-shu/40",
        )}
      >
        {isError ? <CircleAlert aria-hidden="true" className="size-4 flex-none text-shu" strokeWidth={1.7} /> : null}
        <p aria-atomic="true" className="min-w-0 flex-auto leading-snug" role={isError ? "alert" : "status"}>
          {message}
        </p>
        {action ? (
          <Button size="compact" variant="ghost" className="flex-none text-shu" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return portalTarget ? createPortal(content, portalTarget) : content;
}

export { Toast, type ToastAction, type ToastProps, type ToastTone };
