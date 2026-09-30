import * as React from "react";
import { AppWindow, GripHorizontal, PanelRight } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { useInspectorPreference, type InspectorPresentation } from "~/components/ui/inspector-preferences";

type WindowPosition = { x: number; y: number };
type ActiveInspector = { id: symbol; close: (after: () => void) => void };
const InspectorContext = createContext<
  | {
      id: symbol;
      modal: boolean;
      open: boolean;
      expanded: boolean;
      presentation: InspectorPresentation;
      setPresentation: (value: InspectorPresentation) => void;
      position: RefObject<WindowPosition | null>;
    }
  | undefined
>(undefined);
let activeInspector: ActiveInspector | undefined;
/** Admit imperative entry points through the same guard as an inspector trigger. */
export function requestInspectorTransition(after: () => void) {
  if (activeInspector) activeInspector.close(after);
  else after();
}

const NARROW_QUERY = "(max-width: 1023px)";
const subscribe = (callback: () => void) => {
  const query = matchMedia(NARROW_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};

/** Keep the open object’s mode and position until it closes, including detail/edit handoffs. */
export function useInspectorPresentation(open: boolean) {
  const [preferred] = useInspectorPreference();
  const [session, setSession] = useState({ open, presentation: preferred });
  const position = useRef<WindowPosition | null>(null);
  useEffect(() => {
    if (!open) position.current = null;
  }, [open]);
  // Reset only for a newly opened object; toggling never remounts its draft.
  if (session.open !== open) setSession({ open, presentation: open ? preferred : session.presentation });
  return [
    session.presentation,
    (presentation: InspectorPresentation) => setSession((current) => ({ ...current, presentation })),
    position,
  ] as const;
}

/** One selected object at a time. The owner can guard deactivation for a draft. */
export function Inspector({
  open,
  onOpenChange,
  onRequestClose,
  children,
  expanded = false,
  presentation: controlledPresentation,
  onPresentationChange,
  position: controlledPosition,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestClose: (after: () => void) => void;
  children: ReactNode;
  /** Expand the same mounted editor without losing its draft or window placement. */
  expanded?: boolean;
  presentation?: InspectorPresentation;
  onPresentationChange?: (value: InspectorPresentation) => void;
  position?: RefObject<WindowPosition | null>;
}) {
  const [localPresentation, setLocalPresentation, localPosition] = useInspectorPresentation(open);
  const position = controlledPosition ?? localPosition;
  const presentation = controlledPresentation ?? localPresentation;
  const setPresentation = onPresentationChange ?? setLocalPresentation;
  const [id] = useState(() => Symbol("inspector"));
  const close = useRef(onRequestClose);
  useLayoutEffect(() => {
    close.current = onRequestClose;
  }, [onRequestClose]);
  const modal = useSyncExternalStore(subscribe, () => matchMedia(NARROW_QUERY).matches, () => false);
  useEffect(() => {
    if (!open) return;
    const identity = id;
    activeInspector = { id: identity, close: (after) => close.current(after) };
    return () => {
      if (activeInspector?.id === identity) activeInspector = undefined;
    };
  }, [open, id]);
  return (
    <InspectorContext.Provider value={{ id, modal, open, expanded, presentation, setPresentation, position }}>
      <DialogPrimitive.Root
        modal={modal}
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            onRequestClose(() => {});
            return;
          }
          if (activeInspector && activeInspector.id !== id) activeInspector.close(() => onOpenChange(true));
          else onOpenChange(true);
        }}
      >
        {children}
      </DialogPrimitive.Root>
    </InspectorContext.Provider>
  );
}

export function InspectorTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} data-inspector-trigger="" />;
}
export const InspectorClose = DialogPrimitive.Close;
export const InspectorTitle = DialogPrimitive.Title;

