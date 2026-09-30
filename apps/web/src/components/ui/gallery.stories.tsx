import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Bell, CalendarDays, Globe, Moon, Trash2 } from "lucide-react";
import { useState } from "react";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Empty } from "~/components/ui/empty";
import { Field, FieldGroup } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { Row, RowAction, RowOptions, RowToggle } from "~/components/ui/row";
import { Segmented } from "~/components/ui/segmented";
import { Select } from "~/components/ui/select";
import { SettingsSection } from "~/components/ui/settings-section";
import { Switch } from "~/components/ui/switch";

const meta = {
  title: "Design system/Gallery",
  parameters: { layout: "fullscreen", chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Actions() {
  return (
    <SettingsSection title="Actions" variant="plain">
      <div className="flex flex-wrap items-center gap-3">
        <Button>Save changes</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">Skip</Button>
        <Button variant="destructive">
          <Trash2 aria-hidden="true" />
          Delete calendar
        </Button>
        <Button variant="link">Forgot passphrase?</Button>
        <Button loading>Saving</Button>
        <Button size="compact" variant="secondary">
          Compact
        </Button>
        <Button aria-label="Notifications" size="icon" variant="ghost">
          <Bell aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Personal</Badge>
        <Badge variant="muted">Read only</Badge>
        <Badge variant="success">Connected</Badge>
        <Badge variant="warning">Needs attention</Badge>
        <Badge variant="shu">New</Badge>
      </div>
    </SettingsSection>
  );
}

function Form() {
  const [zone, setZone] = useState("Europe/Prague");
  const [view, setView] = useState<"day" | "week" | "month">("month");
  const [tasks, setTasks] = useState(true);
  return (
    <SettingsSection title="Form" variant="plain">
      <FieldGroup>
        <Field label="Calendar name">
          <Input defaultValue="Studio" />
        </Field>
        <Field error="An invite link ends in a long code." label="Invite link">
          <Input defaultValue="https://musubi.example/invite/" />
        </Field>
        <Field help="Events are shown in this zone unless they carry their own." label="Time zone">
          <Select
            label="Time zone"
            options={[
              { label: "Prague", value: "Europe/Prague", icon: <Globe className="size-4" /> },
              { label: "London", value: "Europe/London", icon: <Globe className="size-4" /> },
              { label: "Tokyo", value: "Asia/Tokyo", icon: <Globe className="size-4" /> },
            ]}
            value={zone}
            onChange={setZone}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-6">
          <Segmented
            label="Default view"
            options={[
              { label: "Day", value: "day" },
              { label: "Week", value: "week" },
              { label: "Month", value: "month" },
            ]}
            value={view}
            onChange={setView}
          />
          <Switch checked={tasks} label="Include tasks" onCheckedChange={setTasks} />
          <Checkbox defaultChecked label="Include tasks" />
        </div>
        <InlineError requestId="req_8f14e45f">The calendar could not be saved.</InlineError>
      </FieldGroup>
    </SettingsSection>
  );
}

function Settings() {
  const [theme, setTheme] = useState<"system" | "dark" | "light">("system");
  const [labels, setLabels] = useState(true);
  return (
    <div className="grid gap-8">
      <SettingsSection title="Appearance" help="Preferences sync across your Musubi devices.">
        <RowOptions
          icon={<Moon />}
          label="Theme"
          options={[
            { label: "System", value: "system" },
            { label: "Dark", value: "dark" },
            { label: "Light", value: "light" },
          ]}
          value={theme}
          onChange={setTheme}
        />
        <RowToggle checked={labels} detail="In the mobile navigation" label="Tab labels" onCheckedChange={setLabels} />
        <RowAction icon={<CalendarDays />} label="Week starts on" value="Monday" />
        <Row label="Version" value="0.2.1" />
      </SettingsSection>
      <Empty
        action={<Button>Connect a calendar</Button>}
        icon={<CalendarDays />}
        title="No calendars yet"
      />
    </div>
  );
}

export const Overview: Story = {
  render: () => (
    <div className="mx-auto grid w-full max-w-default gap-10 px-4 py-10">
      <Actions />
      <Form />
      <Settings />
    </div>
  ),
};

export const StandingDialog: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button>Open dialog</Button>
      </DialogTrigger>
      <DialogContent closeLabel="Close settings" size="form">
        <DialogHeader>
          <DialogTitle>Rename calendar</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="Name">
            <Input defaultValue="Studio" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary">Cancel</Button>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
