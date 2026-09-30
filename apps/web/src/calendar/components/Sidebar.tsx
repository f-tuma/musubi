import {
  CircleCheck,
  CloudOff,
  Layers3,
  Link2,
  LogOut,
  type LucideIcon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings,
  X,
  UserRound,
} from "lucide-react";
import type {
  PageDocument,
  Settings as UserSettings,
  User,
} from "@musubi/types";
import type { CSSProperties, ReactNode } from "react";
import {
  forwardRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BrandMark } from "~/components/BrandMark";
import { cn } from "~/lib/utils";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { RowAction } from "~/components/ui/row";
import { SectionLabel } from "~/components/ui/section-label";
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from "~/components/ui/menu";
import { moveItem, previewIndex } from "../list-reorder";
import { sortPagesBy } from "../page-editor";
import { pageIconComponent, resolvePageIcon } from "../page-icons";
import { useListReorder } from "../use-list-reorder";
import { MiniCalendar } from "./MiniCalendar";

/** Below 1024 px the sidebar is a drawer over the calendar, not a column beside it. */
const DRAWER_QUERY = "(max-width: 1023px)";

function useDrawerViewport(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(DRAWER_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DRAWER_QUERY).matches,
    () => false,
  );
}

/** Sidebar rows keep the control radius, so the selected fill reads as a pill. */
function SidebarRow({ children }: { children: ReactNode }) {
  return <div className="flex-none overflow-hidden rounded-control">{children}</div>;
}

type SidebarProps = {
  activePageId: string;
  /** The date the main view is on, so the mini calendar can mark it. */
  anchor: Date;
  isOpen: boolean;
  onClose: () => void;
  onCreatePage: () => void;
  onDateChange: (date: string) => void;
  onEditPage: (page: PageDocument) => void;
  onManageAccount: () => void;
  onManageCalendars: () => void;
  onManageConnections: () => void;
  onModalStateChange?: (modal: boolean) => void;
  onOpenSettings: () => void;
  onPageChange: (pageId: string) => void;
  /** The full page order after a move, which is what the endpoint takes. */
  onReorderPages: (pageIds: string[]) => Promise<unknown> | void;
  onSignOut: () => void;
  onRefreshServer?: () => void;
  refreshingServer?: boolean;
  pages: PageDocument[];
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  syncLabel: string;
  /** What the label is about, which decides the glyph and whether it warns. */
  syncTone: "connected" | "offline" | "refreshing";
  user: Pick<User, "email" | "image" | "name">;
  weekStartsOn: UserSettings["weekStartsOn"];
};

