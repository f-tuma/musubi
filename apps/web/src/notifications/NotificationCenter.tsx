import { Bell, CalendarDays, CircleAlert, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty } from "~/components/ui/empty";
import { InlineError } from "~/components/ui/inline-error";
import { ItemGroup } from "~/components/ui/item";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Row, RowAction } from "~/components/ui/row";
import type { AppNotification } from "./model";

type Props = {
  items: AppNotification[];
  readIds: Set<string>;
  loading?: boolean;
  error?: boolean;
  eventError?: boolean;
  hasMore?: boolean;
  onRead: (ids: string[]) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onActivate: (item: AppNotification, returnFocus: HTMLElement | null) => void;
};

export function NotificationCenter({ items, readIds, loading, error, eventError, hasMore, onRead, onRefresh, onLoadMore, onActivate }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actionAfterClose = useRef<AppNotification | null>(null);
  const attention = items.filter(item => item.needsAttention).length;
  const unread = items.filter(item => !item.needsAttention && !readIds.has(item.id)).length;
  const count = attention + unread;
  const label = `Notifications${count ? ` · ${count} new or needing attention` : ""}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button aria-label={label} title={label} ref={triggerRef} size="icon-compact" variant="ghost">
          <span className="relative inline-flex">
            <Bell aria-hidden="true" />
            {count ? <span aria-hidden="true" className="absolute -right-1 -top-1 size-2 rounded-full bg-shu" /> : null}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Notifications"
        className="w-96"
        onCloseAutoFocus={event => {
          const item = actionAfterClose.current;
          if (!item) return;
          actionAfterClose.current = null;
          event.preventDefault();
          triggerRef.current?.focus();
          onActivate(item, triggerRef.current);
        }}
      >
        <PopoverHeader>
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle>Notifications</PopoverTitle>
            <Button aria-label="Refresh notifications" size="icon-compact" variant="ghost" loading={loading} onClick={onRefresh}>
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {attention ? <Badge variant="warning">{attention} need attention</Badge> : null}
            {unread ? <Button size="compact" variant="ghost" onClick={() => onRead(items.filter(item => !item.needsAttention).map(item => item.id))}>Mark all as read</Button> : null}
          </div>
        </PopoverHeader>
        <div className="max-h-96 overflow-y-auto p-4" data-notifications-body="">
          {error ? <InlineError actions={<Button variant="secondary" size="compact" loading={loading} onClick={onRefresh}>Retry</Button>}>Could not load deliveries</InlineError> : null}
          {eventError ? <InlineError actions={<Button variant="secondary" size="compact" loading={loading} onClick={onRefresh}>Retry</Button>}>Could not load event changes</InlineError> : null}
          {loading && items.length === 0 ? <Row label="Loading notifications…" /> : null}
          {!loading && !error && !eventError && items.length === 0 ? <Empty title="You're up to date" icon={<Bell />} /> : null}
          {items.length ? <ItemGroup>
            {items.map(item => (
              <RowAction
                key={item.id}
                data-notification-id={item.id}
                label={item.title}
                detail={item.detail}
                icon={item.needsAttention ? <CircleAlert aria-hidden="true" /> : <CalendarDays aria-hidden="true" />}
                value={!item.needsAttention && !readIds.has(item.id) ? "New" : undefined}
                onClick={() => {
                  onRead([item.id]);
                  actionAfterClose.current = item;
                  setOpen(false);
                }}
              />
            ))}
          </ItemGroup> : null}
          {hasMore ? <div className="mt-3 flex justify-end"><Button variant="secondary" size="compact" loading={loading} onClick={onLoadMore}>Load more</Button></div> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
