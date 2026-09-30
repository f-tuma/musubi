import {
  allDayValue,
  DEFAULT_NOTIFICATION_EMAILS,
  DEFAULT_REMINDER_RULE,
  optionsFor,
  timedValue,
  withAllDay,
  withTimed,
  type ReminderRule,
} from "@musubi/types";
import { useState } from "react";
import type { ReminderControl } from "~/calendar/reminder-control";
import { Button } from "~/components/ui/button";
import { InlineError } from "~/components/ui/inline-error";
import { Row, RowOptions, RowToggle } from "~/components/ui/row";
import { Select } from "~/components/ui/select";
import { SettingsSection } from "~/components/ui/settings-section";
import { Spinner } from "~/components/ui/spinner";
import { useInspectorPreference } from "~/components/ui/inspector-preferences";
import type { SettingsDocumentState } from "./use-settings-document";

const THEME_OPTIONS = [
  { label: "System", value: "system" },
  { label: "Dark", value: "dark" },
  { label: "Light", value: "light" },
] as const;

const VIEW_OPTIONS = [
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
  { label: "Agenda", value: "schedule" },
] as const;

const INSPECTOR_OPTIONS = [
  { label: "Side panel", value: "panel" },
  { label: "Floating window", value: "floating" },
] as const;

const WEEK_START_OPTIONS = [
  { label: "Sunday", value: "sunday" },
  { label: "Monday", value: "monday" },
] as const;

const TIME_FORMAT_OPTIONS = [
  { label: "24 hour", value: "24h" },
  { label: "12 hour", value: "12h" },
] as const;

const DATE_FORMAT_OPTIONS = [
  { label: "D/M/Y", value: "dmy" },
  { label: "M/D/Y", value: "mdy" },
  { label: "Y-M-D", value: "ymd" },
] as const;

export type GeneralPanelProps = {
  document: SettingsDocumentState;
  /** Only for the push toggle here — a calendar's own rule lives on the calendar. */
  reminders?: ReminderControl;
};

/** Appearance, date and time, reminders and email: the synced preferences. */
export function GeneralPanel({ document, reminders }: GeneralPanelProps) {
  const { error, loadFailed, retry, save, saving, settings } = document;
  const [inspectorPresentation, setInspectorPresentation] = useInspectorPreference();
  const [layoutError, setLayoutError] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState("");

  async function togglePush(wanted: boolean) {
    if (!reminders) return;
    setPushBusy(true);
    setPushMessage("");
    try {
      const enabled = await reminders.push.set(wanted);
      // A refused prompt is an answer, not an error. Saying where to change it
      // beats a toggle that springs back with no explanation.
      if (wanted && !enabled) setPushMessage("Allow notifications for this site");
    } catch {
      setPushMessage("Could not be changed. Try again.");
    } finally {
      setPushBusy(false);
    }
  }

  if (loadFailed) {
    return (
      <div className="flex flex-col items-start gap-3">
        <InlineError className="w-full">{error}</InlineError>
        <Button variant="secondary" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }

  if (!settings) {
    return (
      <div aria-live="polite" className="flex items-center gap-3 text-13 text-muted-foreground" role="status">
        <Spinner />
        Loading settings…
      </div>
    );
  }

  // The bottom of the reminder chain is always a concrete rule, so a settings
  // document that predates the field still gives the control something to show.
  const defaultReminder = settings.value.defaultReminder ?? DEFAULT_REMINDER_RULE;
  const notificationEmails = settings.value.notificationEmails ?? DEFAULT_NOTIFICATION_EMAILS;
  const saveDefaultReminder = (rule: ReminderRule) => save({ defaultReminder: rule });

  return (
    <>
      <span className="sr-only" role="status">
        {saving ? "Saving settings…" : ""}
      </span>
      {error ? <InlineError>{error}</InlineError> : null}

      <SettingsSection title="Appearance" aria-busy={saving || undefined}>
        <RowOptions
          disabled={saving}
          label="Theme"
          options={THEME_OPTIONS}
          value={settings.value.theme}
          onChange={(theme) => void save({ theme })}
        />
        <RowOptions
          disabled={saving}
          label="Default view"
          stacked
          options={VIEW_OPTIONS}
          value={settings.value.defaultCalendarView}
          onChange={(defaultCalendarView) => void save({ defaultCalendarView })}
        />
        <RowOptions
          label="Open details as"
          options={INSPECTOR_OPTIONS}
          value={inspectorPresentation}
          onChange={(value) => {
            try {
              setInspectorPresentation(value);
              setLayoutError("");
            } catch {
              setLayoutError("Your browser could not save the window preference.");
            }
          }}
        />
      </SettingsSection>
      {layoutError ? <InlineError>{layoutError}</InlineError> : null}

      <SettingsSection title="Date & time">
        <RowOptions
          disabled={saving}
          label="Week starts on"
          options={WEEK_START_OPTIONS}
          value={settings.value.weekStartsOn}
          onChange={(weekStartsOn) => void save({ weekStartsOn })}
        />
        <RowOptions
          disabled={saving}
          label="Time format"
          options={TIME_FORMAT_OPTIONS}
          value={settings.value.timeFormat}
          onChange={(timeFormat) => void save({ timeFormat })}
        />
        <RowOptions
          disabled={saving}
          label="Date format"
          options={DATE_FORMAT_OPTIONS}
          value={settings.value.dateFormat}
          onChange={(dateFormat) => void save({ dateFormat })}
        />
      </SettingsSection>

      <SettingsSection
        title="Reminders"
        help="The default for events. A calendar or an event can set its own. Browser notifications arrive even with Musubi closed."
      >
        <Row
          label="Timed events"
          layout="responsive-actions"
          trailing={
            <Select
              disabled={saving}
              label="Timed events"
              options={optionsFor(defaultReminder, "timed")}
              size="compact"
              value={timedValue(defaultReminder)}
              onChange={(value) => void saveDefaultReminder(withTimed(defaultReminder, value))}
            />
          }
        />
        <Row
          label="All-day events"
          layout="responsive-actions"
          trailing={
            <Select
              disabled={saving}
              label="All-day events"
              options={optionsFor(defaultReminder, "allDay")}
              size="compact"
              value={allDayValue(defaultReminder)}
              onChange={(value) => void saveDefaultReminder(withAllDay(defaultReminder, value))}
            />
          }
        />
        {reminders?.push.available ? (
          <RowToggle
            checked={reminders.push.enabled}
            detail={pushMessage || undefined}
            disabled={saving || pushBusy}
            label="Browser notifications"
            onCheckedChange={(wanted) => void togglePush(wanted)}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Email notifications" help="An email when an event you attend moves or is cancelled.">
        <RowToggle
          checked={notificationEmails.eventChanged}
          disabled={saving}
          label="Event changes"
          onCheckedChange={(eventChanged) =>
            void save({ notificationEmails: { ...notificationEmails, eventChanged } })
          }
        />
      </SettingsSection>
    </>
  );
}
