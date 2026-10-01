import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ColorPicker, normalizeHexColor } from "~/components/ui/color-picker";

describe("normalizeHexColor", () => {
  it("normalizes valid six-digit colors", () => {
    expect(normalizeHexColor("7a8ba3")).toBe("#7A8BA3");
    expect(normalizeHexColor(" #c8553d ")).toBe("#C8553D");
  });

  it.each(["", "#123", "#1234567", "indigo"])("rejects %s", (input) => {
    expect(normalizeHexColor(input)).toBeNull();
  });
});

function renderPicker(
  onChange: (value: string) => void,
  overrides: Partial<React.ComponentProps<typeof ColorPicker>> = {},
) {
  return render(
    <ColorPicker
      label="New calendar color"
      onChange={onChange}
      value="#B3A48A"
      {...overrides}
    />,
  );
}

describe("ColorPicker", () => {
  it("opens on the value and chooses a named color by keyboard", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);

    const trigger = screen.getByRole("button", {
      name: "New calendar color: #B3A48A",
    });
    await user.click(trigger);

    const dune = screen.getByRole("option", {
      name: "Dune, #B3A48A",
    });
    await waitFor(() => expect(document.activeElement).toBe(dune));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dune.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowRight}{Enter}");

    expect(onChange).toHaveBeenCalledWith("#C8553D");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("enters a custom hex color with live updates", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);

    await user.click(
      screen.getByRole("button", { name: /New calendar color:/ }),
    );
    await user.click(screen.getByRole("option", { name: "Custom color" }));

    const input = screen.getByRole("textbox", { name: "Hex color" });
    await user.clear(input);
    await user.type(input, "336699");

    expect(onChange).toHaveBeenLastCalledWith("#336699");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("explains an invalid custom value and keeps Done disabled", async () => {
    const user = userEvent.setup();
    renderPicker(vi.fn());

    await user.click(
      screen.getByRole("button", { name: /New calendar color:/ }),
    );
    await user.click(screen.getByRole("option", { name: "Custom color" }));
    const input = screen.getByRole("textbox", { name: "Hex color" });
    await user.clear(input);
    await user.type(input, "#12");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain(
      "six hexadecimal characters",
    );
    expect(
      (screen.getByRole("button", { name: "Done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("limits Outlook to its palette and snaps selection to the nearest color", async () => {
    const user = userEvent.setup();
    renderPicker(vi.fn(), {
      provider: "microsoft",
      value: "#70B1E6",
    });

    await user.click(
      screen.getByRole("button", {
        name: "New calendar color: #71B2E7",
      }),
    );

    expect(screen.getAllByRole("option")).toHaveLength(9);
    expect(
      screen.getByRole("option", { name: "Light Blue, #71B2E7" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("option", { name: "Custom color" })).toBeNull();
  });
});
