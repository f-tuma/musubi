import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { X } from "lucide-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { Field, FieldGroup } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Inspector, InspectorClose, InspectorContent, InspectorHeaderActions, InspectorTrigger } from "~/components/ui/inspector";
import type { InspectorPresentation } from "~/components/ui/inspector-preferences";
import { Textarea } from "~/components/ui/textarea";

function Example({ initialPresentation = "panel", expanded = false }: { initialPresentation?: InspectorPresentation; expanded?: boolean }) {
  const [open, setOpen] = useState(true);
  const [presentation, setPresentation] = useState(initialPresentation);
  return (
    <Inspector
      expanded={expanded}
      open={open}
      presentation={presentation}
      onOpenChange={setOpen}
      onPresentationChange={setPresentation}
      onRequestClose={(after) => {
        setOpen(false);
        after();
      }}
    >
      <InspectorTrigger asChild>
        <Button variant="secondary">Design review</Button>
      </InspectorTrigger>
      <InspectorContent accessibleTitle="Edit event" onFocusOutside={(event) => event.preventDefault()}>
        <header className="flex shrink-0 items-center justify-between gap-4 py-4 pr-4 pl-6" data-inspector-header="">
          <h2 className="font-serif text-22 leading-tight font-normal text-foreground">Edit event</h2>
          <InspectorHeaderActions>
            <InspectorClose asChild>
              <Button aria-label="Close event editor" size="icon-compact" title="Close event editor" variant="ghost">
                <X aria-hidden="true" />
              </Button>
            </InspectorClose>
          </InspectorHeaderActions>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6">
          <FieldGroup>
            <Field label="Title">
              <Input defaultValue="Design review" />
            </Field>
            <Field label="Location">
              <Input defaultValue="Studio · meeting room" />
            </Field>
            <Field label="Notes">
              <Textarea defaultValue="Bring examples of long invitations and shared calendars." />
            </Field>
          </FieldGroup>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <InspectorClose asChild>
            <Button variant="secondary">Cancel</Button>
          </InspectorClose>
          <Button onClick={() => setOpen(false)}>Save</Button>
        </footer>
      </InspectorContent>
    </Inspector>
  );
}

const meta = {
  title: "Design system/Inspector",
  parameters: { layout: "fullscreen", chromatic: { modes: DESKTOP_MODES } },
  render: () => <Example />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SidePanel: Story = {};
export const FloatingWindow: Story = { render: () => <Example initialPresentation="floating" /> };
export const Expanded: Story = { render: () => <Example expanded /> };
export const Narrow: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  parameters: { chromatic: { modes: MOBILE_MODES } },
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Edit event" });
    await Promise.all(dialog.getAnimations().map(animation => animation.finished));
    const bounds = dialog.getBoundingClientRect();
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(window.innerWidth);
    expect(bounds.height).toBe(window.innerHeight);
    await expect(within(dialog).getByRole("button", { name: "Save" })).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close event editor" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Design review" })).toHaveFocus());
  },
};

export const PreserveDraft: Story = {
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Edit event" });
    const field = within(dialog).getByRole("textbox", { name: "Title" });
    await userEvent.clear(field);
    await userEvent.type(field, "Studio retro");
    await userEvent.click(within(dialog).getByRole("button", { name: "Float window" }));
    await expect(dialog).toHaveAttribute("data-presentation", "floating");
    await expect(field).toHaveValue("Studio retro");
    await userEvent.click(within(dialog).getByRole("button", { name: "Dock to side" }));
    await expect(dialog).toHaveAttribute("data-presentation", "panel");
    await expect(field).toHaveValue("Studio retro");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close event editor" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Design review" })).toHaveFocus());
  },
};
