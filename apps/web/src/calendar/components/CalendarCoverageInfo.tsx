import { Info, X } from "lucide-react";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { focusMovedToAnotherLayer } from "../layer-focus";

/** Standing provider limits stay available without taking space from events. */
export function CalendarCoverageInfo({ message }: { message: string }) {
  const descriptionId = useId();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label="Calendar sync coverage" title="Calendar sync coverage" size="icon-compact" variant="ghost">
          <Info aria-hidden="true" strokeWidth={1.6} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-describedby={descriptionId}
        aria-label="Calendar sync coverage"
        onClick={(event) => event.stopPropagation()}
        onFocusOutside={(event) => {
          if (!focusMovedToAnotherLayer(event.target)) event.preventDefault();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between gap-2 pt-2 pr-2 pl-4">
          <PopoverTitle>Sync coverage</PopoverTitle>
          <PopoverClose asChild>
            <Button aria-label="Close sync coverage" title="Close sync coverage" size="icon-compact" variant="ghost">
              <X aria-hidden="true" strokeWidth={1.6} />
            </Button>
          </PopoverClose>
        </div>
        <div className="px-4 pb-4">
          <PopoverDescription id={descriptionId}>{message}</PopoverDescription>
        </div>
      </PopoverContent>
    </Popover>
  );
}
