import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Globe, Search, X } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field, FieldGroup, FieldLegend, FieldSet } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";

const meta = {
  title: "Design system/Form controls",
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
  decorators: [(Story) => <div className="w-full max-w-form">{Story()}</div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const calendars = [
  { label: "Personal", value: "personal", description: "Google · anna@example.com" },
  { label: "Studio", value: "studio", description: "Outlook · studio@example.com" },
  { label: "Family", value: "family", description: "Shared by Tomáš" },
  { label: "Holidays", value: "holidays", description: "Read only", disabled: true },
];

export const InputVariants: Story = {
  render: () => (
    <FieldGroup>
      <Field label="Event title">
        <Input variant="title" defaultValue="Design review" />
      </Field>
      <Field label="Location">
        <Input defaultValue="Studio" />
      </Field>
    </FieldGroup>
  ),
};

export const Fields: Story = {
  render: function Render() {
    const [calendar, setCalendar] = useState("studio");
    return (
      <FieldGroup>
        <Field label="Title">
          <Input defaultValue="Design review" />
        </Field>
        <Field label="Calendar">
          <Select label="Calendar" options={calendars} value={calendar} onChange={setCalendar} />
        </Field>
        <Field label="Location" help="Shown to everyone you invite.">
          <Input placeholder="Add a place or link" />
        </Field>
        <Field label="Notes">
          <Textarea defaultValue="Bring examples of long invitations." />
        </Field>
      </FieldGroup>
    );
  },
};

export const States: Story = {
  render: () => (
    <FieldGroup>
      <Field error="Enter a title." label="Title">
        <Input defaultValue="" placeholder="Add title" />
      </Field>
      <Field description="Anyone with the link can see free and busy times." label="Share link">
        <Input readOnly value="https://musubi.example/s/8f14e45f" />
      </Field>
      <Field label="Calendar">
        <Select disabled label="Calendar" options={calendars} value="personal" onChange={() => undefined} />
      </Field>
      <Field label="Room">
        <Input disabled placeholder="Not available for this calendar" />
      </Field>
    </FieldGroup>
  ),
};

export const Inline: Story = {
  render: () => (
    <FieldGroup>
      <Field label="Calendar name" layout="inline">
        <Input defaultValue="Studio" />
      </Field>
      <Field label="Default reminder" layout="inline">
        <Select
          label="Default reminder"
          options={[
            { label: "None", value: "none" },
            { label: "10 minutes before", value: "10" },
            { label: "1 hour before", value: "60" },
          ]}
          value="10"
          onChange={() => undefined}
        />
      </Field>
    </FieldGroup>
  ),
};

export const SelectSearchable: Story = {
  render: function Render() {
    const [zone, setZone] = useState("Europe/Prague");
    return (
      <Field label="Time zone">
        <Select
          label="Time zone"
          searchable
          options={["Europe/Prague", "Europe/London", "America/New_York", "Asia/Tokyo"].map((value) => ({
            label: value.split("/")[1]!.replace("_", " "),
            value,
            description: value,
            icon: <Globe className="size-4" />,
          }))}
          value={zone}
          onChange={setZone}
        />
      </Field>
    );
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole("combobox", { name: "Time zone" }));
    await userEvent.type(await body.findByRole("textbox", { name: "Search Time zone" }), "tok");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(body.getByRole("combobox", { name: "Time zone" })).toHaveTextContent("Tokyo"));
  },
};

export const SearchInput: Story = {
  render: function Render() {
    const [query, setQuery] = useState("Design");
    return (
      <InputGroup>
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput aria-label="Search events" placeholder="Search events" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query ? (
          <InputGroupAddon align="inline-end">
            <Button aria-label="Clear search" size="icon-compact" title="Clear search" variant="ghost" onClick={() => setQuery("")}>
              <X aria-hidden="true" />
            </Button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    );
  },
};

export const Choices: Story = {
  render: function Render() {
    const [view, setView] = useState<"day" | "week" | "month">("week");
    const [tasks, setTasks] = useState(true);
    return (
      <FieldGroup>
        <div className="flex flex-wrap items-center gap-4">
          <Segmented
            label="View"
            options={[
              { label: "Day", value: "day" },
              { label: "Week", value: "week" },
              { label: "Month", value: "month" },
            ]}
            value={view}
            onChange={setView}
          />
          <Segmented
            disabled
            label="Density"
            options={[
              { label: "Comfortable", value: "comfortable" },
              { label: "Compact", value: "compact" },
            ]}
            value="comfortable"
            onChange={() => undefined}
          />
        </div>
        <Segmented
          label="Week starts on"
          options={[
            { label: "Monday", value: "monday" },
            { label: "Saturday", value: "saturday", disabled: true },
            { label: "Sunday", value: "sunday" },
          ]}
          size="control"
          value="monday"
          onChange={() => undefined}
        />
        <div className="flex flex-wrap items-center gap-6">
          <Switch checked={tasks} label="Show tasks" onCheckedChange={setTasks} />
          <Switch disabled checked label="Show holidays" />
        </div>
        <FieldSet>
          <FieldLegend>Calendars</FieldLegend>
          <Checkbox defaultChecked label="Personal" />
          <Checkbox defaultChecked description="Outlook · studio@example.com" label="Studio" />
          <Checkbox label="Family" />
          <Checkbox disabled label="Holidays" />
        </FieldSet>
      </FieldGroup>
    );
  },
};
