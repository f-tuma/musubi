import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";

function Example() {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button">Open details</button>
      </PopoverTrigger>
      <PopoverContent aria-label="Details" role="dialog">
        Layer content
      </PopoverContent>
    </Popover>
  );
}

describe("Popover", () => {
  it("portals the shared surface and returns focus after Escape", async () => {
    const user = userEvent.setup();
    render(<Example />);

    const trigger = screen.getByRole("button", { name: "Open details" });
    await user.click(trigger);

    const content = screen.getByRole("dialog", { name: "Details" });
    expect(content.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(document.body);
    expect(content.getAttribute("data-mobile-surface")).toBe("sheet");
    expect(content.getAttribute("data-ui")).toBe("popover-content");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
