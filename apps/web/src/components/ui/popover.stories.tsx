import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { CalendarDays, Copy, MoreHorizontal, Pencil, Share2, Trash2 } from "lucide-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { Label } from "~/components/ui/label";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";

const meta = {
  title: "Design system/Anchored surfaces",
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const PopoverSurface: Story = {
  render: () => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="secondary">Studio</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Studio" role="dialog">
        <PopoverHeader>
          <PopoverTitle>Studio</PopoverTitle>
          <PopoverDescription>Outlook · studio@example.com</PopoverDescription>
        </PopoverHeader>
        <div className="flex justify-end gap-2 p-4">
          <Button size="compact" variant="secondary">
            Hide
          </Button>
          <Button size="compact">Open settings</Button>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const AnchoredOnPhone: Story = {
  render: () => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="secondary">Tuesday</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Tuesday" className="w-64" mobileSurface="anchored" role="dialog" showArrow>
        <PopoverHeader className="pb-4">
          <PopoverTitle>3 events</PopoverTitle>
          <PopoverDescription>Design review, Lunch, School pickup</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  ),
};

function PageActions({ defaultOpen = false, onChoose = () => undefined }: { defaultOpen?: boolean; onChoose?: (value: string) => void }) {
  return (
    <Menu defaultOpen={defaultOpen}>
      <MenuTrigger asChild>
        <Button aria-label="Page actions" size="icon" title="Page actions" variant="ghost">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent label="Page actions">
        <MenuItem icon={<Pencil />} shortcut="R" onSelect={() => onChoose("rename")}>
          Rename page
        </MenuItem>
        <MenuItem icon={<Copy />} onSelect={() => onChoose("duplicate")}>
          Duplicate page
        </MenuItem>
        <MenuItem icon={<Share2 />} disabled>
          Share page
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} tone="destructive" onSelect={() => onChoose("delete")}>
          Delete page
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export const CommandMenu: Story = {
  render: () => <PageActions defaultOpen />,
};

export const CommandMenuKeyboard: Story = {
  render: () => <PageActions />,
  play: async () => {
    screen.getByRole("button", { name: "Page actions" }).focus();
    await userEvent.keyboard("{Enter}");
    await expect(await screen.findByRole("menu", { name: "Page actions" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename page" })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    await expect(screen.getByRole("menuitem", { name: "Duplicate page" })).toHaveFocus();
  },
};

export const DropdownChoices: Story = {
  render: function Render() {
    const [shown, setShown] = useState({ personal: true, studio: true, family: false });
    return (
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">
            <CalendarDays aria-hidden="true" />
            Calendars
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          {(["personal", "studio", "family"] as const).map((key) => (
            <DropdownMenuCheckboxItem
              checked={shown[key]}
              key={key}
              onCheckedChange={(checked) => setShown((current) => ({ ...current, [key]: checked === true }))}
            >
              {key[0]!.toUpperCase() + key.slice(1)}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            New calendar
            <DropdownMenuShortcut>N</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Remove Studio</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

export const Tooltips: Story = {
  render: () => (
    <TooltipProvider>
      <div className="flex items-center gap-6">
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button aria-label="Today" size="icon" variant="ghost">
              <CalendarDays aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Today</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1">
          <Label>Default reminder</Label>
          <HelpTooltip label="Help for Default reminder">Applies to new events. Existing events keep their reminders.</HelpTooltip>
        </div>
      </div>
    </TooltipProvider>
  ),
  play: async () => {
    await userEvent.tab();
    await userEvent.tab();
    await expect(await screen.findByRole("tooltip")).toHaveTextContent("Existing events keep their reminders");
  },
};
