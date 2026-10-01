import { CircleHelp } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover";

const HOVER_DELAY = 400;
const LEAVE_DELAY = 150;

/**
 * Optional background help behind a small "?" beside a label. This is where
 * explanations go, so the screen itself can stay quiet. Required instructions
 * and errors stay visible; never hide them here.
 */
export function HelpTooltip({ children, label }: { children: ReactNode; label: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovering = useRef(false);
  const hoveringContent = useRef(false);
  const focused = useRef(false);
  const pointerActivation = useRef(false);
  const dismissed = useRef(false);

  function clearTimer() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }
  function dismiss() {
    clearTimer();
    hoveringContent.current = false;
    dismissed.current = true;
    setOpen(false);
  }
  function leave() {
    clearTimer();
    if (hovering.current || hoveringContent.current || focused.current) return;
    timer.current = setTimeout(() => setOpen(false), LEAVE_DELAY);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <PopoverAnchor asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon-compact"
          className="-my-2 text-muted-foreground"
          aria-label={label}
          aria-describedby={open ? id : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            hovering.current = true;
            dismissed.current = false;
            clearTimer();
            timer.current = setTimeout(() => { if (!dismissed.current) setOpen(true); }, HOVER_DELAY);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "touch") return;
            hovering.current = false;
            leave();
          }}
          onPointerDown={() => { pointerActivation.current = true; clearTimer(); }}
          onPointerCancel={() => { pointerActivation.current = false; }}
          onFocus={(event) => {
            focused.current = true;
            if (pointerActivation.current) return;
            // Only a keyboard arrival opens it. Focus a layer moves here on its
            // own (a popover opening onto this button) must not pop help up.
            if (event.currentTarget.ownerDocument.documentElement.dataset.focusMode !== "keyboard") return;
            dismissed.current = false;
            clearTimer();
            setOpen(true);
          }}
          onBlur={() => {
            focused.current = false;
            pointerActivation.current = false;
            leave();
          }}
          onClick={() => {
            pointerActivation.current = false;
            clearTimer();
            dismissed.current = false;
            setOpen((current) => !current);
          }}
        >
          <CircleHelp aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        role="region"
        aria-label={label}
        className="w-auto max-w-popover px-4 py-3 text-12 leading-normal text-foreground-secondary"
        side="top"
        mobileSurface="anchored"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => { if (hovering.current || hoveringContent.current) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
        onInteractOutside={(event) => {
          if (trigger.current?.contains(event.target as Node)) event.preventDefault();
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          hoveringContent.current = true;
          clearTimer();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return;
          hoveringContent.current = false;
          leave();
        }}
      >
        <div id={id} role="tooltip" className="break-words">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