/** The same placement and keyboard movement controls in every inspector header. */
export function InspectorHeaderActions({ children }: { children: ReactNode }) {
  const inspector = useContext(InspectorContext);
  const floating = inspector?.presentation === "floating";
  return (
    <div data-slot="inspector-header-actions" className="flex flex-none items-center gap-1 [&>div:empty]:hidden">
      {inspector && !inspector.modal && !inspector.expanded ? (
        <>
          {floating ? (
            <Button
              aria-label="Move window with arrow keys"
              data-inspector-move=""
              size="icon-compact"
              title="Drag to move · Arrow keys to move · Shift for larger steps"
              variant="ghost"
              onKeyDown={(event) => {
                const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[event.key];
                if (!direction) return;
                event.preventDefault();
                event.stopPropagation();
                const node = event.currentTarget.closest<HTMLElement>('[data-ui="inspector"]');
                if (!node) return;
                const rect = node.getBoundingClientRect();
                const step = event.shiftKey ? 32 : 8;
                placeWindow(node, rect.x + direction[0] * step, rect.y + direction[1] * step, inspector.position);
              }}
            >
              <GripHorizontal aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            aria-label={floating ? "Dock to side" : "Float window"}
            size="icon-compact"
            title={floating ? "Dock to side" : "Float window"}
            variant="ghost"
            onClick={() => inspector.setPresentation(floating ? "panel" : "floating")}
          >
            {floating ? <PanelRight aria-hidden="true" /> : <AppWindow aria-hidden="true" />}
          </Button>
        </>
      ) : null}
      {children}
    </div>
  );
}

function placeWindow(node: HTMLElement, x: number, y: number, position?: RefObject<WindowPosition | null>) {
  const style = getComputedStyle(node);
  const gutterValue = style.getPropertyValue("--layer-viewport-gutter").trim();
  const gutter =
    parseFloat(gutterValue) * (gutterValue.endsWith("rem") ? parseFloat(getComputedStyle(document.documentElement).fontSize) : 1) || 0;
  const bounds = node.getBoundingClientRect();
  const next = {
    x: Math.max(gutter, Math.min(x, window.innerWidth - bounds.width - gutter)),
    y: Math.max(gutter, Math.min(y, window.innerHeight - bounds.height - gutter)),
  };
  // Inline placement wins over the centring the class gives an unmoved window.
  node.style.inset = "auto";
  node.style.margin = "0";
  node.style.left = `${next.x}px`;
  node.style.top = `${next.y}px`;
  if (position) position.current = next;
}

function clearPlacement(node: HTMLElement) {
  node.style.inset = "";
  node.style.margin = "";
  node.style.left = "";
  node.style.top = "";
}

const overlayClassName =
  "fixed inset-0 z-dialog-overlay bg-foreground/40 duration-standard data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none dark:bg-canvas/70 has-[~[data-slot=dialog-overlay][data-state=open]]:bg-transparent";

/**
 * Geometry by presentation. The surface is the Dialog's: canvas, hairline,
 * overlay shadow, sheet radius. Below 600 px every inspector is a bottom
 * sheet; up to 1024 px a centred modal window; from there a panel docked to
 * the right edge, a window that floats over the calendar, or, expanded, the
 * same window at workspace size.
 */
const surfaceClassName =
  "fixed z-dialog flex flex-col overflow-hidden border border-border bg-canvas text-foreground shadow-overlay outline-none duration-standard data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-full max-sm:rounded-t-sheet max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-safe-bottom sm:inset-0 sm:m-auto sm:h-dialog sm:w-inspector sm:max-w-full sm:rounded-sheet";

const presentationClassName = {
  panel:
    "md:inset-y-0 md:right-0 md:left-auto md:m-0 md:h-full md:rounded-none md:rounded-l-sheet md:border-y-0 md:border-r-0 md:duration-panel md:data-[state=open]:slide-in-from-right md:data-[state=closed]:slide-out-to-right",
  // Placed by script from the first frame: centred, then wherever it is dragged.
  floating:
    "md:inset-0 md:m-auto md:duration-fast md:[&_[data-inspector-header]]:cursor-grab md:[&_[data-inspector-header]]:touch-none md:[&_[data-inspector-move]]:cursor-grab md:[&_[data-inspector-move]]:touch-none data-[dragging]:cursor-grabbing data-[dragging]:select-none data-[dragging]:[&_[data-inspector-header]]:cursor-grabbing",
  // The workspace size matches Dialog's `wide` + `tall`, so expanding reads as the same window growing.
  expanded:
    "max-sm:top-0 max-sm:h-full max-sm:rounded-none max-sm:border-0 sm:inset-6 sm:mx-auto sm:my-auto sm:w-auto sm:max-w-wide data-[state=open]:animate-none",
} as const;

export function InspectorContent({
  className,
  children,
  accessibleTitle,
  persistent = false,
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { accessibleTitle: string; persistent?: boolean }) {
  const inspector = useContext(InspectorContext);
  const identity = inspector?.id;
  const position = inspector?.position;
  const expanded = inspector?.expanded;
  const floating = !expanded && !inspector?.modal && inspector?.presentation === "floating";
  const presentation = expanded ? "expanded" : floating ? "floating" : "panel";
  const content = useRef<HTMLDivElement | null>(null);
  // Radix mounts portal content after its parent; position when the DOM arrives.
  const [attached, setAttached] = useState(false);
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      content.current = node;
      setAttached(Boolean(node));
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node || !inspector?.open) return;
    drag.current = null;
    delete node.dataset.dragging;
    if (!floating) {
      clearPlacement(node);
      return;
    }
    // Keep placement when switching between a task detail and its editor, or
    // back from expanded. A window nobody has moved stays centred by its class,
    // so it is never placed from a frame of its entrance animation.
    const previous = position?.current;
    if (previous) placeWindow(node, previous.x, previous.y, position);
    else clearPlacement(node);
    const constrain = () => {
      if (!position?.current) return;
      placeWindow(node, position.current.x, position.current.y, position);
    };
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(constrain);
    });
    observer.observe(node);
    window.addEventListener("resize", constrain);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", constrain);
    };
  }, [attached, floating, inspector?.open, position]);
  return (
    <DialogPrimitive.Portal>
      {/* Keep the desktop form mounted when expanding; changing Radix's modal
          mode would replace it. Narrow inspectors already have a modal backdrop. */}
      {expanded && !inspector?.modal ? (
        <div
          aria-hidden="true"
          className={overlayClassName}
          data-dialog-overlay=""
          data-slot="dialog-overlay"
          data-state={inspector?.open ? "open" : "closed"}
        />
      ) : (
        <DialogPrimitive.Overlay className={overlayClassName} data-dialog-overlay="" data-slot="dialog-overlay" />
      )}
      <DialogPrimitive.Content
        aria-modal={inspector?.modal || undefined}
        data-ui="inspector"
        data-inspector-persistent={persistent ? "" : undefined}
        aria-describedby={undefined}
        {...props}
        data-presentation={presentation}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (event.defaultPrevented || !floating || event.button !== 0 || !(event.target instanceof Element)) return;
          if (!event.target.closest("[data-inspector-header]")) return;
          if (event.target.closest('button, a, input, textarea, select, [role="button"]') && !event.target.closest("[data-inspector-move]")) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.x, top: rect.y };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.dragging = "";
        }}
        onPointerMove={(event) => {
          props.onPointerMove?.(event);
          const start = drag.current;
          if (!start || event.pointerId !== start.pointer) return;
          placeWindow(event.currentTarget, start.left + event.clientX - start.x, start.top + event.clientY - start.y, position);
        }}
        onPointerUp={(event) => {
          props.onPointerUp?.(event);
          if (drag.current?.pointer !== event.pointerId) return;
          drag.current = null;
          delete event.currentTarget.dataset.dragging;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={(event) => {
          props.onLostPointerCapture?.(event);
          drag.current = null;
          delete event.currentTarget.dataset.dragging;
        }}
        onCloseAutoFocus={(event) => {
          if (activeInspector && activeInspector.id !== identity) {
            event.preventDefault();
            return;
          }
          props.onCloseAutoFocus?.(event);
        }}
        ref={contentRef}
        className={cn(surfaceClassName, presentationClassName[presentation], className)}
      >
        <DialogPrimitive.Title aria-hidden="true" className="sr-only">
          {accessibleTitle}
        </DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
