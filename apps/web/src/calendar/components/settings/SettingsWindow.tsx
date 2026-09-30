import type { Calendar } from "@musubi/types";
import { CalendarDays, ChevronLeft, Info, Link2, Megaphone, SlidersHorizontal, UserRound } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ReminderControl } from "~/calendar/reminder-control";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { ItemGroup } from "~/components/ui/item";
import { RowAction } from "~/components/ui/row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AdminSettings } from "../AdminSettings";
import { AboutPanel } from "./AboutPanel";
import { AccountPanel } from "./AccountPanel";
import { CalendarsPanel, type CalendarsPanelProps } from "./CalendarsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { GeneralPanel } from "./GeneralPanel";
import {
  useSettingsDocument,
  type SettingsDocumentSource,
  type SettingsDocumentState,
} from "./use-settings-document";

export type SettingsSectionId = "general" | "calendars" | "connections" | "account" | "admin" | "about";

type SectionMeta = { icon: ReactNode; id: SettingsSectionId; label: string };

const SECTIONS: ReadonlyArray<SectionMeta> = [
  { icon: <SlidersHorizontal />, id: "general", label: "General" },
  { icon: <CalendarDays />, id: "calendars", label: "Calendars" },
  { icon: <Link2 />, id: "connections", label: "Connections" },
  { icon: <UserRound />, id: "account", label: "Account" },
  { icon: <Megaphone />, id: "admin", label: "Announcements" },
  { icon: <Info />, id: "about", label: "About" },
];

export type SettingsWindowProps = {
  open: boolean;
  /** The section on show. Every entry point opens the window at its own. */
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close, for a window opened by a gesture rather than a trigger. */
  returnFocus?: HTMLElement | null;
  calendars: Calendar[];
  isAdmin?: boolean;
  onNotice: (message: string) => void;
  reminders?: ReminderControl;
  userId: string;
  // General
  onAdoptSettings: SettingsDocumentSource["onAdopt"];
  onLoadSettings: SettingsDocumentSource["onLoad"];
  onPatchSettings: SettingsDocumentSource["onPatch"];
  // Calendars
  onCreateCalendar: CalendarsPanelProps["onCreate"];
  onCreateMeeting?: CalendarsPanelProps["onCreateMeeting"];
  onDisconnectCalendar: CalendarsPanelProps["onDisconnect"];
  onExportCalendar: CalendarsPanelProps["onExport"];
  onImportCalendar: CalendarsPanelProps["onImport"];
  onManageMembers: CalendarsPanelProps["onManageMembers"];
  onRemoveCalendar: CalendarsPanelProps["onRemove"];
  onUpdateCalendar: CalendarsPanelProps["onUpdate"];
  // Connections
  /** A provider link that finished while the browser was away. */
  providerLink?: { error?: string; importing?: boolean };
};

/**
 * The one settings window: every preference, calendar, connection and the
 * account, behind one navigation. It holds one size (`wide`, `tall`), so moving
 * between sections changes only what is inside. Below 600 px it is a bottom
 * sheet that works as list → detail.
 */
export function SettingsWindow({ onOpenChange, open, returnFocus, ...props }: SettingsWindowProps) {
  // Held here, outside the content that mounts per opening, so a development
  // double mount does not read the document twice.
  const document = useSettingsDocument(open, {
    onAdopt: props.onAdoptSettings,
    onLoad: props.onLoadSettings,
    onNotice: props.onNotice,
    onPatch: props.onPatchSettings,
  });

  function handleOpenChange(next: boolean) {
    if (!next) document.reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="sm:flex-row"
        closeLabel="Close settings"
        returnFocus={returnFocus}
        size="wide"
        tall
      >
        <SettingsWindowContent {...props} document={document} onClose={() => handleOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SettingsWindowContent({
  calendars,
  document,
  isAdmin = false,
  onClose,
  onCreateCalendar,
  onCreateMeeting,
  onDisconnectCalendar,
  onExportCalendar,
  onImportCalendar,
  onManageMembers,
  onNotice,
  onRemoveCalendar,
  onSectionChange,
  onUpdateCalendar,
  providerLink,
  reminders,
  section,
  userId,
}: Omit<SettingsWindowProps, "onOpenChange" | "open" | "returnFocus"> & {
  document: SettingsDocumentState;
  onClose: () => void;
}) {
  // Mounted only while the window is open, so each opening starts on the
  // requested section rather than on the list it was left at.
  const [view, setView] = useState<"list" | "detail">("detail");
  const sections = SECTIONS.filter((item) => item.id !== "admin" || isAdmin);
  const active = sections.some((item) => item.id === section) ? section : "general";

  function panel(id: SettingsSectionId) {
    switch (id) {
      case "general":
        return <GeneralPanel document={document} reminders={reminders} />;
      case "calendars":
        return (
          <CalendarsPanel
            calendars={calendars}
            onCreate={onCreateCalendar}
            onCreateMeeting={onCreateMeeting}
            onDisconnect={onDisconnectCalendar}
            onExport={onExportCalendar}
            onImport={onImportCalendar}
            onManageMembers={onManageMembers}
            onNotice={onNotice}
            onRemove={onRemoveCalendar}
            onUpdate={onUpdateCalendar}
            reminders={reminders}
          />
        );
      case "connections":
        return (
          <ConnectionsPanel
            calendars={calendars}
            importFailed={providerLink?.error}
            importing={providerLink?.importing}
            onNotice={onNotice}
            userId={userId}
          />
        );
      case "account":
        return <AccountPanel onClose={onClose} onNotice={onNotice} />;
      case "admin":
        return <AdminSettings />;
      case "about":
        return <AboutPanel remindersLoaded={Boolean(reminders)} />;
    }
  }

  return (
    <TooltipProvider>
      <Tabs
        className="contents"
        orientation="vertical"
        value={active}
        onValueChange={(value) => onSectionChange(value as SettingsSectionId)}
      >
        <div
          className={cn(
            "flex min-h-0 flex-col max-sm:flex-1 sm:w-48 sm:flex-none sm:border-r sm:border-border-subtle sm:bg-panel",
            view === "detail" && "max-sm:hidden",
          )}
        >
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <div className="px-3 pb-4 max-sm:hidden">
            <TabsList aria-label="Settings sections">
              {sections.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.icon}
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <DialogBody className="sm:hidden">
            <ItemGroup>
              {sections.map((item) => (
                <RowAction
                  icon={item.icon}
                  key={item.id}
                  label={item.label}
                  onClick={() => {
                    onSectionChange(item.id);
                    setView("detail");
                  }}
                />
              ))}
            </ItemGroup>
          </DialogBody>
        </div>

        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view === "list" && "max-sm:hidden")}>
          {sections.map((item) => (
            <TabsContent className="flex flex-col" key={item.id} value={item.id}>
              <DialogHeader>
                <Button className="-ml-3 self-start sm:hidden" size="compact" variant="ghost" onClick={() => setView("list")}>
                  <ChevronLeft aria-hidden="true" />
                  Settings
                </Button>
                <h2 className="font-serif text-19 leading-tight font-normal text-foreground">{item.label}</h2>
              </DialogHeader>
              <DialogBody>
                <div className="flex w-full max-w-form flex-col gap-8">{panel(item.id)}</div>
              </DialogBody>
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </TooltipProvider>
  );
}
