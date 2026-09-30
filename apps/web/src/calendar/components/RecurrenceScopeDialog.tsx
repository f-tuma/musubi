import type { EditScope } from "@musubi/calendar";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { InlineError } from "~/components/ui/inline-error";
import { ItemGroup } from "~/components/ui/item";
import { RowAction } from "~/components/ui/row";
import { Spinner } from "~/components/ui/spinner";

const OPTION_LABELS: Record<
  "change" | "delete" | "cancel",
  Array<{ label: string; scope: EditScope }>
> = {
  change: [
    { label: "This event", scope: "occurrence" },
    { label: "This and following events", scope: "following" },
    { label: "All events", scope: "series" },
  ],
  cancel: [
    { label: "This occurrence", scope: "occurrence" },
    { label: "Entire series", scope: "series" },
  ],
  delete: [
    { label: "This event", scope: "occurrence" },
    { label: "This and following events", scope: "following" },
    { label: "Entire series", scope: "series" },
  ],
};

/**
 * Which occurrences a change to a recurring event applies to.
 *
 * Asked up front rather than offered as Undo afterwards: the three answers are
 * different edits, not one edit to take back, and the choice cannot be guessed
 * from the gesture. The new time is spelled out because the calendar behind the
 * dialog still shows the old one — nothing is written until an answer comes.
 * Each scope is one row, and choosing a row is the commitment.
 */
export function RecurrenceScopeDialog({
  action = "change",
  allowedScopes,
  busyScope,
  consequence,
  error,
  onResolve,
  returnFocus,
  timeLabel,
  title,
}: {
  action?: "change" | "delete" | "cancel";
  allowedScopes?: readonly EditScope[];
  busyScope?: EditScope;
  consequence?: string;
  error?: { message: string; requestId?: string };
  /** The chosen scope, or undefined when dismissed. */
  onResolve: (scope: EditScope | undefined) => void;
  /**
   * Where focus was when the gesture happened. There is no trigger to return to
   * — a drag or Alt+arrow opened this — so it is carried in.
   */
  returnFocus?: HTMLElement | null;
  timeLabel?: string;
  title: string;
}) {
  const deleting = action !== "change";
  const cancelling = action === "cancel";
  const description = cancelling
    ? `Which meetings in “${title}” should Outlook cancel?`
    : deleting
      ? `Choose which events to remove from “${title}”.`
      : timeLabel
        ? // The calendar behind the dialog still shows the old time, so the
          // new one is spelled out rather than pointed at.
          `“${title}” moves to ${timeLabel}. Which events should change?`
        : `Which events should take the changes to “${title}”?`;

  return (
    <Dialog
      /* No Cancel button: the header's close button and Escape both resolve this
         the same way, and a footer for one of them made backing out look like a
         choice on par with the scopes. */
      onOpenChange={(open) => {
        if (!open && !busyScope) onResolve(undefined);
      }}
      open
    >
      <DialogContent
        size="compact"
        closeLabel={`Close ${cancelling ? "cancel" : deleting ? "delete" : "change"} recurring event dialog`}
        /* Always raised from an event's own layer — the preview popover or a drag
           over the grid — so it has to clear the surface that asked. */
        elevated
        returnFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>{cancelling ? "Cancel recurring meeting" : deleting ? "Delete recurring event" : "Change recurring event"}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {consequence ? <p className="text-13 leading-normal text-foreground-secondary">{consequence}</p> : null}
          {error ? <InlineError requestId={error.requestId}>{error.message}</InlineError> : null}
          <ItemGroup>
            {OPTION_LABELS[action]
              .filter((option) => !allowedScopes || allowedScopes.includes(option.scope))
              .map((option) => (
                <RowAction
                  aria-busy={busyScope === option.scope || undefined}
                  disabled={Boolean(busyScope)}
                  key={option.scope}
                  label={option.label}
                  tone={deleting ? "destructive" : "default"}
                  trailing={busyScope === option.scope ? <Spinner /> : undefined}
                  onClick={() => onResolve(option.scope)}
                />
              ))}
          </ItemGroup>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