export function Sidebar({
  activePageId,
  anchor,
  isOpen,
  onClose,
  onCreatePage,
  onEditPage,
  onManageAccount,
  onManageCalendars,
  onManageConnections,
  onModalStateChange,
  onOpenSettings,
  onDateChange,
  onPageChange,
  onReorderPages,
  onSignOut,
  onRefreshServer,
  refreshingServer = false,
  pages,
  returnFocusRef,
  syncLabel,
  syncTone,
  user,
  weekStartsOn,
}: SidebarProps) {
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRefreshFocus = useRef(false);
  useEffect(() => {
    if (refreshingServer || !restoreRefreshFocus.current) return;
    restoreRefreshFocus.current = false;
    if (document.activeElement === document.body) refreshButtonRef.current?.focus();
  }, [refreshingServer]);

  const [signingOut, setSigningOut] = useState(false);
  const manageAccountAfterClose = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [reorderMessage, setReorderMessage] = useState("");
  /**
   * The order a drop asked for, held locally until the server's list shows it.
   *
   * Not cosmetic: React Query notifies subscribers in a later tick, so relying on
   * it would clear the drag's transforms one frame *before* the new order arrived
   * — and that frame shows the old order, which is the blink on drop. Owning the
   * order locally makes both changes land in the same commit.
   */
  const [committedOrder, setCommittedOrder] = useState<string[]>();
  const {
    begin: beginReorder,
    consumeClick: consumeReorderClick,
    drag: reorderDrag,
    settling: reorderSettling,
  } = useListReorder({
    onCommit: ({ from, to }) => {
      const pageIds = moveItem(pages, from, to).map((page) => page.id);
      setCommittedOrder(pageIds);
      void Promise.resolve(onReorderPages(pageIds)).catch(() =>
        // The write failed and the cache went back; stop overriding it.
        setCommittedOrder(undefined),
      );
    },
  });
  const orderedPages = committedOrder
    ? sortPagesBy(committedOrder, pages)
    : pages;
  const hasActivePage = orderedPages.some(page => page.id === activePageId);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const row = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!scroller || !row || !scroller.clientHeight) return;
      const viewport = scroller.getBoundingClientRect();
      const selected = row.getBoundingClientRect();
      if (selected.bottom > viewport.bottom) scroller.scrollTop += selected.bottom - viewport.bottom;
      else if (selected.top < viewport.top) scroller.scrollTop -= viewport.top - selected.top;
    });
    return () => cancelAnimationFrame(frame);
  }, [hasActivePage, activePageId, isOpen]);

  // Once the server's list agrees, the local order has nothing left to say.
  if (
    committedOrder &&
    pages.length === committedOrder.length &&
    pages.every((page, index) => page.id === committedOrder[index])
  ) {
    setCommittedOrder(undefined);
  }
  /**
   * How far each row is displaced from where the DOM puts it.
   *
   * The DOM order never changes during a drag — rows are translated to their
   * preview slot instead, so they glide there and the held row can follow the
   * pointer exactly rather than being re-rendered under it.
   */
  function rowShift(index: number): number {
    if (!reorderDrag) return 0;
    if (index === reorderDrag.from) return reorderDrag.dy;

    const boxes = reorderDrag.boxes;
    const target = previewIndex(index, reorderDrag.from, reorderDrag.to);
    const from = boxes[index];
    const to = boxes[target];
    return from && to ? to.top - from.top : 0;
  }

  /** Keyboard equivalent of the drag (R10), on the row that has focus. */
  function movePageBy(index: number, offset: number) {
    const to = index + offset;
    if (to < 0 || to >= orderedPages.length) return;
    const page = orderedPages[index];
    if (!page) return;
    const pageIds = moveItem(orderedPages, index, to).map((item) => item.id);
    setCommittedOrder(pageIds);
    void Promise.resolve(onReorderPages(pageIds)).catch(() =>
      setCommittedOrder(undefined),
    );
    setReorderMessage(
      `${page.name} moved to ${to + 1} of ${orderedPages.length}.`,
    );
  }
  const overlay = useDrawerViewport();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusOnCloseRef = useRef(false);
  const modal = overlay && isOpen;

  useEffect(() => {
    onModalStateChange?.(modal);
    if (!modal) {
      return;
    }

    const focusFrame = requestAnimationFrame(() =>
      closeButtonRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreFocusOnCloseRef.current = true;
      onModalStateChange?.(false);
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modal, onClose, onModalStateChange, returnFocusRef]);

  useEffect(() => {
    if (isOpen || !restoreFocusOnCloseRef.current) return;
    restoreFocusOnCloseRef.current = false;
    const focusFrame = requestAnimationFrame(() =>
      returnFocusRef?.current?.focus(),
    );
    return () => cancelAnimationFrame(focusFrame);
  }, [isOpen, returnFocusRef]);

  function closeAndRestoreFocus() {
    restoreFocusOnCloseRef.current = true;
    onModalStateChange?.(false);
    onClose();
  }

  return (
    <>
      {isOpen ? (
        <button
          className="fixed inset-0 z-25 cursor-default border-0 bg-foreground/35 md:hidden dark:bg-canvas/70"
          type="button"
          aria-label="Close navigation"
          onClick={closeAndRestoreFocus}
        />
      ) : null}
      <aside
        className={cn(
          "relative z-30 flex h-dvh min-w-0 flex-col border-r border-border-subtle bg-panel md:w-sidebar md:flex-none",
          // The drawer: off-canvas until opened. `transition-all` carries the
          // visibility too, so a closing drawer stays painted while it slides.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-80 max-md:max-w-4/5 max-md:transition-all max-md:duration-standard max-md:ease-out",
          isOpen ? "max-md:visible max-md:translate-x-0" : "max-md:pointer-events-none max-md:invisible max-md:-translate-x-full",
        )}
        aria-label="Workspace navigation"
        aria-hidden={overlay && !isOpen}
        inert={overlay && !isOpen}
      >
        <div className="flex min-h-16 flex-none items-center justify-center px-5 py-3 max-md:justify-between">
          <div className="flex items-center gap-2 text-10 tracking-wide text-foreground">
            <BrandMark aria-hidden="true" className="size-7" focusable="false" />
            <span>MUSUBI</span>
            {/* Said once, quietly, where the product names itself. */}
            <Badge>Alpha</Badge>
          </div>
          <Button
            aria-label="Close navigation"
            className="md:hidden"
            ref={closeButtonRef}
            size="icon-compact"
            title="Close navigation"
            variant="ghost"
            onClick={closeAndRestoreFocus}
          >
            <X aria-hidden="true" strokeWidth={1.7} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-sidebar-scroll="" ref={scrollRef}>
          <MiniCalendar
            showToday
            anchor={anchor}
            onDateChange={onDateChange}
            weekStartsOn={weekStartsOn}
          />
          <nav className="grid gap-2.5 px-3.5 py-4" aria-labelledby="pages-label">
            <div className="px-3">
              <SectionLabel id="pages-label">Pages</SectionLabel>
            </div>
            <div
              className="flex flex-col gap-1"
              data-page-list=""
              data-settling={reorderSettling ? "" : undefined}
            >
              {orderedPages.map((page, index) => (
                <PageRow
                  key={page.id}
                  active={page.id === activePageId}
                  held={reorderDrag?.from === index}
                  shift={rowShift(index)}
                  icon={pageIconComponent(
                    resolvePageIcon(page.config.icon, page.isDefault),
                  )}
                  name={page.name}
                  onEdit={() => onEditPage(page)}
                  onMoveBy={(offset) => movePageBy(index, offset)}
                  onPress={(event) =>
                    beginReorder({
                      boxes: pageRowRefs.current
                        .filter((node): node is HTMLDivElement => Boolean(node))
                        .map((node) => {
                          const box = node.getBoundingClientRect();
                          return { height: box.height, top: box.top };
                        }),
                      index,
                      pointerId: event.pointerId,
                      pointerType: event.pointerType,
                      time: event.timeStamp,
                      y: event.clientY,
                    })
                  }
                  onSelect={() => {
                    // A drag ended on this row; that release was not a choice.
                    if (consumeReorderClick()) return;
                    onPageChange(page.id);
                    onClose();
                  }}
                  ref={(node) => {
                    pageRowRefs.current[index] = node;
                  }}
                />
              ))}
              <SidebarRow>
                <RowAction
                  icon={<Plus strokeWidth={1.5} />}
                  label="New page"
                  showChevron={false}
                  size="compact"
                  onClick={() => {
                    onCreatePage();
                    onClose();
                  }}
                />
              </SidebarRow>
            </div>
            {/* Announces a keyboard move. A live region rather than role="status":
                the toast already owns that role, and two of them would make
                "the status message" ambiguous for both readers and tests. */}
            <span aria-live="polite" className="sr-only">
              {reorderMessage}
            </span>
          </nav>
        </div>

        <nav className="grid flex-none gap-1 px-3.5 pb-3.5" aria-label="Manage Musubi">
          <SidebarRow>
            <RowAction
              icon={<Layers3 strokeWidth={1.6} />}
              label="Calendars"
              showChevron={false}
              size="compact"
              onClick={onManageCalendars}
            />
          </SidebarRow>
          <SidebarRow>
            <RowAction
              icon={<Link2 strokeWidth={1.6} />}
              label="Connections"
              showChevron={false}
              size="compact"
              onClick={onManageConnections}
            />
          </SidebarRow>
          <SidebarRow>
            <RowAction
              icon={<Settings strokeWidth={1.6} />}
              label="Settings"
              showChevron={false}
              size="compact"
              onClick={onOpenSettings}
            />
          </SidebarRow>
        </nav>

        <footer className="grid flex-none gap-2 border-t border-border-subtle px-3.5 pt-2.5 pb-4 max-md:pb-safe-bottom">
          {/* The one place that says how current the calendar is. A slot of a
              fixed height with one line of text: the three states are different
              lengths, and letting the row grow would move the profile below it
              every time a refresh started.

              `aria-live`, not `role="status"`: this is a standing label rather
              than the app's announcement channel — the toast owns that role, and
              two of them make "the status" ambiguous for readers and tests
              alike. Changes still get announced. */}
          <div className="ml-2.5 flex items-center gap-2">
          <p
            aria-live="polite"
            className="flex min-h-5 min-w-0 flex-1 items-center gap-2 text-11 text-muted-foreground data-[tone=offline]:text-shu [&>svg]:size-3.5 [&>svg]:flex-none"
            data-tone={syncTone}
            title={syncLabel}
          >
            {syncTone === "offline" ? (
              <CloudOff aria-hidden="true" strokeWidth={1.6} />
            ) : syncTone === "refreshing" ? (
              <RefreshCw aria-hidden="true" strokeWidth={1.6} />
            ) : (
              <CircleCheck aria-hidden="true" strokeWidth={1.6} />
            )}
            <span className="min-w-0 truncate">{syncLabel}</span>
          </p>
          {onRefreshServer && <Button variant="ghost" size="icon-compact" aria-label="Refresh from server" title="Refresh from server" ref={refreshButtonRef} loading={refreshingServer} onClick={() => { restoreRefreshFocus.current = document.activeElement === refreshButtonRef.current; onRefreshServer(); }}><RefreshCw aria-hidden="true" /></Button>}
          </div>
          <div className="min-w-0 border-t border-border-subtle pt-2">
            <Menu>
              <SidebarRow>
                <MenuTrigger asChild>
                  <RowAction
                    aria-label={`User menu for ${user.name}`}
                    detail={user.email}
                    icon={<Avatar image={user.image} name={user.name} />}
                    label={user.name}
                    showChevron={false}
                    size="compact"
                  />
                </MenuTrigger>
              </SidebarRow>
              <MenuContent label="User account" side="top" align="start" onCloseAutoFocus={event => {
                  if (!manageAccountAfterClose.current) return;
                  manageAccountAfterClose.current = false;
                  event.preventDefault();
                  onManageAccount();
                }}>
                <MenuItem icon={<UserRound size={16} />} onSelect={() => { manageAccountAfterClose.current = true; }}>Manage account</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<LogOut size={16} />} disabled={signingOut} onSelect={() => {
                  setSigningOut(true);
                  onSignOut();
                }}>Sign out</MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </footer>
      </aside>
    </>
  );
}

