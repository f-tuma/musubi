import { providerDisplayName, providerFlavor, type Calendar } from "@musubi/types";
import { Download, FileUp, Plus, Settings2, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ImportedCalendar } from "~/api/contracts";
import { groupCalendars, type CalendarSourceGroup } from "~/calendar/calendar-groups";
import type { ReminderControl } from "~/calendar/reminder-control";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ItemGroup } from "~/components/ui/item";
import { Row, RowAction } from "~/components/ui/row";
import { SectionLabel } from "~/components/ui/section-label";
import { connectionOfCalendar } from "../../federation-routing";
import { CalendarDot } from "../CalendarDot";
import { AccountMark } from "../ProviderIcon";
import { ProviderOrganizerCreateAction } from "../ProviderOrganizerEditor";
import {
  CalendarSettingsDialog,
  ExportCalendarDialog,
  ImportCalendarDialog,
  NewCalendarDialog,
  type CalendarDestination,
  type ImportInput,
} from "./calendar-dialogs";
import { Hint } from "./hint";

export type CalendarsPanelProps = {
  calendars: Calendar[];
  onCreate: (input: { accountId?: string; color: string; name: string; provider?: string }) => Promise<Calendar>;
  onCreateMeeting?: (calendar: Calendar, target: HTMLElement) => void;
  onDisconnect: (calendar: Calendar) => Promise<unknown>;
  onExport: (calendarId: string, connectionId?: string) => Promise<string>;
  onImport: (input: ImportInput) => Promise<ImportedCalendar>;
  onManageMembers: (calendar: Calendar) => void;
  onNotice: (message: string) => void;
  onRemove: (calendar: Calendar) => Promise<Calendar>;
  onUpdate: (calendar: Calendar) => Promise<Calendar>;
  /** Absent hides the reminder row — a story need not build a rules document. */
  reminders?: ReminderControl;
};

type OpenDialog = { kind: "create" } | { kind: "import" } | { kind: "export" } | { calendar: Calendar; kind: "edit" };

function calendarDetail(calendar: Calendar) {
  if (calendar.syncStatus === "reconnect_required") return "Reconnect in Connections";
  if (calendar.role === "owner") return "Owner";
  // Editors can change events, but only the owner can rename the calendar.
  return calendar.role === "editor" ? "Can edit" : "View only";
}

