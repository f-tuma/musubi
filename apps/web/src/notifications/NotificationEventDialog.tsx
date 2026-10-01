import type { Event, Settings } from "@musubi/types";
import { CalendarDays, Clock3, FileText, MapPin } from "lucide-react";
import { getEventDateLabel, getEventRangeLabel } from "~/calendar/calendar-math";
import { DetailList, DetailRow } from "~/calendar/components/EventPanel";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { InlineError } from "~/components/ui/inline-error";

type Props = {
  event?: Event;
  error?: boolean;
  loading?: boolean;
  timeFormat?: Settings["timeFormat"];
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onRetry: () => void;
  onEdit?: (event: Event) => void;
};

/** The subject is a live authorized projection, including readable cancellations. */
export function NotificationEventDialog({ event, error, loading, timeFormat, returnFocus, onClose, onRetry, onEdit }: Props) {
  const readable = error ? undefined : event;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-describedby={undefined} size="form" closeLabel="Close event" returnFocus={returnFocus}>
      <DialogHeader>
        <DialogTitle>{readable?.title ?? "Event"}</DialogTitle>
        {readable?.isCanceled ? <div><Badge variant="warning">Cancelled</Badge></div> : null}
      </DialogHeader>
      <DialogBody>
        {error ? <InlineError actions={<Button size="compact" variant="secondary" loading={loading} onClick={onRetry}>Retry</Button>}>Could not load event</InlineError> : readable ? (
          <DetailList>
            <DetailRow icon={<CalendarDays />} label="Date">{getEventDateLabel(readable)}</DetailRow>
            <DetailRow icon={<Clock3 />} label="Time">{getEventRangeLabel(readable, timeFormat)}</DetailRow>
            {readable.location ? <DetailRow icon={<MapPin />} label="Location">{readable.location}</DetailRow> : null}
            {readable.description ? <DetailRow icon={<FileText />} label="Notes"><span className="whitespace-pre-wrap">{readable.description}</span></DetailRow> : null}
          </DetailList>
        ) : <p className="text-13 text-muted-foreground">{loading ? "Loading event…" : "This event is no longer available."}</p>}
      </DialogBody>
      {readable && onEdit ? <DialogFooter><Button onClick={() => onEdit(readable)}>Edit</Button></DialogFooter> : null}
    </DialogContent>
  </Dialog>;
}
