import type { Settings } from "@musubi/types";
import { getMonthGrid } from "@musubi/calendar/layout";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { SectionLabel } from "~/components/ui/section-label";
import { getLongDateLabel, getWeekdayLabels } from "../calendar-math";
import { cn } from "~/lib/utils";
import { toDateKey } from "../date-key";

/** A month or year in the period pickers: a calendar cell, not a command. */
const pickerTile =
  "flex min-h-16 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-control p-1 text-foreground-secondary tabular-nums transition-colors duration-fast hover:enabled:bg-raised hover:enabled:text-foreground disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-raised aria-pressed:text-foreground";

const monthKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}`;

const startOfMonth = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), 1);

/**
 * Orientation, not a second calendar: it shows where the current date sits in
 * the month and jumps the main view without changing the view, filters or the
 * scroll position.
 *
 * One tab stop, arrows move the focused day — 42 tab stops in the sidebar would
 * bury everything below it.
 */
export function MiniCalendar({
  anchor,
  showToday = false,
  monthYearSelectors = false,
  label = "Jump to date",
  max,
  min,
  onDateChange,
  weekStartsOn,
}: {
  anchor: Date;
  showToday?: boolean;
  monthYearSelectors?: boolean;
  label?: string;
  max?: string;
  min?: string;
  onDateChange: (date: string) => void;
  weekStartsOn: Settings["weekStartsOn"];
}) {
  // The month on show follows the main view, but can also be paged on its own —
  // so it is state seeded from the anchor and re-seeded when the anchor's month
  // changes under it.
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  const [seededFrom, setSeededFrom] = useState(() => monthKey(anchor));
  // Undefined focus means "follow the anchor" — the common case, and what a
  // paged month falls back to.
  const [yearPickerOpen, setYearPickerOpen] = useState(false);
  const [browsedYear, setBrowsedYear] = useState(anchor.getFullYear());
  const minYear = min ? Number(min.slice(0, 4)) : 100;
  const maxYear = max ? Number(max.slice(0, 4)) : 9999;
  const yearWheelRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    let accumulated = 0;
    let lastStep = -Infinity;
    let lastEvent = -Infinity;
    let lastDirection = 0;
    let burstDistance = 0;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      const direction = Math.sign(delta);
      // Pausing or reversing restores fine control immediately.
      if (now - lastEvent > 180 || direction !== lastDirection) {
        accumulated = 0;
        burstDistance = 0;
        lastStep = -Infinity;
      }
      lastDirection = direction;
      burstDistance += Math.abs(delta);
      lastEvent = now;
      accumulated += delta;
      const interval = burstDistance >= 500 ? 24 : burstDistance >= 300 ? 40 : burstDistance >= 160 ? 60 : 120;
      if (Math.abs(accumulated) < 40 || now - lastStep < interval) return;
      setBrowsedYear(year => Math.max(minYear, Math.min(maxYear, year + direction)));
      accumulated = 0;
      lastStep = now;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [minYear, maxYear]);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [focused, setFocused] = useState<string>();

  function showMonth(next: Date) {
    setMonth(next);
    setFocused(undefined);
  }

  if (seededFrom !== monthKey(anchor)) {
    setSeededFrom(monthKey(anchor));
    showMonth(startOfMonth(anchor));
  }

  const days = useMemo(
    () => getMonthGrid(month, weekStartsOn),
    [month, weekStartsOn],
  );
  const weekdayLabels = getWeekdayLabels(weekStartsOn);
  const anchorKey = toDateKey(anchor);
  const todayKey = toDateKey(new Date());
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const unavailable = (dateKey: string) =>
    Boolean((min && dateKey < min) || (max && dateKey > max));
  const focusedIsVisible =
    focused !== undefined &&
    days.some(
      (day) =>
        toDateKey(day) === focused && !unavailable(toDateKey(day)),
    );
  const anchorIsVisible = days.some(
    (day) =>
      toDateKey(day) === anchorKey && !unavailable(toDateKey(day)),
  );
  const tabbableKey = focusedIsVisible
    ? focused
    : anchorIsVisible
      ? anchorKey
      : days.map(toDateKey).find((dateKey) => !unavailable(dateKey));

  function changeYear(year: number) {
    if (year < minYear || year > maxYear) return;
    let nextMonth = month.getMonth();
    if (min && year === Number(min.slice(0, 4))) nextMonth = Math.max(nextMonth, Number(min.slice(5, 7)) - 1);
    if (max && year === Number(max.slice(0, 4))) nextMonth = Math.min(nextMonth, Number(max.slice(5, 7)) - 1);
    showMonth(new Date(year, nextMonth, 1));
    setYearPickerOpen(false);
  }

  function focusDate(day: Date) {
    const dateKey = toDateKey(day);
    if (unavailable(dateKey)) return;
    setMonth(startOfMonth(day));
    setFocused(dateKey);
    requestAnimationFrame(() => cellRefs.current.get(dateKey)?.focus());
  }

  return (
    <section className="px-3.5 pt-2 pb-1" aria-label={label}>
      <header className={cn("flex items-center justify-between gap-1", monthYearSelectors ? "mb-2" : "mb-1.5")}>
        <Button
          aria-label="Previous month in date picker"
          disabled={
            min
              ? toDateKey(
                  new Date(month.getFullYear(), month.getMonth(), 0),
                ) < min
              : false
          }
          size="icon-compact"
          title="Previous month in date picker"
          variant="ghost"
          onClick={() =>
            showMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
          }
        >
          <ChevronLeft aria-hidden="true" strokeWidth={1.7} />
        </Button>
        <div className="flex min-w-0 items-center justify-center gap-2">
        {monthYearSelectors ? <div className="flex items-center">
          <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
            <PopoverTrigger asChild>
              <Button size="compact" variant="ghost" aria-label={`Month: ${month.toLocaleDateString("en", { month: "long" })}`}>
                {month.toLocaleDateString("en", { month: "long" })}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" aria-label="Choose month" className="w-80">
              <div className="grid grid-cols-4 gap-1 p-2">
                {Array.from({ length: 12 }, (_, index) => {
                  const name = new Date(2026, index, 1).toLocaleDateString("en", { month: "long" });
                  return <button key={index} type="button" className={pickerTile}
                    aria-label={name} aria-pressed={index === month.getMonth()}
                    disabled={Boolean((min && toDateKey(new Date(month.getFullYear(), index + 1, 0)) < min) || (max && toDateKey(new Date(month.getFullYear(), index, 1)) > max))}
                    onClick={() => { showMonth(new Date(month.getFullYear(), index, 1)); setMonthPickerOpen(false); }}>
                    <span className="text-18 tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                    <span className="text-10">{name}</span>
                  </button>;
                })}
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={yearPickerOpen} onOpenChange={(open) => {
            if (open) setBrowsedYear(month.getFullYear());
            setYearPickerOpen(open);
          }}>
            <PopoverTrigger asChild>
              <Button size="compact" variant="ghost"
                aria-label={`Year: ${month.getFullYear()}`}>
                {month.getFullYear()}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="center" aria-label="Choose year" className="w-80">
              <div className="flex items-center gap-1 p-2" ref={yearWheelRef}>
                <Button aria-label="Previous year" size="icon-compact" title="Previous year" variant="ghost"
                  disabled={browsedYear <= minYear}
                  onClick={() => setBrowsedYear(year => Math.max(minYear, year - 1))}>
                  <ChevronLeft aria-hidden="true" />
                </Button>
                {[browsedYear - 1, browsedYear, browsedYear + 1].map((year, position) => (
                  <button key={position} type="button"
                    className={cn(pickerTile, "flex-1", year === browsedYear ? "text-24 text-foreground" : "text-13")}
                    aria-label={`Choose ${year}`}
                    aria-pressed={year === month.getFullYear()}
                    disabled={year < minYear || year > maxYear}
                    onClick={() => changeYear(year)}>
                    {year}
                  </button>
                ))}
                <Button aria-label="Next year" size="icon-compact" title="Next year" variant="ghost"
                  disabled={browsedYear >= maxYear}
                  onClick={() => setBrowsedYear(year => Math.min(maxYear, year + 1))}>
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div> : <SectionLabel>
          {/* Short month: the toolbar already spells the period out in full,
              and this one has seven columns to fit. */}
          {month.toLocaleDateString("en", { month: "short", year: "numeric" })}
        </SectionLabel>}
      {showToday ? <Button size="compact" variant="ghost" disabled={unavailable(todayKey)} onClick={() => {
        showMonth(startOfMonth(new Date()));
        onDateChange(todayKey);
      }}>Today</Button> : null}
        </div>
        <Button
          aria-label="Next month in date picker"
          disabled={
            max
              ? toDateKey(
                  new Date(month.getFullYear(), month.getMonth() + 1, 1),
                ) > max
              : false
          }
          size="icon-compact"
          title="Next month in date picker"
          variant="ghost"
          onClick={() =>
            showMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }
        >
          <ChevronRight aria-hidden="true" strokeWidth={1.7} />
        </Button>
      </header>

      <div className="flex flex-col gap-px" role="grid">
        <div className="grid grid-cols-7 gap-px" role="row">
          {weekdayLabels.map((weekday) => (
            <abbr key={weekday} className="pb-0.5 text-center text-10 text-muted-foreground no-underline" role="columnheader" title={weekday}>
              {weekday.slice(0, 1)}
            </abbr>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div
            className="grid grid-cols-7 gap-px"
            key={toDateKey(days[week * 7]!)}
            role="row"
          >
            {days.slice(week * 7, week * 7 + 7).map((day, offset) => {
              const index = week * 7 + offset;
              const dateKey = toDateKey(day);
              const disabled = unavailable(dateKey);

              return (
                <button
                  aria-current={dateKey === todayKey ? "date" : undefined}
                  aria-label={getLongDateLabel(day)}
                  aria-selected={dateKey === anchorKey}
                  className="grid aspect-square cursor-pointer place-items-center rounded-full text-11 text-foreground transition-colors duration-fast hover:enabled:bg-raised disabled:cursor-not-allowed disabled:opacity-40 data-[outside]:text-muted-foreground data-[today]:font-medium data-[today]:text-shu data-[selected]:bg-primary data-[selected]:font-medium data-[selected]:text-primary-foreground data-[selected]:hover:enabled:bg-primary/90"
                  data-outside={
                    day.getMonth() === month.getMonth() ? undefined : ""
                  }
                  data-selected={dateKey === anchorKey ? "" : undefined}
                  data-today={dateKey === todayKey ? "" : undefined}
                  disabled={disabled}
                  key={dateKey}
                  ref={(node) => {
                    if (node) {
                      cellRefs.current.set(dateKey, node);
                    } else {
                      cellRefs.current.delete(dateKey);
                    }
                  }}
                  role="gridcell"
                  tabIndex={dateKey === tabbableKey ? 0 : -1}
                  type="button"
                  onClick={() => onDateChange(dateKey)}
                  onFocus={() => setFocused(dateKey)}
                  onKeyDown={(event) => {
                    const target = new Date(day);
                    if (event.key === "ArrowDown") {
                      target.setDate(target.getDate() + 7);
                    } else if (event.key === "ArrowLeft") {
                      target.setDate(target.getDate() - 1);
                    } else if (event.key === "ArrowRight") {
                      target.setDate(target.getDate() + 1);
                    } else if (event.key === "ArrowUp") {
                      target.setDate(target.getDate() - 7);
                    } else if (event.key === "Home") {
                      target.setDate(target.getDate() - (index % 7));
                    } else if (event.key === "End") {
                      target.setDate(target.getDate() + (6 - (index % 7)));
                    } else if (
                      event.key === "PageUp" ||
                      event.key === "PageDown"
                    ) {
                      const direction = event.key === "PageUp" ? -1 : 1;
                      const targetMonth = day.getMonth() + direction;
                      const lastDay = new Date(
                        day.getFullYear(),
                        targetMonth + 1,
                        0,
                      ).getDate();
                      target.setFullYear(
                        day.getFullYear(),
                        targetMonth,
                        Math.min(day.getDate(), lastDay),
                      );
                    } else {
                      return;
                    }
                    event.preventDefault();
                    focusDate(target);
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>

    </section>
  );
}
