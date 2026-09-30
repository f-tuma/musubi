import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState, type CSSProperties } from "react";
import { MapPin, Repeat2, Clock3, CircleCheck } from "lucide-react";
import { expect, screen, userEvent, waitFor } from "storybook/test";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { AccountMark } from "./ProviderIcon";

// Visual proposal only: no account data or writes, and no production route changes.
const days = [
  { date: "2026-09-15", day: "15", weekday: "Tuesday", label: "Today", items: [
    { title: "Ověřit nápovědu a nastavení", start: "All day", end: "", calendar: "UI kontrola", color: "#ca533a", provider: null, kind: "done", location: "" },
    { title: "Týdenní plánování", start: "09:00", end: "10:00", calendar: "Práce", color: "#849cbe", provider: "google", kind: "repeat", location: "Testovací prostředí" },
    { title: "UI kontrola — kompletně vyplněný úkol", start: "10:00", end: "", calendar: "UI kontrola", color: "#ca533a", provider: null, kind: "task", location: "" },
  ] },
  { date: "2026-09-16", day: "16", weekday: "Wednesday", label: "Tomorrow", items: [
    { title: "Volný den", start: "All day", end: "", calendar: "Osobní", color: "#a5b49e", provider: null, kind: "event", location: "" },
    { title: "Společná kontrola nové verze Musubi", start: "12:00", end: "12:30", calendar: "Domácí", color: "#68b5cf", provider: "apple", kind: "event", location: "Online" },
    { title: "Dokončit detaily kalendáře a připravit podklady k vydání", start: "14:30", end: "", calendar: "UI kontrola", color: "#ca533a", provider: null, kind: "task", location: "" },
    { title: "Plánování dalšího týdne", start: "15:00", end: "15:30", calendar: "Práce", color: "#849cbe", provider: "microsoft", kind: "event", location: "Kancelář" },
  ] },
  { date: "2026-09-17", day: "17", weekday: "Thursday", label: "", items: [
    { title: "Dokončení detailů kalendáře", start: "14:00", end: "16:00", calendar: "UI kontrola", color: "#ca533a", provider: null, kind: "event", location: "Testovací prostředí" },
  ] },
];
type Item = typeof days[number]["items"][number];

function KindMark({ kind }: { kind: string }) {
  if (kind === "repeat") return <Repeat2 size={13} />;
  if (kind === "done") return <CircleCheck size={13} />;
  return <Clock3 size={13} />;
}

/** A bounded reading width, unlike the full-width calendar canvas. */
function AgendaProposal() {
  const [selected, setSelected] = useState<Item>();
  return (
    <main className="mx-auto w-full max-w-wide px-8 py-7 text-foreground max-sm:p-5">
      <header className="flex items-baseline gap-5 pb-7 max-sm:flex-wrap max-sm:gap-2">
        <h1 className="m-0 font-serif text-28 font-normal">Agenda</h1>
        <span className="text-14 text-foreground-secondary">September 2026</span>
      </header>
      <ol className="m-0 list-none p-0">
        {days.map((day) => (
          <li key={day.date} className="flex flex-col gap-3 border-t border-border-subtle py-5 sm:flex-row sm:gap-8">
            <time dateTime={day.date} className="flex items-baseline gap-3 pt-3 sm:w-24 sm:flex-none sm:flex-col sm:items-start sm:gap-1">
              <strong className={day.label === "Today" ? "font-serif text-28 leading-tight font-normal text-shu" : "font-serif text-28 leading-tight font-normal"}>
                {day.day}
              </strong>
              <span className="text-13">{day.weekday}</span>
              <small className="text-12 text-foreground-secondary">{day.label || "September"}</small>
            </time>
            <ul className="m-0 min-w-0 flex-1 list-none p-0">
              {day.items.map((item) => (
                <li key={item.title} className="not-first:border-t not-first:border-border-subtle">
                  <button
                    type="button"
                    className="flex w-full min-w-0 cursor-pointer items-start gap-4 rounded-control bg-transparent px-3 py-4 text-left text-foreground transition-colors duration-fast hover:bg-raised focus-inset max-sm:gap-2"
                    style={{ "--pigment": item.color } as CSSProperties}
                    onClick={() => setSelected(item)}
                  >
                    <span className="flex w-20 flex-none flex-col gap-1 text-13 tabular-nums max-sm:w-14">
                      <strong className="font-medium">{item.start}</strong>
                      {item.end ? <span className="text-12 text-foreground-secondary">{item.end}</span> : null}
                    </span>
                    <span className="min-w-0 flex-1 border-l-3 border-pigment pl-4 max-sm:pl-3">
                      <span className="block text-15 leading-normal font-medium wrap-anywhere">
                        {item.kind === "done" ? <s className="text-foreground-secondary">{item.title}</s> : item.title}
                      </span>
                      <span className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-12 text-foreground-secondary">
                        <span className="inline-flex items-center gap-1">
                          <AccountMark flavor={item.provider} color={item.color} size="compact" />
                          {item.calendar}
                        </span>
                        {item.location ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1"><MapPin className="flex-none" size={13} />{item.location}</span>
                          </>
                        ) : null}
                        {item.kind !== "event" ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1">
                              <KindMark kind={item.kind} />
                              {item.kind === "repeat" ? "Weekly" : item.kind === "done" ? "Completed" : "Task"}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(undefined); }}>
        <DialogContent size="compact" closeLabel="Close preview detail" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{selected?.title ?? "Detail"}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-14">{selected?.calendar} · {selected?.start}{selected?.end ? ` – ${selected.end}` : ""}</p>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </main>
  );
}
const meta = { title: "Calendar/Agenda proposal", component: AgendaProposal, parameters: { layout: "fullscreen" } } satisfies Meta<typeof AgendaProposal>;
export default meta;
export const Overview: StoryObj<typeof meta> = {};
export const Interaction: StoryObj<typeof meta> = { play: async () => {
  await userEvent.click(screen.getByRole("button", { name: /09:00.*Týdenní plánování/ }));
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Týdenní plánování" })).toBeVisible());
  await userEvent.click(screen.getByRole("button", { name: "Close preview detail" }));
} };
export const Narrow: StoryObj<typeof meta> = { globals: { viewport: { value: "mobile1", isRotated: false } } };
