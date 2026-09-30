import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button">Open editor</button>
      </DialogTrigger>
      <DialogContent closeLabel="Close event editor" size="form">
        <DialogHeader>
          <DialogTitle>Edit event</DialogTitle>
          <DialogDescription>Choose the calendar and time for this event.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="dialog-title">Title</label>
          <input id="dialog-title" />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("names a dialog, closes it with Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const trigger = screen.getByRole("button", { name: "Open editor" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", {
      name: "Edit event",
      description: "Choose the calendar and time for this event.",
    });
    expect(dialog).not.toBeNull();
    expect(document.activeElement).not.toBe(trigger);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from its named close button", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    await user.click(screen.getByRole("button", { name: "Open editor" }));
    await user.click(screen.getByRole("button", { name: "Close event editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("honours initial focus and returns focus to a gesture's target", async () => {
    const user = userEvent.setup();
    function Gesture() {
      const [open, setOpen] = useState(false);
      const origin = useRef<HTMLButtonElement>(null);
      const field = useRef<HTMLInputElement>(null);
      return (
        <>
          <button ref={origin} type="button">
            Event on Tuesday
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            Open from shortcut
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined} initialFocus={field} returnFocus={origin}>
              <DialogHeader>
                <DialogTitle>Rename</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <button type="button">First</button>
                <input aria-label="Name" ref={field} />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Gesture />);

    await user.click(screen.getByRole("button", { name: "Open from shortcut" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Event on Tuesday" }));
  });
});
