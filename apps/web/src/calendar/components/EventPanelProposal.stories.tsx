import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { CalendarDays, Clock3, MapPin, UsersRound, FileText, Cloud } from "lucide-react";
import { Avatar, AvatarStackPreview } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Disclosure } from "~/components/ui/disclosure";
import { Field, FieldGroup } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Row } from "~/components/ui/row";
import { Select } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { ProviderIcon } from "./ProviderIcon";
import { DetailList, DetailRow } from "./EventPanel";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";

function shiftDate(date: string, days: number) {
  if (!date) return "";
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const fixtures = [
  { title: "Design review", date: "2026-09-11", start: "10:00", end: "11:00", location: "Studio · meeting room", notes: "Review the event panel together. Focus on the everyday flow: finding the time, reading the notes and making a small change.\n\nBring examples of long invitations and shared calendars. Keep advanced provider information available without making everyone read it first." },
  { title: "Weekly planning", date: "2026-09-09", start: "14:00", end: "14:30", location: "Office", notes: "Agree on the next milestones and leave time for questions." },
];
const subscribe = (callback: () => void) => { const query = matchMedia("(max-width: 1023px)"); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); };

/** Interactive local-only design proposal, deliberately not wired to providers. */
function EventPanelProposal({ initialEdit = false, longNotes = false }: { initialEdit?: boolean; longNotes?: boolean }) {
  const narrow = useSyncExternalStore(subscribe, () => matchMedia("(max-width: 1023px)").matches, () => false);
  const [events, setEvents] = useState(() => fixtures.map((event, index) => ({ ...event, allDay: false, endDate: shiftDate(event.date, 1), notes: index === 0 && longNotes ? Array.from({ length: 8 }, () => event.notes).join("\n\n") : event.notes })));
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState(initialEdit);
  const [draft, setDraft] = useState(events[0]!);
  const [pending, setPending] = useState<{ next: number | null; target?: HTMLButtonElement } | null>(null);
  const [saved, setSaved] = useState(false);
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const confirmationReturn = useRef<HTMLElement | null>(null);
  useEffect(() => { if (selected !== null) (editing ? titleInput.current : editButton.current)?.focus(); }, [editing, selected]);
  const event = selected === null ? events[0]! : events[selected]!;
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(event);
  function change(next: number | null, target?: HTMLButtonElement) {
    if (dirty) { confirmationReturn.current = titleInput.current; setPending({ next, target }); return; }
    if (target) returnTarget.current = target;
    setSelected(next); setEditing(false); setSaved(false);
    if (next !== null) setDraft(events[next]!);
  }
  function open(index: number, target: HTMLButtonElement) {
    if (!dirty) returnTarget.current = target;
    if (selected === null) { setSelected(index); setDraft(events[index]!); setEditing(initialEdit); }
    else change(index, target);
  }
  const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${event.date}T12:00:00Z`));
  return <>
    <main className="fixed inset-0 h-dvh overflow-auto bg-canvas text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle p-6">
        <div><h1 className="font-serif text-22 font-normal">September 7–11</h1><p className="mt-1 text-12 text-foreground-secondary">Panel proposal · changes stay in this preview</p></div>
        <span className="text-13">Week</span>
      </header>
      <div className="grid sm:grid-cols-5" aria-label="Illustrative calendar week">
        {["Mon 7", "Tue 8", "Wed 9", "Thu 10", "Fri 11"].map((day, dayIndex) => <section className="min-h-96 border-r border-border-subtle" key={day}>
          <h2 className="border-b border-border-subtle p-4 text-13 font-medium">{day}</h2>
          <div className="grid content-start gap-3 p-2 pt-24">{events.map((item, index) => item.date === `2026-09-${String(7 + dayIndex).padStart(2, "0")}` ? <Button className="w-full" key={index} variant={selected === index ? "primary" : "secondary"} aria-label={`Open ${item.title}`} aria-pressed={selected === index} onClick={e => open(index, e.currentTarget)}>{item.allDay ? "All day" : item.start} · {item.title}</Button> : null)}</div>
        </section>)}
      </div>
    </main>
    <Dialog modal={narrow} open={selected !== null} onOpenChange={value => { if (!value) change(null); }}>
      <DialogContent side="right" modal={narrow} dismissOnOutsideInteraction={false} returnFocus={returnTarget} closeLabel="Close event panel" {...(editing ? { "aria-describedby": undefined } : {})}>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit event" : event.title}</DialogTitle>
          {editing ? null : <DialogDescription>Team calendar</DialogDescription>}
        </DialogHeader>
        <DialogBody>
          {editing ? <form id="panel-proposal-form" onSubmit={e => { e.preventDefault(); if (!draft.title.trim() || selected === null) return; setEvents(items => items.map((item, index) => index === selected ? { ...draft, title: draft.title.trim() } : item)); setEditing(false); setSaved(true); }}>
            <FieldGroup>
              <Field label="Title"><Input ref={titleInput} required pattern={".*\\S.*"} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></Field>
              <Field label="Date"><Input required type="date" value={draft.date} onChange={e => { const date = e.target.value; setDraft({ ...draft, date, endDate: date && draft.endDate <= date ? shiftDate(date, 1) : draft.endDate }); }} /></Field>
              <div className="flex items-center justify-between gap-3"><span className="text-13 font-medium">All day</span><Switch label="All day" checked={draft.allDay} onCheckedChange={allDay => setDraft({ ...draft, allDay })} /></div>
              {draft.allDay && <Field label="End date" help="This day is not included."><Input required type="date" min={shiftDate(draft.date, 1)} value={draft.endDate} onChange={e => setDraft({ ...draft, endDate: e.target.value })} /></Field>}
              {!draft.allDay && <div className="grid grid-cols-2 gap-3"><Field label="Start"><Input required type="time" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></Field><Field label="End"><Input required type="time" min={draft.start} value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></Field></div>}
              <p className="text-12 text-foreground-secondary">{draft.allDay ? "Calendar date · single event" : "Europe/Prague · single event"}</p>
              <Field label="Calendar"><Select label="Calendar" value="team" onChange={() => {}} options={[{ value: "team", label: "Team calendar", icon: <ProviderIcon flavor="google" /> }]} /></Field>
              <Field label="Location"><Input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} /></Field>
              <Field label="Notes"><Textarea rows={8} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></Field>
            </FieldGroup>
          </form> : <div className="grid content-start gap-6">
            {saved && <p role="status" className="text-12 text-foreground-secondary">Saved in this preview</p>}
            <DetailList>
              <DetailRow icon={<CalendarDays strokeWidth={1.5} />} label="Date">{dateLabel}</DetailRow>
              <DetailRow icon={<Clock3 strokeWidth={1.5} />} label="Time">{event.allDay ? `All day · through ${shiftDate(event.endDate, -1)}` : `${event.start}–${event.end} · Europe/Prague`}</DetailRow>
              <DetailRow icon={<MapPin strokeWidth={1.5} />} label="Location">{event.location || "Location not set"}</DetailRow>
            </DetailList>
            <Disclosure density="compact" label="Participants" icon={<UsersRound strokeWidth={1.5} />} value={<AvatarStackPreview limit={2} people={["Alex", "You", "Sam"].map(name => ({ id: name, name }))} />}>
              <Row size="compact" icon={<Avatar name="Alex" size="compact" />} label="Alex" detail="Organizer" />
              <Row size="compact" icon={<Avatar name="You" size="compact" />} label="You" detail="Accepted" />
              <Row size="compact" icon={<Avatar name="Sam" size="compact" />} label="Sam" detail="Awaiting response" />
            </Disclosure>
            <section className="flex gap-2" aria-label="Notes">
              <FileText aria-hidden="true" className="mt-0.5 w-5 flex-none text-foreground-secondary" size={18} strokeWidth={1.5} />
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="line-clamp-3 text-13 leading-normal whitespace-pre-wrap text-foreground-secondary">{event.notes.split("\n\n")[0]}</p>
                {event.notes && <Disclosure density="compact" label="Read full notes" icon={<FileText strokeWidth={1.5} />}><p className="text-13 leading-normal whitespace-pre-wrap text-foreground-secondary">{event.notes}</p></Disclosure>}
              </div>
            </section>
            <Disclosure density="compact" label="Google Calendar" icon={<Cloud strokeWidth={1.5} />}><div className="grid gap-1 pl-7 text-13 text-foreground-secondary"><p>Availability: Busy</p><p>Privacy: Calendar default</p><p>Provider reminder: 10 minutes before</p><p>Musubi reminder: Off</p></div></Disclosure>
          </div>}
        </DialogBody>
        <DialogFooter>
          {editing ? <><Button variant="secondary" onClick={() => { if (dirty) { confirmationReturn.current = titleInput.current; setPending({ next: selected }); } else setEditing(false); }}>Cancel</Button><Button type="submit" form="panel-proposal-form">Save changes</Button></> : <Button ref={editButton} onClick={() => { setDraft({ ...event }); setEditing(true); setSaved(false); }}>Edit event</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <ConfirmationDialog returnFocus={confirmationReturn} elevated open={pending !== null} onOpenChange={value => { if (!value) setPending(null); }} title="Discard unsaved changes?" description="The original event stays unchanged." closeLabel="Close discard confirmation" cancelLabel="Keep editing" confirmLabel="Discard changes" onConfirm={() => { const next = pending?.next ?? null; if (pending?.target) returnTarget.current = pending.target; confirmationReturn.current = next === null ? returnTarget.current : editButton.current; setPending(null); setEditing(false); setSelected(next); if (next !== null) setDraft(events[next]!); }} />
  </>;
}
const meta = { title: "Calendar/Event panel proposal", component: EventPanelProposal, parameters: { layout: "fullscreen", chromatic: { modes: DESKTOP_MODES } }, args: { initialEdit: false, longNotes: false }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Open Design review" })); await expect(within(document.body).getByRole("dialog", { name: "Design review" })).toBeVisible(); } } satisfies Meta<typeof EventPanelProposal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Detail: Story = {};
export const LongInvitation: Story = { args: { longNotes: true } };
export const Edit: Story = { args: { initialEdit: true }, play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole("button", { name: "Open Design review" })); await expect(within(document.body).getByRole("dialog", { name: "Edit event" })).toBeVisible(); } };
export const Narrow: Story = { parameters: { chromatic: { modes: MOBILE_MODES } } };

export const DraftProtection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(canvas.getByRole("button", { name: "Open Design review" }));
    await userEvent.click(page.getByRole("button", { name: "Edit event" }));
    const title = page.getByRole("textbox", { name: "Title" });
    await expect(title).toHaveFocus();
    await userEvent.clear(title);
    await userEvent.type(title, "Changed review");
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await userEvent.click(page.getByRole("button", { name: "Keep editing" }));
    await expect(title).toHaveValue("Changed review");
    await expect(title).toHaveFocus();
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    await expect(page.getByRole("dialog", { name: "Changed review" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit event" })).toHaveFocus();
    await userEvent.click(page.getByRole("button", { name: "Close event panel" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Open Changed review" })).toHaveFocus());
  },
};

export const SwitchWithDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(canvas.getByRole("button", { name: "Open Design review" }));
    await userEvent.click(page.getByRole("button", { name: "Edit event" }));
    await userEvent.type(page.getByRole("textbox", { name: "Title" }), " draft");
    await userEvent.click(canvas.getByRole("button", { name: "Open Weekly planning" }));
    await waitFor(() => expect(page.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible());
    await userEvent.click(page.getByRole("button", { name: "Discard changes" }));
    await expect(page.getByRole("dialog", { name: "Weekly planning" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close event panel" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Open Weekly planning" })).toHaveFocus());
    await expect(canvas.getByRole("button", { name: "Open Design review" })).toBeVisible();
  },
};

export const AllDay: Story = {
  play: async ({ canvasElement }) => {
    const page = within(document.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Open Design review" }));
    await userEvent.click(page.getByRole("button", { name: "Edit event" }));
    await userEvent.click(page.getByRole("switch", { name: "All day" }));
    await expect(page.queryByLabelText("Start")).toBeNull();
    await expect(page.getByLabelText("End date")).toHaveValue("2026-09-12");
    await expect(page.getByLabelText("End date")).toHaveAttribute("min", "2026-09-12");
    await userEvent.click(page.getByRole("switch", { name: "All day" }));
    await expect(page.getByLabelText("Start")).toHaveValue("10:00");
    await userEvent.click(page.getByRole("switch", { name: "All day" }));
    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    await expect(page.getByText("All day", { exact: true })).toBeVisible();
  },
};