/** Every calendar, grouped by where it lives, and the ways to add or move one. */
export function CalendarsPanel({
  calendars,
  onCreate,
  onCreateMeeting,
  onDisconnect,
  onExport,
  onImport,
  onManageMembers,
  onNotice,
  onRemove,
  onUpdate,
  reminders,
}: CalendarsPanelProps) {
  const [dialog, setDialog] = useState<OpenDialog>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const groups = groupCalendars(calendars);

  /**
   * The accounts a new calendar can be made in.
   *
   * Read off the calendars already synced, the same way the phone does it: an
   * account with no calendar in it has nothing to hang a label on, and the sync
   * engine gives every connected account at least its default one.
   */
  const destinations = useMemo(() => {
    const seen = new Map<string, CalendarDestination>();
    for (const calendar of calendars) {
      if (!calendar.provider || !calendar.accountId) continue;
      if (connectionOfCalendar(calendar)) continue; // another Musubi server
      const key = `${calendar.provider}:${calendar.accountId}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        accountId: calendar.accountId,
        flavor: providerFlavor(calendar),
        label: calendar.accountLabel?.trim() || providerDisplayName(calendar),
        provider: calendar.provider,
      });
    }
    return [...seen.values()];
  }, [calendars]);

  const destinationOptions = [
    { description: "This server", icon: <AccountMark flavor={null} size="compact" />, label: "Musubi", value: "" },
    ...destinations.map((account) => ({
      description: providerDisplayName({ provider: account.provider }),
      icon: <AccountMark flavor={account.flavor} size="compact" />,
      label: account.label,
      value: `${account.provider}:${account.accountId}`,
    })),
  ];

  function open(next: OpenDialog, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setDialog(next);
  }

  const close = (nextOpen: boolean) => {
    if (!nextOpen) setDialog(undefined);
  };

  return (
    <>
      <ItemGroup>
        <RowAction
          icon={<Plus />}
          label="New calendar"
          ref={createRef}
          onClick={(event) => open({ kind: "create" }, event.currentTarget)}
        />
        <RowAction
          icon={<FileUp />}
          label="Import .ics"
          onClick={(event) => open({ kind: "import" }, event.currentTarget)}
        />
        <RowAction
          disabled={calendars.length === 0}
          icon={<Download />}
          label="Export .ics"
          onClick={(event) => open({ kind: "export" }, event.currentTarget)}
        />
      </ItemGroup>

      {groups.map((group) => (
        <CalendarGroup
          group={group}
          key={group.key}
          onCreateMeeting={onCreateMeeting}
          onEdit={(calendar, trigger) => open({ calendar, kind: "edit" }, trigger)}
          onManageMembers={onManageMembers}
        />
      ))}

      {dialog?.kind === "create" ? (
        <NewCalendarDialog
          destinationOptions={destinationOptions}
          destinations={destinations}
          onCreate={onCreate}
          onNotice={onNotice}
          onOpenChange={close}
          returnFocus={returnFocusRef}
        />
      ) : null}
      {dialog?.kind === "import" ? (
        <ImportCalendarDialog
          destinationOptions={destinationOptions}
          destinations={destinations}
          onImport={onImport}
          onNotice={onNotice}
          onOpenChange={close}
          returnFocus={returnFocusRef}
        />
      ) : null}
      {dialog?.kind === "export" ? (
        <ExportCalendarDialog
          calendars={calendars}
          onExport={onExport}
          onNotice={onNotice}
          onOpenChange={close}
          returnFocus={returnFocusRef}
        />
      ) : null}
      {dialog?.kind === "edit" ? (
        <CalendarSettingsDialog
          calendar={dialog.calendar}
          key={dialog.calendar.id}
          onDisconnect={onDisconnect}
          onNotice={onNotice}
          onOpenChange={close}
          onRemove={onRemove}
          // Its row, and the settings button in it, is gone. The list's own
          // first action is the nearest place that still exists.
          onRemoved={() => {
            returnFocusRef.current = createRef.current;
          }}
          onUpdate={onUpdate}
          reminders={reminders}
          returnFocus={returnFocusRef}
        />
      ) : null}
    </>
  );
}

function CalendarGroup({
  group,
  onCreateMeeting,
  onEdit,
  onManageMembers,
}: {
  group: CalendarSourceGroup;
  onCreateMeeting?: (calendar: Calendar, target: HTMLElement) => void;
  onEdit: (calendar: Calendar, trigger: HTMLElement) => void;
  onManageMembers: (calendar: Calendar) => void;
}) {
  const headingId = `calendar-group-${group.key}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      {/* Inset to the rows, so the account mark sits over the calendar dots. */}
      <div className="flex min-h-5 items-center gap-3 px-4">
        <AccountMark flavor={group.flavor} size="compact" />
        <SectionLabel id={headingId} level={3}>
          {group.title}
        </SectionLabel>
      </div>
      <ItemGroup aria-label={`${group.title} calendars`} role="list">
        {group.calendars.map((calendar) => {
          const federatedId = connectionOfCalendar(calendar);
          const organizer =
            ["google", "caldav", "microsoft"].includes(calendar.provider ?? "") &&
            calendar.role === "owner" &&
            !federatedId;
          return (
            <Row
              detail={calendarDetail(calendar)}
              icon={<CalendarDot color={calendar.color} data-calendar-swatch="" />}
              key={calendar.id}
              label={
                <>
                  <span className="truncate" title={calendar.name}>
                    {calendar.name}
                  </span>
                  {/* Marks the account's own calendar, unless its name already says so. */}
                  {calendar.isDefault && calendar.name.trim().toLocaleLowerCase() !== "personal" ? <Badge variant="muted">Personal</Badge> : null}
                </>
              }
              role="listitem"
              trailing={
                <>
                  {organizer ? (
                    <ProviderOrganizerCreateAction
                      calendarID={calendar.id}
                      color={calendar.color}
                      onCreate={onCreateMeeting ? (target) => onCreateMeeting(calendar, target) : undefined}
                    />
                  ) : null}
                  {federatedId ? null : (
                    <Hint label="Members and sharing">
                      <Button
                        aria-label={`Share ${calendar.name}`}
                        size="icon-compact"
                        variant="ghost"
                        onClick={() => onManageMembers(calendar)}
                      >
                        <Users aria-hidden="true" strokeWidth={1.7} />
                      </Button>
                    </Hint>
                  )}
                  {/* Everyone gets this, editor or not: what it holds for a
                      viewer is when their own phone rings. */}
                  <Hint label="Calendar settings">
                    <Button
                      aria-label={`Settings for ${calendar.name}`}
                      size="icon-compact"
                      variant="ghost"
                      onClick={(event) => onEdit(calendar, event.currentTarget)}
                    >
                      <Settings2 aria-hidden="true" strokeWidth={1.7} />
                    </Button>
                  </Hint>
                </>
              }
            />
          );
        })}
      </ItemGroup>
    </section>
  );
}
