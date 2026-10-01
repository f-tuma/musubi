import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { type CSSProperties, useMemo, useRef } from "react";
import { expect, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { Row } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { buildDayAxis, civilCandidates, civilMinuteLabel, instantToCoordinate, sharedWeekAxis, singleDayAxis, utcOffsetLabel, type TimeAxis } from "../day-axis";

/* Storybook-only domain geometry. Production time grid is unchanged. */
const COLUMN_MIN_WIDTH_PX = 126;

function adjacentDate(date: string, delta: number) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + delta); return value.toISOString().slice(0, 10); }
function missingRuns(axis: TimeAxis, column: number) {
  const runs: { start: number; end: number }[] = [];
  axis.columns[column]!.forEach((value, row) => { if (value) return; const last = runs[runs.length - 1]; if (last?.end === row) last.end++; else runs.push({ start: row, end: row + 1 }); });
  return runs;
}
function AxisPreview({ axis, title }: { axis: TimeAxis; title: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  function jump(minute: number) { const instant = civilCandidates(axis.days[0]!, minute)[0]?.instant; if (instant === undefined || !scroll.current) return; scroll.current.scrollTop = Math.max(0, (instantToCoordinate(axis, 0, instant) ?? 0) - 40); }
  const gridStyle = {
    "--axis-columns": `repeat(${axis.days.length}, minmax(0, 1fr))`,
    "--axis-height": `${axis.rows.length}px`,
    "--axis-min-width": `${axis.days.length * COLUMN_MIN_WIDTH_PX}px`,
  } as CSSProperties;
  return (
    <SettingsSection title={title} variant="plain">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => jump(60)}>Show clock change</Button>
        <Button variant="secondary" onClick={() => jump(540)}>Jump to 09:00</Button>
      </div>
      <div className="max-h-96 overflow-auto border-t border-border-subtle focus-inset" ref={scroll} role="region" aria-label={`${title} timeline`} tabIndex={0}>
        <div className="min-w-(--axis-min-width)" style={gridStyle}>
          <div className="sticky top-0 z-1 grid grid-cols-(--axis-columns) bg-canvas">
            {axis.days.map((day) => (
              <div className="border-b border-border-subtle p-2 font-mono text-11" key={day.date}>
                {day.date}
                <strong className="block font-normal text-muted-foreground">{day.minutes.length / 60} real hours</strong>
              </div>
            ))}
          </div>
          <div className="relative grid h-(--axis-height) grid-cols-(--axis-columns)">
            {axis.days.map((day, column) => (
              <div className="relative border-r border-border-subtle" key={day.date}>
                {axis.columns[column]!.map((value, row) => value && value.minute % 30 === 0 ? (
                  <time key={value.key} className="absolute inset-x-0 top-(--tick-top) border-t border-border-subtle px-2 font-mono text-10 text-foreground" dateTime={new Date(value.instant).toISOString()} style={{ "--tick-top": `${row}px` } as CSSProperties}>
                    <span className="sr-only">{day.date} </span>
                    {civilMinuteLabel(value)}
                    <small className="block text-muted-foreground">{utcOffsetLabel(value.offsetMinutes)}{civilCandidates(day, value.minute).length > 1 ? ` · ${value.fold + 1 === 1 ? "first" : "second"}` : ""}</small>
                  </time>
                ) : null)}
                {missingRuns(axis, column).map((run) => (
                  <div key={run.start} className="absolute inset-x-0 top-(--tick-top) flex h-(--run-height) items-center justify-center border-y border-border-subtle px-2 text-10 text-muted-foreground" data-missing-time="" role="note" style={{ "--tick-top": `${run.start}px`, "--run-height": `${run.end - run.start}px` } as CSSProperties}>
                    No local time
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
function DayAxisProposal({ date, timezone }: { date: string; timezone: string }) {
  const axes = useMemo(() => {
    const day = buildDayAxis(date, timezone);
    return { day: singleDayAxis(day), week: sharedWeekAxis(Array.from({ length: 7 }, (_, index) => buildDayAxis(adjacentDate(date, index - 3), timezone))) };
  }, [date, timezone]);
  return (
    <div className="grid w-full min-w-0 gap-5 p-4">
      <Row label="Clock-change axis" detail={`${timezone}. Storybook only.`} />
      <AxisPreview title="Day axis" axis={axes.day} />
      <AxisPreview title="Week axis" axis={axes.week} />
    </div>
  );
}
const meta = { title: "Calendar/Clock-change axis proposal", component: DayAxisProposal, parameters: { layout: "fullscreen", chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } }, args: { date: "2026-10-25", timezone: "Europe/Prague" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("region", { name: "Day axis timeline" })).toBeVisible();
  for (const time of canvasElement.querySelectorAll("time")) { await expect(time).not.toHaveAttribute("aria-label"); await expect(time.textContent).toMatch(/^\d{4}-\d{2}-\d{2} /); }
  for (const missing of canvasElement.querySelectorAll("[data-missing-time]")) { await expect(missing.querySelector("button, input, [tabindex]")).toBeNull(); }
  await expect(canvas.getByRole("region", { name: "Week axis timeline" })).toBeVisible();
} } satisfies Meta<typeof DayAxisProposal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PragueFall: Story = {};
export const PragueSpring: Story = { args: { date: "2026-03-29" } };
export const LordHoweFall: Story = { args: { date: "2026-04-05", timezone: "Australia/Lord_Howe" } };
export const LordHoweSpring: Story = { args: { date: "2026-10-04", timezone: "Australia/Lord_Howe" } };
export const NormalDay: Story = { args: { date: "2026-07-26" } };
