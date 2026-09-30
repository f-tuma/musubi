import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor } from "storybook/test";
import { DESKTOP_MODES, MOBILE_MODES } from "../../../.storybook/modes";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { RowAction, RowToggle } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

const meta = {
  title: "Design system/Dialogs",
  parameters: { chromatic: { modes: { ...DESKTOP_MODES, ...MOBILE_MODES } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="secondary">Rename Studio</Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} closeLabel="Close rename" size="form">
        <DialogHeader>
          <DialogTitle>Rename calendar</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            <Field label="Name">
              <Input defaultValue="Studio" />
            </Field>
          </FieldGroup>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  play: async () => {
    const dialog = await screen.findByRole("dialog", { name: "Rename calendar" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename Studio" })).toHaveFocus());
  },
};

export const WithDescriptionAndError: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent closeLabel="Close invite" size="compact">
        <DialogHeader>
          <DialogTitle>Invite to Family</DialogTitle>
          <DialogDescription>They can see and edit every event.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field error="Enter an email address." label="Email">
            <Input placeholder="name@example.com" type="email" />
          </Field>
          <InlineError requestId="req_42c7">The invitation could not be sent.</InlineError>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button loading>Send invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};

export const StandingWindow: Story = {
  parameters: { layout: "fullscreen" },
  render: function Render() {
    const [tasks, setTasks] = useState(true);
    return (
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined} closeLabel="Close settings" size="wide" tall>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Tabs className="min-h-0 flex-1 sm:flex-row" defaultValue="general" orientation="vertical">
              <TabsList className="sm:w-48">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="calendars">Calendars</TabsTrigger>
                <TabsTrigger value="account">Account</TabsTrigger>
              </TabsList>
              <TabsContent className="grid content-start gap-8" value="general">
                <SettingsSection title="Calendar">
                  <RowToggle checked={tasks} label="Show tasks" onCheckedChange={setTasks} />
                  <RowAction label="Week starts on" value="Monday" />
                </SettingsSection>
              </TabsContent>
              <TabsContent value="calendars">
                <SettingsSection title="Calendars">
                  <RowAction label="Personal" value="Google" />
                  <RowAction label="Studio" value="Outlook" />
                  <RowAction label="Family" value="Shared" />
                </SettingsSection>
              </TabsContent>
              <TabsContent value="account">
                <SettingsSection title="Account">
                  <RowAction label="Email" value="anna@example.com" />
                </SettingsSection>
              </TabsContent>
            </Tabs>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  },
};

function DeleteFamily({ loading = false }: { loading?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Delete Family
      </Button>
      <ConfirmationDialog
        closeLabel="Close calendar deletion"
        confirmLabel="Delete calendar"
        description="Its 214 events are removed for everyone."
        loading={loading}
        open={open}
        title="Delete Family?"
        onConfirm={() => setOpen(false)}
        onOpenChange={setOpen}
      />
    </>
  );
}

export const Confirmation: Story = {
  render: () => <DeleteFamily />,
  play: async () => {
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
  },
};

export const ConfirmationLoading: Story = { render: () => <DeleteFamily loading /> };

export const TypedConfirmation: Story = {
  render: function Render() {
    const [name, setName] = useState("");
    return (
      <ConfirmationDialog
        confirmDisabled={name !== "Anna"}
        confirmForm="delete-account"
        confirmLabel="Delete account"
        onOpenChange={() => undefined}
        open
        title="Delete account?"
      >
        <form id="delete-account" onSubmit={(event) => event.preventDefault()}>
          <Field label="Type your name to confirm">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </form>
      </ConfirmationDialog>
    );
  },
};
