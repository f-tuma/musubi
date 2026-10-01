import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";

function Example({ onChoose }: { onChoose: (value: string) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button">Open page actions</button>
      </MenuTrigger>
      <MenuContent label="Page actions">
        <MenuItem onSelect={() => onChoose("duplicate")}>
          Duplicate page
        </MenuItem>
        <MenuItem onSelect={() => onChoose("default")}>Set as default</MenuItem>
        <MenuItem disabled onSelect={() => onChoose("export")}>
          Export page
        </MenuItem>
        <MenuSeparator />
        <MenuItem tone="destructive" onSelect={() => onChoose("delete")}>
          Delete page
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

describe("Menu", () => {
  it("opens narrow command sheets after the pointer is released", async () => {
    const media = vi.spyOn(window, "matchMedia").mockReturnValue({ ...window.matchMedia(""), matches: true });
    try {
      const onChoose = vi.fn();
      const user = userEvent.setup();
      render(<Example onChoose={onChoose} />);
      const trigger = screen.getByRole("button", { name: "Open page actions" });

      await user.pointer({ keys: "[TouchA>]", target: trigger });
      expect(screen.queryByRole("menu")).toBeNull();
      await user.pointer({ keys: "[/TouchA]", target: trigger });
      expect(screen.getByRole("menu", { name: "Page actions" })).not.toBeNull();
      expect(onChoose).not.toHaveBeenCalled();

      await user.click(trigger);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(onChoose).not.toHaveBeenCalled();
    } finally {
      media.mockRestore();
    }
  });

  it("keeps keyboard opening immediate on narrow viewports", async () => {
    const media = vi.spyOn(window, "matchMedia").mockReturnValue({ ...window.matchMedia(""), matches: true });
    try {
      const onChoose = vi.fn();
      const user = userEvent.setup();
      render(<Example onChoose={onChoose} />);
      screen.getByRole("button", { name: "Open page actions" }).focus();
      await user.keyboard("{ArrowDown}");
      const firstItem = screen.getByRole("menuitem", { name: "Duplicate page" });
      await waitFor(() => expect(document.activeElement).toBe(firstItem));
      await user.keyboard("{Enter}");
      expect(onChoose).toHaveBeenCalledWith("duplicate");
    } finally {
      media.mockRestore();
    }
  });

  it("manages command focus, selection and focus return", async () => {
    const onChoose = vi.fn();
    const user = userEvent.setup();
    render(<Example onChoose={onChoose} />);

    const trigger = screen.getByRole("button", { name: "Open page actions" });
    trigger.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("menu", { name: "Page actions" })).not.toBeNull();
    const firstItem = screen.getByRole("menuitem", {
      name: "Duplicate page",
    });
    await waitFor(() => expect(document.activeElement).toBe(firstItem));

    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChoose).toHaveBeenCalledWith("default");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("supports typeahead and skips disabled commands", async () => {
    const onChoose = vi.fn();
    const user = userEvent.setup();
    render(<Example onChoose={onChoose} />);

    const trigger = screen.getByRole("button", { name: "Open page actions" });
    trigger.focus();
    await user.keyboard("{Enter}de");

    const deleteItem = screen.getByRole("menuitem", { name: "Delete page" });
    await waitFor(() => expect(document.activeElement).toBe(deleteItem));
    await user.keyboard("{Enter}");

    expect(onChoose).toHaveBeenCalledWith("delete");
    expect(onChoose).not.toHaveBeenCalledWith("export");
  });
});
