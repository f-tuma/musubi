import {
  CalendarPlus,
  Clock,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Users,
  Menu as MenuIcon,
  Plus,
  Search,
} from "lucide-react";
import { useState, useRef, type RefObject, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { RowToggle } from "~/components/ui/row";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import { SettingsSection } from "~/components/ui/settings-section";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { useNarrowViewport } from "~/design/use-narrow-viewport";
import { offeredViews, type CalendarViewId } from "../view-registry";
import { CalendarCoverageInfo } from "./CalendarCoverageInfo";

type ToolbarProps = {
  notifications?: ReactNode;
  taskLayoutControl?: ReactNode;
  availability?: { shown: boolean; onToggle: () => void; onOpenList: (target: HTMLElement | null) => void };
  activeView: CalendarViewId;
  canCreateEvents: boolean;
  canCreateMeetings: boolean;
  canCreateTasks: boolean;
  coverageNotice?: string | null;
  navigationTriggerRef?: RefObject<HTMLButtonElement | null>;
  onCreateEvent: (target: HTMLElement) => void;
  onCreateMeeting: (target: HTMLElement) => void;
  onCreateTask: () => void;
  onOpenSearch: () => void;
  onOpenSidebar: () => void;
  onPeriodChange: (offset: number) => void;
  onToday: () => void;
  onViewChange: (view: CalendarViewId) => void;
  pageTitle: string;
  periodLabel: string;
  periodNavigation?: boolean;
  periodName: string;
  searchTriggerRef?: RefObject<HTMLButtonElement | null>;
};

export function Toolbar({
  notifications,
  taskLayoutControl,
  availability,
  activeView,
  canCreateEvents,
  canCreateMeetings,
  canCreateTasks,
  coverageNotice,
  navigationTriggerRef,
  onCreateEvent,
  onCreateMeeting,
  onCreateTask,
  onOpenSearch,
  onOpenSidebar,
  onPeriodChange,
  onToday,
  onViewChange,
  pageTitle,
  periodLabel,
  periodNavigation = true,
  periodName,
  searchTriggerRef,
}: ToolbarProps) {
  // A flick moves the period on touch, so the arrows are desktop furniture.
  const narrow = useNarrowViewport();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const createAfterClose = useRef<"event" | "meeting" | null>(null);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const availabilityTriggerRef = useRef<HTMLButtonElement>(null);
  const availabilityListAfterClose = useRef(false);

  const viewOptions = offeredViews().map((view) => ({
    label: view.label,
    value: view.id as CalendarViewId,
  }));

  return (
    /* The toolbar is a size container: beside an inspector the calendar can be
       narrow on a wide window, and the controls answer to the room they have. */
    <header className="@container relative z-20 min-w-0 border-b border-border-subtle bg-canvas">
      {/* The page name lives in the sidebar, its settings in the page dialog and
          the theme in Settings, so the toolbar carries no page strip at all. */}
      <h1 className="sr-only">{pageTitle}</h1>

      <div className="flex min-h-16 items-center gap-3 px-3 py-3 md:px-6 md:py-4 @max-default:flex-wrap @max-default:gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 @max-default:basis-full @max-default:flex-wrap">
          <Button
            aria-label="Open navigation"
            className="md:hidden"
            ref={navigationTriggerRef}
            size="icon-compact"
            title="Open navigation"
            variant="ghost"
            onClick={onOpenSidebar}
          >
            <MenuIcon aria-hidden="true" strokeWidth={1.6} />
          </Button>
          {/* From 1024 px the mini calendar owns Today and the month arrows. */}
          {activeView !== "tasks" ? (
            <Button className="md:hidden" size="compact" variant="secondary" onClick={onToday}>
              Today
            </Button>
          ) : null}
          {periodNavigation && !narrow ? (
            <div className="flex flex-none gap-0.5 md:hidden">
              <Button
                aria-label={`Previous ${periodName}`}
                size="icon-compact"
                title={`Previous ${periodName}`}
                variant="ghost"
                onClick={() => onPeriodChange(-1)}
              >
                <ChevronLeft aria-hidden="true" strokeWidth={1.6} />
              </Button>
              <Button
                aria-label={`Next ${periodName}`}
                size="icon-compact"
                title={`Next ${periodName}`}
                variant="ghost"
                onClick={() => onPeriodChange(1)}
              >
                <ChevronRight aria-hidden="true" strokeWidth={1.6} />
              </Button>
            </div>
          ) : null}
          <p
            className="min-w-0 truncate font-serif text-22 leading-snug text-foreground md:text-24 md:motion-safe:transition-all md:motion-safe:duration-panel lg:text-28 md:data-[view=multi-week]:text-19 lg:data-[view=multi-week]:text-22 @max-wide:text-22 @max-default:flex-1 @max-default:overflow-visible @max-default:whitespace-normal @max-default:text-balance"
            data-view={activeView}
          >
            {periodLabel}
          </p>
          {taskLayoutControl ? <div className="ml-4 flex-none">{taskLayoutControl}</div> : null}
        </div>

        {/* Exactly one view choice is on screen: pills where they fit, a
            select where the inspector leaves too little room for them. */}
        <Select
          className="hidden max-md:@max-wide:inline-flex md:@max-compact:inline-flex"
          label="Calendar view"
          options={viewOptions}
          size="compact"
          value={activeView}
          onChange={(value) => onViewChange(value as CalendarViewId)}
        />

        <div className="ml-auto flex min-w-0 flex-none items-center justify-end gap-2 md:@max-default:ml-0 md:@max-default:flex-wrap md:@max-default:justify-start">
          {notifications}
          {coverageNotice ? <CalendarCoverageInfo message={coverageNotice} /> : null}
          {availability ? (
            <Popover open={availabilityOpen} onOpenChange={setAvailabilityOpen}>
              <PopoverTrigger asChild>
                <Button
                  aria-label="Availability"
                  ref={availabilityTriggerRef}
                  size="icon-compact"
                  title="Availability"
                  variant="ghost"
                >
                  <Clock aria-hidden="true" strokeWidth={1.6} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                aria-label="Grid availability"
                align="end"
                onCloseAutoFocus={(event) => {
                  if (!availabilityListAfterClose.current) return;
                  event.preventDefault();
                  availabilityListAfterClose.current = false;
                  availabilityTriggerRef.current?.focus();
                  availability.onOpenList(availabilityTriggerRef.current);
                }}
              >
                <div className="grid gap-3 p-4">
                  <SettingsSection title="Availability">
                    <RowToggle
                      checked={availability.shown}
                      label="Show selected availability"
                      size="compact"
                      onCheckedChange={availability.onToggle}
                    />
                  </SettingsSection>
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={() => {
                      availabilityListAfterClose.current = true;
                      setAvailabilityOpen(false);
                    }}
                  >
                    Sources and intervals
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          <Button
            aria-label="Search events and actions"
            ref={searchTriggerRef}
            size="icon-compact"
            title="Search events and actions"
            variant="ghost"
            onClick={onOpenSearch}
          >
            <Search aria-hidden="true" strokeWidth={1.6} />
          </Button>
          <Segmented<CalendarViewId>
            className="hidden flex-none md:inline-flex @min-wide:inline-flex md:@max-default:max-w-full md:@max-compact:hidden"
            label="Calendar view"
            options={viewOptions}
            value={activeView}
            onChange={onViewChange}
          />
          {canCreateEvents || canCreateMeetings || canCreateTasks ? (
            /* On a phone the one create action floats in thumb reach, clear of
               the home indicator; the toast rises above it. */
            <span className="flex flex-none max-sm:fixed max-sm:right-4 max-sm:bottom-4 max-sm:z-40 max-sm:mb-safe-bottom">
              <Menu>
                <MenuTrigger asChild>
                  <Button
                    aria-label="Create event, meeting or task"
                    ref={createTriggerRef}
                    size={narrow ? "fab" : "icon-compact"}
                    title="Create event, meeting or task"
                  >
                    <Plus aria-hidden="true" strokeWidth={1.7} />
                  </Button>
                </MenuTrigger>
                <MenuContent
                  align="end"
                  label="Create"
                  mobileSurface="anchored"
                  onCloseAutoFocus={(event) => {
                    const action = createAfterClose.current;
                    if (!action) return;
                    createAfterClose.current = null;
                    const target = createTriggerRef.current;
                    if (!target) return;
                    // Finish the outgoing menu's focus lifecycle before mounting
                    // the form, so it cannot dismiss the newly opened popover.
                    event.preventDefault();
                    if (action === "meeting") onCreateMeeting(target);
                    else onCreateEvent(target);
                  }}
                >
                  <MenuItem
                    disabled={!canCreateEvents}
                    icon={<CalendarPlus size={16} strokeWidth={1.7} />}
                    onSelect={() => {
                      createAfterClose.current = "event";
                    }}
                  >
                    Event
                  </MenuItem>
                  <MenuItem
                    disabled={!canCreateMeetings}
                    icon={<Users size={16} strokeWidth={1.7} />}
                    onSelect={() => {
                      createAfterClose.current = "meeting";
                    }}
                  >
                    Meeting
                  </MenuItem>
                  <MenuItem
                    disabled={!canCreateTasks}
                    icon={<ListTodo size={16} strokeWidth={1.7} />}
                    onSelect={onCreateTask}
                  >
                    Task
                  </MenuItem>
                </MenuContent>
              </Menu>
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
