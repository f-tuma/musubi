import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { Bell, CalendarDays, Globe, LogOut, Moon, Trash2, Users } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { expect, userEvent, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Disclosure } from "~/components/ui/disclosure";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle, ItemValue } from "~/components/ui/item";
import { Row, RowAction, RowOptions, RowToggle } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { Switch } from "~/components/ui/switch";

const meta = {
  title: "Design system/Rows and settings",
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
  decorators: [(Story) => <div className="w-full max-w-form">{Story()}</div>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const calendars = [
  { name: "Personal", color: "#7A8BA3", detail: "Google · anna@example.com" },
  { name: "Studio", color: "#C8553D", detail: "Outlook · studio@example.com" },
  { name: "Family", color: "#8E9F6F", detail: "Shared by Tomáš" },
];

export const Settings: Story = {
  render: function Render() {
    const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
    const [weekNumbers, setWeekNumbers] = useState(true);
    const [notifications, setNotifications] = useState(false);
    return (
      <div className="grid gap-8">
        <SettingsSection help="Appearance is saved on this device." title="Appearance">
          <RowOptions
            icon={<Moon />}
            label="Theme"
            options={[
              { label: "System", value: "system" },
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
            ]}
            value={theme}
            onChange={setTheme}
          />
          <RowToggle checked={weekNumbers} icon={<CalendarDays />} label="Week numbers" onCheckedChange={setWeekNumbers} />
          <RowToggle checked={notifications} detail="10 minutes before" icon={<Bell />} label="Event reminders" onCheckedChange={setNotifications} />
        </SettingsSection>
        <SettingsSection title="Account">
          <RowAction detail="anna@example.com" icon={<Globe />} label="Time zone" value="Prague" />
          <RowAction icon={<Users />} label="Shared calendars" value="3" />
          <Row label="Version" value="0.2.1" />
          <RowAction icon={<LogOut />} label="Sign out" showChevron={false} />
          <RowAction icon={<Trash2 />} label="Delete account" showChevron={false} tone="destructive" />
        </SettingsSection>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("switch", { name: /Event reminders/ });
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
    await userEvent.click(canvas.getByRole("radio", { name: "Dark" }));
    await expect(canvas.getByRole("radio", { name: "Dark" })).toBeChecked();
  },
};

export const States: Story = {
  render: () => (
    <div className="grid gap-8">
      <SettingsSection title="Saving">
        <RowOptions
          disabled
          label="Default view"
          options={[
            { label: "Week", value: "week" },
            { label: "Month", value: "month" },
          ]}
          value="week"
          onChange={() => undefined}
        />
        <RowToggle checked disabled label="Show tasks" />
        <RowAction disabled label="Export calendar" />
      </SettingsSection>
      <SettingsSection title="Pages">
        <RowAction label="Work week" selected value="Default" />
        <RowAction label="Family" />
        <RowAction label="Everything" size="compact" />
      </SettingsSection>
      <SettingsSection title="Stacked options">
        <RowOptions
          label="Event color"
          options={[
            { label: "Calendar", value: "calendar" },
            { label: "Event", value: "event" },
          ]}
          stacked
          value="calendar"
          onChange={() => undefined}
        />
      </SettingsSection>
    </div>
  ),
};

export const CustomItems: Story = {
  render: function Render() {
    const [visible, setVisible] = useState<Record<string, boolean>>({ Personal: true, Studio: true, Family: false });
    return (
      <SettingsSection title="Calendars" variant="plain">
        <ItemGroup>
          {calendars.map((calendar) => (
            <Item key={calendar.name}>
              <ItemMedia>
                <span className="size-3 rounded-full bg-pigment" style={{ "--pigment": calendar.color } as CSSProperties} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {calendar.name}
                  {calendar.name === "Family" ? <Badge variant="muted">Read only</Badge> : null}
                </ItemTitle>
                <ItemDescription>{calendar.detail}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  checked={visible[calendar.name] ?? false}
                  label={`Show ${calendar.name}`}
                  onCheckedChange={(checked) => setVisible((current) => ({ ...current, [calendar.name]: checked }))}
                />
              </ItemActions>
            </Item>
          ))}
          <Item>
            <ItemMedia>
              <Avatar name="Tomáš Novák" size="compact" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Tomáš Novák</ItemTitle>
              <ItemDescription>Can edit Family</ItemDescription>
            </ItemContent>
            <ItemValue>Editor</ItemValue>
          </Item>
        </ItemGroup>
      </SettingsSection>
    );
  },
};

export const Disclosures: Story = {
  render: () => (
    <div className="grid gap-8">
      <ItemGroup>
        <Disclosure detail="Server and browser state" label="Diagnostics">
          <p className="text-13 text-foreground-secondary">Last sync 2 minutes ago. 142 events in Studio.</p>
          <Button size="compact" variant="secondary">
            Copy report
          </Button>
        </Disclosure>
        <Disclosure icon={<CalendarDays />} label="Advanced repeat" value="Every 2 weeks">
          <p className="text-13 text-foreground-secondary">Ends after 10 occurrences.</p>
        </Disclosure>
      </ItemGroup>
      <Disclosure density="compact" label="More options">
        <p className="text-13 text-foreground-secondary">Visibility, availability and attachments.</p>
      </Disclosure>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const summary = within(canvasElement).getByText("Diagnostics");
    await userEvent.click(summary);
    await expect(summary.closest("details")).toHaveAttribute("open");
  },
};
