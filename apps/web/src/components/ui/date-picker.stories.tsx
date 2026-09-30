import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { ColorPicker } from "~/components/ui/color-picker";
import { DatePicker, DateFormatContext } from "~/components/ui/date-picker";
import { Field, FieldGroup } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { TimeDial } from "~/components/ui/time-dial";
import { TimePicker } from "~/components/ui/time-picker";

const meta = {
  title: "Design system/Pickers",
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
  decorators: [(Story) => <div className="w-full max-w-form">{Story()}</div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const EventTime: Story = {
  render: function Render() {
    const [date, setDate] = useState("2026-10-06");
    const [start, setStart] = useState("09:30");
    const [end, setEnd] = useState("10:15");
    return (
      <FieldGroup>
        <Field label="Date">
          <DatePicker label="Date" value={date} weekStartsOn="monday" onChange={setDate} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Starts">
            <TimePicker label="Starts" timeFormat="24h" value={start} onChange={setStart} />
          </Field>
          <Field label="Ends">
            <TimePicker label="Ends" min={start} timeFormat="24h" value={end} onChange={setEnd} />
          </Field>
        </div>
      </FieldGroup>
    );
  },
};

export const States: Story = {
  render: function Render() {
    const [due, setDue] = useState("");
    return (
      <FieldGroup>
        <Field label="Due date">
          <DatePicker
            label="Due date"
            placeholder="No due date"
            value={due}
            weekStartsOn="monday"
            onChange={setDue}
            onClear={() => setDue("")}
          />
        </Field>
        <Field error="Ends before it starts." label="Ends">
          <TimePicker label="Ends" timeFormat="12h" value="08:00" onChange={() => undefined} />
        </Field>
        <Field label="Repeats until">
          <DatePicker disabled label="Repeats until" value="2026-12-31" weekStartsOn="monday" onChange={() => undefined} />
        </Field>
        <Field label="Reminder time">
          <TimePicker disabled label="Reminder time" placeholder="Select time" timeFormat="24h" value="" onChange={() => undefined} />
        </Field>
      </FieldGroup>
    );
  },
};

export const InlineRow: Story = {
  render: function Render() {
    const [date, setDate] = useState("2026-10-06");
    const [time, setTime] = useState("14:00");
    return (
      <div className="flex items-center gap-4 rounded-card border border-border bg-panel px-4">
        <DatePicker label="Date" value={date} variant="inline" weekStartsOn="monday" onChange={setDate} />
        <TimePicker label="Start time" timeFormat="24h" value={time} variant="inline" onChange={setTime} />
      </div>
    );
  },
};

export const DayFirstDates: Story = {
  render: function Render() {
    const [date, setDate] = useState("2026-10-06");
    return (
      <DateFormatContext.Provider value="dmy">
        <Field label="Family trip">
          <DatePicker label="Family trip" value={date} weekStartsOn="monday" onChange={setDate} />
        </Field>
      </DateFormatContext.Provider>
    );
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("button", { name: /Family trip:/ }));
    const entry = await body.findByRole("textbox", { name: "Exact date" });
    await expect(entry).toHaveValue("06/10/2026");
    await userEvent.clear(entry);
    await userEvent.type(entry, "12/10/2026{Enter}");
    await waitFor(() => expect(body.getByRole("button", { name: /Family trip: .*October 12, 2026/ })).toBeInTheDocument());
  },
};

export const Dial: Story = {
  render: function Render() {
    const [phase, setPhase] = useState<"hour" | "minute">("hour");
    const [[hour, minute], setTime] = useState([15, 45]);
    return (
      <div className="w-80 rounded-card border border-border bg-canvas">
        <TimeDial
          format="24h"
          hour={hour!}
          hours={Array.from({ length: 24 }, (_, index) => index)}
          minute={minute!}
          minutes={Array.from({ length: 60 }, (_, index) => index)}
          phase={phase}
          onChoose={(nextHour, nextMinute) => {
            setTime([nextHour, nextMinute]);
            setPhase("hour");
          }}
          onPhase={setPhase}
          onPreview={(nextHour, nextMinute) => setTime([nextHour, nextMinute])}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const dial = within(canvasElement).getByRole("slider", { name: "Hour dial" });
    dial.focus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await expect(within(canvasElement).getByRole("slider", { name: "Minute dial" })).toHaveAttribute("aria-valuenow", "45");
  },
};

export const Colors: Story = {
  render: function Render() {
    const [studio, setStudio] = useState("#C8553D");
    const [personal, setPersonal] = useState("#7A8BA3");
    const [family, setFamily] = useState("#336699");
    return (
      <FieldGroup>
        {(
          [
            ["Studio", studio, setStudio, null],
            ["Personal", personal, setPersonal, "microsoft"],
            ["Family", family, setFamily, null],
          ] as const
        ).map(([name, value, setValue, provider]) => (
          <div className="flex items-end gap-3" key={name}>
            <Field className="flex-1" label="Calendar name">
              <Input defaultValue={name} />
            </Field>
            <ColorPicker label={`${name} color`} provider={provider} value={value} onChange={setValue} />
          </div>
        ))}
        <ColorPicker disabled label="Holidays color" value="#B3A48A" onChange={() => undefined} />
      </FieldGroup>
    );
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("button", { name: "Studio color: #C8553D" }));
    await userEvent.click(await body.findByRole("option", { name: "Custom color" }));
    await userEvent.type(body.getByRole("textbox", { name: "Hex color" }), "{Backspace>7}#12");
    await expect(body.getByRole("alert")).toHaveTextContent("six hexadecimal characters");
  },
};
