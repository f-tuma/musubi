import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RowAction, RowOptions, RowToggle } from "~/components/ui/row";

describe("row variants", () => {
  it("makes the whole action row operable", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<RowAction detail="web-qa@example.invalid" label="Account" value="Owner" onClick={onClick} />);

    await user.click(screen.getByRole("button", { name: /Account/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("exposes a row toggle as one switch without nested controls", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();

    render(<RowToggle checked label="Show week numbers" onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole("switch", { name: "Show week numbers" });
    expect(toggle.querySelectorAll("button")).toHaveLength(0);
    await user.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("labels the segmented choice inside an options row", () => {
    render(
      <RowOptions
        label="Theme"
        options={[
          { label: "System", value: "system" },
          { label: "Light", value: "light" },
        ]}
        value="system"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Theme" })).not.toBeNull();
  });

  it("disables every option while an options row is saving", () => {
    render(
      <RowOptions
        disabled
        label="Theme"
        options={[
          { label: "System", value: "system" },
          { label: "Light", value: "light" },
        ]}
        value="system"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("radio").every((option) => (option as HTMLButtonElement).disabled)).toBe(true);
  });

  it("exposes selected and destructive variants through the named API", () => {
    render(
      <>
        <RowAction label="Current page" selected />
        <RowAction label="Delete account" tone="destructive" />
      </>,
    );

    expect(screen.getByRole("button", { name: "Current page" }).hasAttribute("data-selected")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete account" }).getAttribute("data-tone")).toBe("destructive");
  });
});
