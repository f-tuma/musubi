import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Disclosure } from "~/components/ui/disclosure";

describe("Disclosure", () => {
  it("keeps its content out of the way until it is asked for", async () => {
    render(
      <Disclosure detail="Server and browser state" label="Full report">
        <p>The evidence</p>
      </Disclosure>,
    );

    const summary = screen.getByText("Full report");
    expect(screen.getByText("Server and browser state")).toBeTruthy();
    expect(summary.closest("details")?.open).toBe(false);

    await userEvent.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
  });

  it("reports what the browser did with it", async () => {
    const onOpenChange = vi.fn();
    render(
      <Disclosure label="Full report" onOpenChange={onOpenChange}>
        <p>The evidence</p>
      </Disclosure>,
    );

    await userEvent.click(screen.getByText("Full report"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  /**
   * The announcement composer drives this from outside: pressing Edit on a
   * published row has to unfold the form the draft was just poured into.
   */
  it("obeys an owner that holds the open state", async () => {
    function Owner() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Edit
          </button>
          <Disclosure
            label="New announcement"
            onOpenChange={setOpen}
            open={open}
          >
            <p>The form</p>
          </Disclosure>
        </>
      );
    }

    render(<Owner />);
    const details = screen.getByText("New announcement").closest("details");
    expect(details?.open).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(details?.open).toBe(true);
  });
});
