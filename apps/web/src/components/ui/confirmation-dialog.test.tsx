import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type FormEvent, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { InlineError } from "~/components/ui/inline-error";

function ConfirmationHarness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>
        Remove calendar
      </button>
      <ConfirmationDialog
        closeLabel="Close calendar deletion"
        confirmLabel="Delete calendar"
        description="The calendar and its events will be removed."
        onConfirm={onConfirm}
        onOpenChange={setOpen}
        open={open}
        returnFocus={opener}
        title="Delete Family?"
      >
        <InlineError requestId="request-42">Deletion failed.</InlineError>
      </ConfirmationDialog>
    </>
  );
}

describe("ConfirmationDialog", () => {
  it("focuses the safe action and commits only from the confirm action", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmationHarness onConfirm={onConfirm} />);

    const opener = screen.getByRole("button", { name: "Remove calendar" });
    await user.click(opener);

    expect(
      screen.getByRole("dialog", { name: "Delete Family?", description: "The calendar and its events will be removed." }),
    ).not.toBeNull();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(screen.getByRole("alert").textContent).toContain("request-42");

    await user.click(screen.getByRole("button", { name: "Delete calendar" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cancels without committing and returns focus", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmationHarness onConfirm={onConfirm} />);

    const opener = screen.getByRole("button", { name: "Remove calendar" });
    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("associates typed confirmations with their form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());

    render(
      <ConfirmationDialog
        closeLabel="Close account deletion"
        confirmForm="delete-account-test-form"
        confirmLabel="Delete account"
        description="Permanently removes your account."
        onOpenChange={() => undefined}
        open
        title="Delete account?"
      >
        <form id="delete-account-test-form" onSubmit={onSubmit}>
          <input aria-label="Type your name" />
        </form>
      </ConfirmationDialog>,
    );

    const confirm = screen.getByRole("button", { name: "Delete account" });
    expect(confirm.getAttribute("form")).toBe("delete-account-test-form");
    expect((confirm as HTMLButtonElement).type).toBe("submit");
    await user.click(confirm);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
