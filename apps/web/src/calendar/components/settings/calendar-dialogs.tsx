import {
  can,
  DEFAULT_CALENDAR_COLOR,
  presetOptions,
  presetRule,
  presetValue,
  providerDisplayName,
  type Calendar,
  type ReminderRule,
} from "@musubi/types";
import { Trash2, Unlink } from "lucide-react";
import { type ChangeEvent, type FormEvent, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import type { ImportedCalendar } from "~/api/contracts";
import { ApiError, ApiResponseError } from "~/api/http";
import type { ReminderControl } from "~/calendar/reminder-control";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { ItemGroup } from "~/components/ui/item";
import { RowAction, RowOptions } from "~/components/ui/row";
import { Select, type SelectOption } from "~/components/ui/select";
import { ColorPicker } from "~/components/ui/color-picker";
import { connectionOfCalendar } from "../../federation-routing";
import { CalendarDot } from "../CalendarDot";

export type TransferError = {
  message: string;
  requestId?: string;
};

export type CalendarDestination = {
  accountId: string;
  flavor: string | null;
  label: string;
  provider: string;
};

export type ImportInput = {
  accountId?: string;
  color: string;
  ics: string;
  name: string;
  provider?: string;
};

type FocusTarget = HTMLElement | RefObject<HTMLElement | null> | null;

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

// A calendar rule is absent, not silent, when it follows the global default —
// so the control needs a value for "say nothing" that is not a rule.
const FOLLOW_DEFAULT = "default";

export function transferError(error: unknown, fallback: string): TransferError {
  return {
    message: error instanceof Error ? error.message : fallback,
    requestId: error instanceof ApiError || error instanceof ApiResponseError ? error.requestId : undefined,
  };
}

function exportFilename(calendar: Calendar) {
  return `${calendar.name.replace(/[^\w.-]+/g, "_") || "calendar"}.ics`;
}

function ErrorMessage({ error }: { error?: TransferError }) {
  return error ? <InlineError requestId={error.requestId}>{error.message}</InlineError> : null;
}

/** The small shell every calendar sub-dialog shares: title, one form, one commit. */
function FormDialog({
  busy,
  children,
  closeLabel,
  formId,
  initialFocus,
  onOpenChange,
  primary,
  returnFocus,
  title,
}: {
  busy: boolean;
  children: ReactNode;
  closeLabel: string;
  formId: string;
  initialFocus?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  primary: ReactNode;
  returnFocus?: FocusTarget;
  title: string;
}) {
  return (
    <Dialog open onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent
        aria-describedby={undefined}
        closeLabel={closeLabel}
        initialFocus={initialFocus}
        returnFocus={returnFocus}
        size="form"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy} variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button form={formId} loading={busy} type="submit">
            {primary}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NewCalendarDialog({
  destinationOptions,
  destinations,
  onCreate,
  onNotice,
  onOpenChange,
  returnFocus,
}: {
  destinationOptions: SelectOption[];
  destinations: CalendarDestination[];
  onCreate: (input: { accountId?: string; color: string; name: string; provider?: string }) => Promise<Calendar>;
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  returnFocus?: FocusTarget;
}) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_CALENDAR_COLOR);
  // "" is this server. Anything else is `provider:accountId`.
  const [destinationKey, setDestinationKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TransferError>();
  const destination = destinations.find((account) => `${account.provider}:${account.accountId}` === destinationKey);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError({ message: "Name the new calendar." });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const calendar = await onCreate({
        accountId: destination?.accountId,
        color,
        name: name.trim(),
        provider: destination?.provider,
      });
      onNotice(destination ? `${calendar.name} created in ${destination.label}.` : `${calendar.name} created.`);
      onOpenChange(false);
    } catch (failure) {
      setError(transferError(failure, "Could not create the calendar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      busy={busy}
      closeLabel="Close new calendar"
      formId={formId}
      initialFocus={inputRef}
      onOpenChange={onOpenChange}
      primary="Create"
      returnFocus={returnFocus}
      title="New calendar"
    >
      <form id={formId} noValidate onSubmit={(event) => void handleCreate(event)}>
        <FieldGroup>
          <div className="flex items-end gap-3">
            <Field className="flex-1" label="Name">
              <Input
                disabled={busy}
                maxLength={80}
                placeholder="New calendar"
                ref={inputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <ColorPicker
              disabled={busy}
              label="New calendar color"
              /* Match the destination provider's supported palette. */
              provider={destination?.provider ?? null}
              value={color}
              onChange={setColor}
            />
          </div>
          {destinations.length > 0 ? (
            <Field label="Account">
              <Select
                disabled={busy}
                label="Account"
                options={destinationOptions}
                value={destinationKey}
                onChange={setDestinationKey}
              />
            </Field>
          ) : null}
          <ErrorMessage error={error} />
        </FieldGroup>
      </form>
    </FormDialog>
  );
}

export function ImportCalendarDialog({
  destinationOptions,
  destinations,
  onImport,
  onNotice,
  onOpenChange,
  returnFocus,
}: {
  destinationOptions: SelectOption[];
  destinations: CalendarDestination[];
  onImport: (input: ImportInput) => Promise<ImportedCalendar>;
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  returnFocus?: FocusTarget;
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_CALENDAR_COLOR);
  const [destinationKey, setDestinationKey] = useState("");
  const [ics, setIcs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TransferError>();
  const destination = destinations.find((account) => `${account.provider}:${account.accountId}` === destinationKey);

  async function handleFile(changeEvent: ChangeEvent<HTMLInputElement>) {
    const file = changeEvent.target.files?.[0];
    setError(undefined);
    if (!file) {
      setIcs("");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setError({ message: "Choose an .ics file smaller than 10 MB." });
      changeEvent.target.value = "";
      return;
    }
    const text = await file.text();
    setIcs(text);
    // Reading a file is asynchronous; keep a name edited while it was loading.
    setName((current) => current || file.name.replace(/\.ics$/i, ""));
  }

  async function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ics.trim() || !name.trim()) {
      setError({ message: "Choose an .ics file and calendar name." });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const calendar = await onImport({
        accountId: destination?.accountId,
        color,
        ics,
        name: name.trim(),
        provider: destination?.provider,
      });
      onNotice(`Imported ${calendar.imported} event${calendar.imported === 1 ? "" : "s"} into ${calendar.name}.`);
      onOpenChange(false);
    } catch (importError) {
      setError(transferError(importError, "Could not import this calendar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      busy={busy}
      closeLabel="Close import"
      formId={formId}
      onOpenChange={onOpenChange}
      primary="Import"
      returnFocus={returnFocus}
      title="Import .ics"
    >
      <form id={formId} noValidate onSubmit={(event) => void handleImport(event)}>
        <FieldGroup>
          <Field label="Calendar file">
            <Input
              accept=".ics,text/calendar"
              data-calendar-file-control=""
              disabled={busy}
              type="file"
              onChange={(event) => void handleFile(event)}
            />
          </Field>
          <div className="flex items-end gap-3">
            <Field className="flex-1" label="Name">
              <Input
                disabled={busy}
                maxLength={80}
                placeholder="Calendar name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <ColorPicker
              disabled={busy}
              label="Imported calendar color"
              provider={destination?.provider ?? null}
              value={color}
              onChange={setColor}
            />
          </div>
          {destinations.length > 0 ? (
            <Field label="Import into">
              <Select
                disabled={busy}
                label="Import into account"
                options={destinationOptions}
                value={destinationKey}
                onChange={setDestinationKey}
              />
            </Field>
          ) : null}
          <ErrorMessage error={error} />
        </FieldGroup>
      </form>
    </FormDialog>
  );
}

export function ExportCalendarDialog({
  calendars,
  onExport,
  onNotice,
  onOpenChange,
  returnFocus,
}: {
  calendars: Calendar[];
  onExport: (calendarId: string, connectionId?: string) => Promise<string>;
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  returnFocus?: FocusTarget;
}) {
  const formId = useId();
  const [calendarId, setCalendarId] = useState(calendars[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TransferError>();
  const selectedId = calendars.some((calendar) => calendar.id === calendarId) ? calendarId : (calendars[0]?.id ?? "");

  async function handleExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const calendar = calendars.find((item) => item.id === selectedId);
    if (!calendar) return;
    setBusy(true);
    setError(undefined);
    try {
      const text = await onExport(calendar.id, connectionOfCalendar(calendar));
      const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportFilename(calendar);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      onNotice(`${calendar.name} exported.`);
      onOpenChange(false);
    } catch (exportError) {
      setError(transferError(exportError, "Could not export this calendar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      busy={busy}
      closeLabel="Close export"
      formId={formId}
      onOpenChange={onOpenChange}
      primary="Export"
      returnFocus={returnFocus}
      title="Export .ics"
    >
      <form id={formId} onSubmit={(event) => void handleExport(event)}>
        <FieldGroup>
          <Field label="Calendar">
            <Select
              disabled={busy}
              label="Calendar to export"
              options={calendars.map((calendar) => ({
                icon: <CalendarDot color={calendar.color} />,
                label: calendar.name,
                value: calendar.id,
              }))}
              value={selectedId}
              onChange={setCalendarId}
            />
          </Field>
          <ErrorMessage error={error} />
        </FieldGroup>
      </form>
    </FormDialog>
  );
}

/**
 * One calendar's own settings: how it looks, when it reminds you, and — at the
 * bottom, away from everything else — how to take it away.
 */
export function CalendarSettingsDialog({
  calendar,
  onDisconnect,
  onNotice,
  onOpenChange,
  onRemove,
  onRemoved,
  onUpdate,
  reminders,
  returnFocus,
}: {
  calendar: Calendar;
  onDisconnect: (calendar: Calendar) => Promise<unknown>;
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  onRemove: (calendar: Calendar) => Promise<Calendar>;
  /** The calendar is gone; the dialog has closed and its trigger with it. */
  onRemoved: () => void;
  onUpdate: (calendar: Calendar) => Promise<Calendar>;
  reminders?: ReminderControl;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const formId = useId();
  const [name, setName] = useState(calendar.name);
  const [color, setColor] = useState(calendar.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TransferError>();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<TransferError>();
  const inputRef = useRef<HTMLInputElement>(null);
  const removeActionRef = useRef<HTMLButtonElement>(null);
  // Naming it is an edit; deciding when it wakes your phone is not. A viewer
  // opens this dialog for the reminder row alone.
  const editable = can(calendar.role, "editCalendar");
  const federated = Boolean(connectionOfCalendar(calendar));
  const external = Boolean(calendar.provider) && !federated;
  // Deleting a synced calendar deletes it on the provider. "Stop syncing" is
  // the reversible thing to offer in its place.
  const deletable = editable && !external && !calendar.isDefault && can(calendar.role, "deleteCalendar");
  const provider = providerDisplayName(calendar);
  const rule = reminders?.document.calendars[calendar.id];
  const canSave = editable && Boolean(name.trim()) && (name.trim() !== calendar.name || color !== calendar.color);

  async function saveReminder(next: ReminderRule | null) {
    if (!reminders) return;
    setError(undefined);
    try {
      await reminders.onCalendarChange(calendar.id, next);
      onNotice("Reminder saved.");
    } catch (saveError) {
      setError(transferError(saveError, "Could not save the reminder."));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      await onUpdate({ ...calendar, color, name: name.trim() });
      onNotice("Calendar updated.");
      onOpenChange(false);
    } catch (saveError) {
      setError(transferError(saveError, "Could not update the calendar."));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setRemoveError(undefined);
    try {
      if (external) {
        await onDisconnect(calendar);
        onNotice(`Stopped syncing ${calendar.name}.`);
      } else {
        await onRemove(calendar);
        onNotice(`${calendar.name} deleted.`);
      }
      setConfirming(false);
      onRemoved();
      onOpenChange(false);
    } catch (failure) {
      setRemoveError(
        transferError(failure, external ? "Could not stop syncing this calendar." : "Could not delete the calendar."),
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          aria-describedby={undefined}
          closeLabel="Close calendar settings"
          initialFocus={editable ? inputRef : undefined}
          returnFocus={returnFocus}
          size="compact"
        >
          <DialogHeader>
            <DialogTitle>Calendar settings</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <form id={formId} onSubmit={(event) => void handleSubmit(event)}>
              <FieldGroup>
                {/* Name and colour are the same decision — what this calendar
                    looks like in a list — so they share one line. */}
                {editable ? (
                  <div className="flex items-end gap-3">
                    <Field className="flex-1" label="Name">
                      <Input
                        disabled={busy}
                        maxLength={80}
                        ref={inputRef}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    <ColorPicker
                      disabled={busy}
                      label={`${calendar.name} color`}
                      provider={calendar.provider}
                      value={color}
                      onChange={setColor}
                    />
                  </div>
                ) : null}
                {/* Saves on its own rather than waiting for Save: it is per
                    member, it goes to a different endpoint, and it is the only
                    thing in here a viewer can touch. */}
                {reminders ? (
                  <ItemGroup>
                    <RowOptions
                      disabled={busy}
                      label="Remind me"
                      stacked
                      options={[{ label: "Default", value: FOLLOW_DEFAULT }, ...presetOptions(rule)]}
                      value={rule ? presetValue(rule) : FOLLOW_DEFAULT}
                      onChange={(value) =>
                        void saveReminder(value === FOLLOW_DEFAULT ? null : (presetRule(value) ?? rule ?? null))
                      }
                    />
                  </ItemGroup>
                ) : null}
                <ErrorMessage error={error} />
              </FieldGroup>
            </form>
            {external || deletable ? (
              <ItemGroup>
                <RowAction
                  disabled={busy}
                  icon={external ? <Unlink /> : <Trash2 />}
                  label={external ? "Stop syncing" : "Delete calendar"}
                  ref={removeActionRef}
                  showChevron={false}
                  tone="destructive"
                  onClick={() => {
                    setRemoveError(undefined);
                    setConfirming(true);
                  }}
                />
              </ItemGroup>
            ) : null}
          </DialogBody>
          {editable ? (
            <DialogFooter>
              <Button disabled={!canSave} form={formId} loading={busy} type="submit">
                Save
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>

      {confirming ? (
        <ConfirmationDialog
          closeLabel={external ? "Close stop syncing confirmation" : "Close calendar deletion"}
          confirmLabel={external ? "Stop syncing" : "Delete calendar"}
          description={
            external
              ? `It stays in ${provider}, and the account stays connected.`
              : "Its events are removed for everyone it is shared with."
          }
          loading={removing}
          open
          returnFocus={removeActionRef}
          title={external ? `Stop syncing “${calendar.name}”?` : `Delete “${calendar.name}”?`}
          onConfirm={() => void handleRemove()}
          onOpenChange={(next) => {
            if (!next && !removing) {
              setConfirming(false);
              setRemoveError(undefined);
            }
          }}
        >
          {removeError ? <ErrorMessage error={removeError} /> : undefined}
        </ConfirmationDialog>
      ) : null}
    </>
  );
}
