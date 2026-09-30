import * as React from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

type ConfirmationAction =
  | { confirmForm: string; onConfirm?: never }
  | { confirmForm?: undefined; onConfirm: () => void };

type ConfirmationDialogProps = ConfirmationAction & {
  cancelLabel?: React.ReactNode;
  children?: React.ReactNode;
  closeLabel?: string;
  confirmDisabled?: boolean;
  confirmLabel: React.ReactNode;
  confirmVariant?: "destructive" | "primary";
  description?: React.ReactNode;
  elevated?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocus?: HTMLElement | React.RefObject<HTMLElement | null> | null;
  title: React.ReactNode;
};

/**
 * A consequential choice with one safe exit and one explicit commit.
 *
 * Cancel takes initial focus, so opening a destructive prompt never puts the
 * irreversible action under the next keystroke. A typed confirmation can move
 * that focus to its field.
 */
function ConfirmationDialog({
  cancelLabel = "Cancel",
  children,
  closeLabel = "Close",
  confirmDisabled = false,
  confirmForm,
  confirmLabel,
  confirmVariant = "destructive",
  description,
  elevated,
  initialFocus,
  loading = false,
  onConfirm,
  onOpenChange,
  open,
  returnFocus,
  title,
}: ConfirmationDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="compact"
        closeLabel={closeLabel}
        elevated={elevated}
        initialFocus={initialFocus ?? cancelRef}
        returnFocus={returnFocus}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <DialogBody>{children}</DialogBody> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={loading} ref={cancelRef} variant="secondary">
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            disabled={confirmDisabled}
            form={confirmForm}
            loading={loading}
            type={confirmForm ? "submit" : "button"}
            variant={confirmVariant}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmationDialog, type ConfirmationDialogProps };
