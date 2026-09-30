import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "~/components/ui/checkbox";
import { Switch } from "~/components/ui/switch";

describe("Switch", () => {
  it("uses native button keyboard behaviour for a switch", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();

    render(<Switch checked={false} label="Event notifications" onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole("switch", { name: "Event notifications" });
    toggle.focus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe("Checkbox", () => {
  it("keeps native checkbox semantics", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<Checkbox label="Studio" onChange={onChange} />);

    const checkbox = screen.getByRole("checkbox", { name: "Studio" });
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledOnce();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    checkbox.focus();
    await user.keyboard(" ");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });
});
