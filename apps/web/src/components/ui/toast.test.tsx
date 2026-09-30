import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toast } from "~/components/ui/toast";

describe("Toast", () => {
  it("announces a toast without moving focus and keeps its action operable", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Keep focus</button>
        <Toast action={{ label: "Undo", onClick: onAction }} message="Event moved." />
      </>,
    );

    const focusTarget = screen.getByRole("button", { name: "Keep focus" });
    focusTarget.focus();
    const status = screen.getByRole("status");
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(status.textContent).toContain("Event moved.");
    expect(status.contains(undo)).toBe(false);
    expect(document.activeElement).toBe(focusTarget);

    await user.click(undo);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("uses an assertive alert only for error toasts", () => {
    render(<Toast message="Could not save event." tone="error" />);
    expect(screen.getByRole("alert").textContent).toContain("Could not save event.");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
