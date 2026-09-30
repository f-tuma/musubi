import type {
  Calendar,
  CreatePageRequest,
  PageConfigV1,
  PageDocument,
  PageIcon,
} from "@musubi/types";
import { Check, Trash2 } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { Row, RowToggle } from "~/components/ui/row";
import { Select } from "~/components/ui/select";
import { SettingsSection } from "~/components/ui/settings-section";
import type { Notify } from "../notice";
import {
  calendarIdsForVisibility,
  toggleCalendarVisibility,
  visibilityEquals,
  type SavePageResult,
} from "../page-editor";
import {
  pageIconChoices,
  pageIconComponent,
  resolvePageIcon,
} from "../page-icons";
import type { Density } from "../time-geometry";
import { CalendarVisibilityPill } from "./CalendarVisibilityPill";
import { PAGE_ITEM_TYPES, pageItemTypes } from "../page-item-filters";

// Steps rather than a free number: every value between 12 and 16 weeks looks
// the same, and a spinner invites fiddling with a setting nobody tunes twice.
const WEEKS_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 16, 20].map((weeks) => ({
  label: weeks === 1 ? "1 week" : `${weeks} weeks`,
  value: String(weeks),
}));

const DENSITY_OPTIONS = [
  { label: "Compact", value: "compact" },
  { label: "Comfortable", value: "comfortable" },
  { label: "Spacious", value: "spacious" },
] as const;

export type PageSettingsDialogProps = {
  calendars: Calendar[];
  /** False for the last remaining page: the server would just backfill it. */
  canDelete: boolean;
  onCreatePage: (request: CreatePageRequest) => Promise<PageDocument>;
  onDeletePage: (id: string) => Promise<unknown>;
  onNotice: Notify;
  onOpenChange: (open: boolean) => void;
  /** Clear a shared Workspace draft after an explicit conflict resolution. */
  onResolveConflictDraft?: () => void;
  onSavePage: (input: {
    baseRevision: number;
    config: PageConfigV1;
    id: string;
    name: string;
  }) => Promise<SavePageResult>;
  onSetDefaultPage: (id: string) => Promise<unknown>;
  /** Follow a page created from a conflicting draft. */
  onOpenPage: (pageId: string, view: PageConfigV1["view"]["id"]) => void;
  page: PageDocument;
};

/**
 * Everything a Page is, in one explicit editor: name, icon, how its view is
 * presented and which calendars it shows.
 *
 * Mounted only while open and keyed on the page, so the draft — including the
 * revision it is based on — is set up once from the page it opened on. A
 * realtime update from another session bumps the cached Page underneath;
 * saving against the frozen base then returns 409 rather than overwriting it.
 */