/**
 * A page row is two controls, not one: selecting the page, and opening its
 * settings. The settings button is quiet until the row is hovered or holds
 * focus — but it is a real, tabbable button, so the keyboard never depends on a
 * pointer state, and on touch (no hover) it stays visible.
 */
const PageRow = forwardRef<
  HTMLDivElement,
  {
    active: boolean;
    held: boolean;
    icon: LucideIcon;
    name: string;
    onEdit: () => void;
    onMoveBy: (offset: number) => void;
    onPress: (event: ReactPointerEvent<HTMLElement>) => void;
    onSelect: () => void;
    /** Vertical displacement from the row's DOM slot, in pixels. */
    shift: number;
  }
>(function PageRow(
  {
    active,
    held,
    icon: Icon,
    name,
    onEdit,
    onMoveBy,
    onPress,
    onSelect,
    shift,
  },
  ref,
) {
  return (
    <div
      className="group/page-row relative flex-none translate-y-(--row-shift) overflow-hidden rounded-control transition-all duration-standard ease-out data-[held]:z-10 data-[held]:cursor-grabbing data-[held]:bg-raised data-[held]:shadow-overlay data-[held]:transition-shadow in-data-[settling]:transition-shadow motion-reduce:transition-none"
      data-held={held ? "" : undefined}
      data-page-row=""
      /* The edit action sits on the sumi fill of the selected row. */
      data-inverse={active ? "" : undefined}
      ref={ref}
      style={{ "--row-shift": `${shift}px` } as CSSProperties}
    >
      <RowAction
        aria-current={active ? "page" : undefined}
        icon={<Icon strokeWidth={1.6} />}
        label={name}
        selected={active}
        showChevron={false}
        size="compact"
        // Keeps the name clear of the edit action laid over the row's end.
        trailing={<span aria-hidden="true" className="block w-5" />}
        onClick={onSelect}
        onKeyDown={(event) => {
          // Alt+arrows move the row, the same shape as Alt+arrows on an event.
          if (!event.altKey) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onMoveBy(event.key === "ArrowDown" ? 1 : -1);
        }}
        onPointerDown={onPress}
      />
      <span className="absolute top-1/2 right-0.5 flex -translate-y-1/2 opacity-0 transition-opacity duration-fast group-focus-within/page-row:opacity-100 group-hover/page-row:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
        <Button
          aria-label={`Edit ${name}`}
          size="icon-compact"
          title="Page settings"
          variant="ghost"
          onClick={onEdit}
        >
          <MoreHorizontal aria-hidden="true" strokeWidth={1.8} />
        </Button>
      </span>
    </div>
  );
});
