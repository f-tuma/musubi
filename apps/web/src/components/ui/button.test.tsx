import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "~/components/ui/button";

describe("Button", () => {
  it("uses a safe default type and invokes its action", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<Button onClick={onClick}>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect((button as HTMLButtonElement).type).toBe("button");
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("blocks interaction and exposes a busy state while loading", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe("Save");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps icon content mounted while loading", () => {
    const { rerender } = render(
      <Button>
        <span aria-hidden="true" data-testid="save-icon">
          +
        </span>
        Save
      </Button>,
    );
    const icon = screen.getByTestId("save-icon");

    rerender(
      <Button loading>
        <span aria-hidden="true" data-testid="save-icon">
          +
        </span>
        Save
      </Button>,
    );

    expect(screen.getByTestId("save-icon")).toBe(icon);
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
  });

  it("names an icon-only action", () => {
    render(
      <Button aria-label="Close" size="icon" title="Close" variant="ghost">
        <span aria-hidden="true">×</span>
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Close" }).getAttribute("title")).toBe("Close");
  });

  it("passes toggle state through an icon-only action", () => {
    render(
      <Button aria-label="Toggle settings" aria-pressed="true" size="icon" variant="ghost">
        <span aria-hidden="true">×</span>
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Toggle settings", pressed: true })).not.toBeNull();
  });

  it("renders a link through asChild without a button type", () => {
    render(
      <Button asChild variant="link">
        <a href="/help">Help</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Help" });
    expect(link.hasAttribute("type")).toBe(false);
    expect(link.getAttribute("data-variant")).toBe("link");
  });
});
