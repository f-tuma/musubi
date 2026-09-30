import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getEventDeliveryInbox } from "~/api/resources";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Row, RowAction } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { focusDialogBody } from "./dialog-focus";
import { EventDeliveryDialog } from "./EventDeliveryDialog";

type Props = {
  userId: string;
  connectionId?: string;
  onClose: () => void;
  returnFocus: HTMLElement | null;
};

export function EventDeliveryInboxDialog({
  userId,
  connectionId,
  onClose,
  returnFocus,
}: Props) {
  const [selected, setSelected] = useState<{
    id: string;
    trigger: HTMLElement;
  }>();
  const query = useInfiniteQuery({
    queryKey: [
      ...queryKeys.delivery(getServerOrigin(), userId, connectionId),
      "inbox",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      getEventDeliveryInbox(pageParam, signal, connectionId),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    refetchOnMount: "always",
  });
  const items = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.eventId, item]),
    ).values(),
  ];
  return (
    <div
      className="contents"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent onOpenAutoFocus={focusDialogBody} size="form" closeLabel="Close unfinished deliveries" returnFocus={returnFocus} aria-describedby={undefined}>
          <DialogHeader>
            <div className="flex items-center gap-1">
              <DialogTitle>Unfinished deliveries</DialogTitle>
              <HelpTooltip label="About unfinished deliveries">
                Your saved changes that still need delivery or attention, including deleted events. Only your own saved changes are listed.
              </HelpTooltip>
            </div>
          </DialogHeader>
          <DialogBody>
            {query.isError ? (
              <InlineError>
                Could not load unfinished deliveries. This server may be
                unavailable or may need an update.
              </InlineError>
            ) : null}
            <SettingsSection title="Saved changes">
              {query.isPending ? <Row label="Loading saved deliveries…" /> : null}
              {!query.isError && query.data && items.length === 0 ? (
                <Row label="No unfinished deliveries found" />
              ) : null}
              {!query.isError
                ? items.map((item) => (
                    <RowAction
                      key={item.eventId}
                      label={item.savedTitle || "Untitled event"}
                      detail="Open delivery records · saved title"
                      onClick={(event) =>
                        setSelected({
                          id: item.eventId,
                          trigger: event.currentTarget,
                        })
                      }
                    />
                  ))
                : null}
              {query.hasNextPage ? (
                <Row
                  label="More saved deliveries"
                  trailing={
                    <Button
                      disabled={query.isFetching}
                      size="compact"
                      variant="secondary"
                      onClick={() => void query.fetchNextPage()}
                    >
                      Load more
                    </Button>
                  }
                />
              ) : null}
            </SettingsSection>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh list
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {selected ? (
        <EventDeliveryDialog
          key={`${userId}:${connectionId ?? "home"}:${selected.id}`}
          userId={userId}
          connectionId={connectionId}
          eventId={selected.id}
          returnFocus={selected.trigger}
          onClose={() => setSelected(undefined)}
        />
      ) : null}
    </div>
  );
}