export function PageSettingsDialog({
  calendars,
  canDelete,
  onCreatePage,
  onDeletePage,
  onNotice,
  onOpenChange,
  onOpenPage,
  onResolveConflictDraft,
  onSavePage,
  onSetDefaultPage,
  page,
}: PageSettingsDialogProps) {
  const [name, setName] = useState(page.name);
  const [icon, setIcon] = useState<PageIcon>(
    resolvePageIcon(page.config.icon, page.isDefault),
  );
  const [view, setView] = useState<PageConfigV1["view"]>(page.config.view);
  const [filters, setFilters] = useState(page.config.filters);
  const [visibility, setVisibility] = useState(page.config.calendarVisibility);
  const [busy, setBusy] = useState(false);
  const [isDefault, setIsDefault] = useState(page.isDefault);
  const [settingDefault, setSettingDefault] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<"delete" | "discard">();
  const [deleteError, setDeleteError] = useState("");
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const discardReturnFocusRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const trimmedName = name.trim();
  const dirty =
    trimmedName !== page.name ||
    icon !== resolvePageIcon(page.config.icon, page.isDefault) ||
    JSON.stringify(view) !== JSON.stringify(page.config.view) ||
    !visibilityEquals(visibility, page.config.calendarVisibility) ||
    JSON.stringify(filters) !== JSON.stringify(page.config.filters);
  const canSave = Boolean(trimmedName) && dirty && !busy;
  const visibleCalendarIds = calendarIdsForVisibility(visibility, calendars);

  const draftConfig = (): PageConfigV1 => ({
    ...page.config,
    calendarVisibility: visibility,
    filters,
    icon,
    view,
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Ctrl/Cmd+S saves, as it did in the old inline editor. The dialog traps
  // focus, so it is the only thing that can own the shortcut while open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function requestClose(nextOpen: boolean) {
    if (nextOpen) return;
    if (dirty) {
      const activeElement = document.activeElement;
      discardReturnFocusRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      setConfirmation("discard");
      return;
    }
    onOpenChange(false);
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const result = await onSavePage({
        baseRevision: page.revision,
        config: draftConfig(),
        id: page.id,
        name: trimmedName,
      });
      if (result.status === "conflict") {
        setConflict(true);
        return;
      }
      onNotice("Page saved.");
      onOpenChange(false);
    } catch {
      setError(
        "This page could not be saved. Your changes are still here — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveAsCopy() {
    setBusy(true);
    setError("");
    try {
      const created = await onCreatePage({
        config: draftConfig(),
        name: `${trimmedName || page.name} copy`,
      });
      onResolveConflictDraft?.();
      onNotice("Saved as a new page.");
      onOpenChange(false);
      onOpenPage(created.id, created.config.view.id);
    } catch {
      setError(
        "The new page could not be created. Nothing was added — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    // Soft-deleted server-side with no restore endpoint, so an Undo toast would
    // be a promise we can't keep — this delete earns its confirm.
    setBusy(true);
    setDeleteError("");
    try {
      await onDeletePage(page.id);
      // Closing is the feedback, together with the row leaving the sidebar: the
      // route sends the calendar to the default page if this was the open one.
      setConfirmation(undefined);
      onOpenChange(false);
    } catch {
      setDeleteError(
        "This page could not be deleted. It is still here — try again.",
      );
      setBusy(false);
    }
  }

  async function setAsDefault() {
    if (isDefault || busy) return;
    setBusy(true);
    setSettingDefault(true);
    setError("");
    try {
      await onSetDefaultPage(page.id);
      setIsDefault(true);
      onNotice(`“${page.name}” is now the default Page.`);
    } catch {
      setError(
        "The default page could not be changed. It is still the one it was — try again.",
      );
    } finally {
      setSettingDefault(false);
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save();
  }

  return (
    <>
      <Dialog open onOpenChange={requestClose}>
        <DialogContent
          aria-describedby={undefined}
          closeLabel="Close page settings"
          initialFocus={nameRef}
          size="default"
          tall
        >
          <DialogHeader>
            <div className="flex items-center gap-1">
              <DialogTitle>Page settings</DialogTitle>
              <HelpTooltip label="About page settings">
                Applies to this page only, on every device.
              </HelpTooltip>
            </div>
          </DialogHeader>
          <DialogBody>
            <form
              className="flex flex-col gap-6"
              id="page-settings-form"
              onSubmit={handleSubmit}
            >
              {conflict ? (
                <InlineError>
                  <span className="block font-medium">This page changed on another device</span>
                  Your edits weren’t saved. Keep them as a new page, or discard them.
                </InlineError>
              ) : null}

              <PageIdentityFields
                busy={busy}
                icon={icon}
                iconName="page-settings-icon"
                name={name}
                nameRef={nameRef}
                onIconChange={setIcon}
                onNameChange={setName}
              />

              <SettingsSection title="General" help="The default page opens when Musubi starts.">
                <Row
                  label="Default page"
                  layout="responsive-actions"
                  trailing={
                    isDefault ? (
                      <Badge variant="muted">
                        <Check aria-hidden="true" strokeWidth={1.8} />
                        Default
                      </Badge>
                    ) : (
                      <Button
                        disabled={busy}
                        loading={settingDefault}
                        size="compact"
                        variant="secondary"
                        onClick={() => void setAsDefault()}
                      >
                        Set as default
                      </Button>
                    )
                  }
                />
              </SettingsSection>

              <SettingsSection title="Presentation" help="Row height sets hour spacing in the calendar grid. Weekend shows Saturday and Sunday. Nearby months shows days from the previous and next months.">
                  {"density" in view ? (
                    <Row
                      label="Row height"
                      trailing={
                        <Select
                          disabled={busy}
                          label="Row height"
                          options={DENSITY_OPTIONS}
                          size="compact"
                          value={view.density}
                          onChange={(value) =>
                            setView((current) =>
                              "density" in current
                                ? { ...current, density: value as Density }
                                : current,
                            )
                          }
                        />
                      }
                    />
                  ) : null}
                  {"weeks" in view ? (
                    <Row
                      label="Weeks shown"
                      trailing={
                        <Select
                          disabled={busy}
                          label="Weeks shown"
                          options={WEEKS_OPTIONS}
                          size="compact"
                          value={String(view.weeks)}
                          onChange={(value) =>
                            setView((current) =>
                              "weeks" in current
                                ? { ...current, weeks: Number(value) }
                                : current,
                            )
                          }
                        />
                      }
                    />
                  ) : null}
                  {"weekend" in view ? (
                    <RowToggle
                      checked={view.weekend}
                      disabled={busy}
                      label="Weekend"
                      onCheckedChange={(weekend) =>
                        setView((current) =>
                          "weekend" in current ? { ...current, weekend } : current,
                        )
                      }
                    />
                  ) : null}
                  {"showAdjacentDays" in view ? (
                    <RowToggle
                      checked={view.showAdjacentDays}
                      disabled={busy}
                      label="Nearby months"
                      onCheckedChange={(showAdjacentDays) =>
                        setView((current) =>
                          "showAdjacentDays" in current
                            ? { ...current, showAdjacentDays }
                            : current,
                        )
                      }
                    />
                  ) : null}
                </SettingsSection>

              <SettingsSection title="Filters">
                {PAGE_ITEM_TYPES.map(type => (
                  <RowToggle key={type} label={{ events: "Events", tasks: "Tasks", meetings: "Meetings" }[type]}
                    checked={pageItemTypes(filters).includes(type)} disabled={busy}
                    onCheckedChange={checked => setFilters(current => {
                      const selected = pageItemTypes(current);
                      const value = PAGE_ITEM_TYPES.filter(item => item === type ? checked : selected.includes(item));
                      const others = current.filter(filter => filter.type !== "item-types");
                      return value.length === PAGE_ITEM_TYPES.length ? others : [...others, { type: "item-types", value }];
                    })} />
                ))}
              </SettingsSection>

              {/* Calendar visibility belongs to the Page, so it is configured here
                with its other saved presentation choices instead of in the
                calendar toolbar. */}
              <SettingsSection title="Calendars">
                <fieldset
                  aria-label="Calendars shown on this page"
                  className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-4"
                  disabled={busy}
                >
                  {calendars.map((calendar) => (
                    <CalendarVisibilityPill
                      calendar={calendar}
                      key={calendar.id}
                      visible={visibleCalendarIds.includes(calendar.id)}
                      onVisibleChange={() =>
                        setVisibility((current) =>
                          toggleCalendarVisibility(current, calendar.id, calendars),
                        )
                      }
                    />
                  ))}
                  {calendars.length === 0 ? (
                    <p className="text-13 text-muted-foreground">No calendars yet</p>
                  ) : null}
                </fieldset>
              </SettingsSection>

              {error ? <InlineError>{error}</InlineError> : null}
            </form>
          </DialogBody>
          <DialogFooter>
            {conflict ? (
              <>
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() => {
                    onResolveConflictDraft?.();
                    onOpenChange(false);
                  }}
                >
                  Discard my changes
                </Button>
                <Button loading={busy} onClick={() => void saveAsCopy()}>
                  Save as a copy
                </Button>
              </>
            ) : (
              <>
                {canDelete ? (
                  <Button
                    className="sm:mr-auto"
                    disabled={busy}
                    ref={deleteButtonRef}
                    variant="ghost"
                    onClick={() => {
                      setDeleteError("");
                      setConfirmation("delete");
                    }}
                  >
                    <Trash2 aria-hidden="true" strokeWidth={1.7} />
                    Delete page
                  </Button>
                ) : null}
                <Button
                  disabled={busy}
                  onClick={() => requestClose(false)}
                  variant="secondary"
                >
                  Cancel
                </Button>
                <Button
                  disabled={!canSave}
                  form="page-settings-form"
                  loading={busy}
                  type="submit"
                >
                  Save
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmationDialog
        closeLabel="Close discard changes confirmation"
        confirmLabel="Discard changes"
        description={`Your edits to “${page.name}” will be lost.`}
        onConfirm={() => {
          setConfirmation(undefined);
          onOpenChange(false);
        }}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setConfirmation(undefined);
        }}
        open={confirmation === "discard"}
        returnFocus={discardReturnFocusRef}
        title="Discard page changes?"
      />

      <ConfirmationDialog
        closeLabel="Close delete page confirmation"
        confirmLabel="Delete page"
        description={`“${page.name}” disappears from every device. This cannot be undone.`}
        loading={busy && confirmation === "delete"}
        onConfirm={() => void remove()}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) setConfirmation(undefined);
        }}
        open={confirmation === "delete"}
        returnFocus={deleteButtonRef}
        title={`Delete “${page.name}”?`}
      >
        {deleteError ? <InlineError>{deleteError}</InlineError> : null}
      </ConfirmationDialog>
    </>
  );
}

/** Name and icon: what a Page is called and how it looks in the sidebar. */
function PageIdentityFields({
  busy,
  icon,
  iconName,
  name,
  nameRef,
  onIconChange,
  onNameChange,
  placeholder,
}: {
  busy: boolean;
  icon: PageIcon;
  iconName: string;
  name: string;
  nameRef: RefObject<HTMLInputElement | null>;
  onIconChange: (icon: PageIcon) => void;
  onNameChange: (name: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldGroup>
      <Field label="Page name">
        <Input
          disabled={busy}
          maxLength={80}
          placeholder={placeholder}
          ref={nameRef}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </Field>
      <IconField
        disabled={busy}
        name={iconName}
        value={icon}
        onChange={onIconChange}
      />
    </FieldGroup>
  );
}

/**
 * Native radios in a grid: arrow-key movement, the checked state and a real
 * accessible name all come from the platform, so there is no roving tabindex or
 * `aria-selected` bookkeeping to get wrong.
 */
function IconField({
  disabled,
  name,
  onChange,
  value,
}: {
  disabled: boolean;
  /** Radio group name — unique per dialog, so two open forms never merge. */
  name: string;
  onChange: (icon: PageIcon) => void;
  value: PageIcon;
}) {
  return (
    <fieldset className="group/icons m-0 min-w-0 border-0 p-0" disabled={disabled}>
      {/* The twelve glyphs say what this is; a label over them is a word the
          eye has to step past every time. The group keeps its name for anyone
          who cannot see the glyphs. */}
      <legend className="sr-only">Icon</legend>
      {/* Four columns on a phone keep every tile a comfortable target. */}
      <div className="grid grid-cols-4 gap-x-2 gap-y-3 sm:grid-cols-6">
        {pageIconChoices.map((choice) => {
          const Icon = pageIconComponent(choice.icon);

          return (
            <label
              className="relative grid min-h-control cursor-pointer place-items-center rounded-md border border-border-subtle text-foreground-secondary transition-colors duration-fast hover:border-border hover:text-foreground has-checked:border-shu has-checked:bg-shu/10 has-checked:text-shu group-disabled/icons:cursor-not-allowed group-disabled/icons:text-faint group-disabled/icons:hover:border-border-subtle"
              key={choice.icon}
              title={choice.label}
            >
              {/* The radio is the whole tile, so a click anywhere lands on the
                  control and the global keyboard ring draws around the tile. */}
              <input
                aria-label={choice.label}
                checked={value === choice.icon}
                className="absolute inset-0 m-0 cursor-pointer appearance-none rounded-md disabled:cursor-not-allowed"
                name={name}
                type="radio"
                value={choice.icon}
                onChange={() => onChange(choice.icon)}
              />
              <Icon aria-hidden="true" className="pointer-events-none relative" size={19} strokeWidth={1.6} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Creating a page asks only what the page cannot be born without: a name and an
 * icon. Everything else it inherits from the view it was created in, and the
 * settings dialog is one click away for the rest.
 */
export function NewPageDialog({
  onCreate,
  onOpenChange,
}: {
  onCreate: (input: { icon: PageIcon; name: string }) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<PageIcon>("calendar-days");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const trimmedName = name.trim();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({ icon, name: trimmedName });
      onOpenChange(false);
    } catch {
      setError(
        "The new page could not be created. Nothing was added — try again.",
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        closeLabel="Close new page"
        initialFocus={nameRef}
        size="compact"
      >
        <DialogHeader>
          <div className="flex items-center gap-1">
            <DialogTitle>New page</DialogTitle>
            <HelpTooltip label="About new pages">
              It starts from the calendars you can see right now.
            </HelpTooltip>
          </div>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-5"
            id="new-page-form"
            onSubmit={(event) => void submit(event)}
          >
            <PageIdentityFields
              busy={busy}
              icon={icon}
              iconName="new-page-icon"
              name={name}
              nameRef={nameRef}
              placeholder="Work, Family, Training…"
              onIconChange={setIcon}
              onNameChange={setName}
            />
            {error ? <InlineError>{error}</InlineError> : null}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            variant="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={!trimmedName || busy}
            form="new-page-form"
            loading={busy}
            type="submit"
          >
            Create page
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
