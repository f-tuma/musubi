import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Segmented } from "~/components/ui/segmented";

const themes = [
  { label: "System", value: "system" },
  { disabled: true, label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const;

describe("Segmented", () => {
  it("moves a segmented selection with arrows and Home/End", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Segmented label="Theme" options={themes} value="system" onChange={onChange} />);

    screen.getByRole("radio", { name: "System" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("dark");

    rerender(<Segmented label="Theme" options={themes} value="dark" onChange={onChange} />);
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("dark");
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("system");
    expect(screen.getByRole("radiogroup", { name: "Theme" }).getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("does not emit a duplicate change for the selected segment", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Segmented
        label="Theme"
        options={[
          { label: "System", value: "system" },
          { label: "Dark", value: "dark" },
        ]}
        value="system"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an enabled segmented option in the tab order", () => {
    render(
      <Segmented
        label="View"
        options={[
          { disabled: true, label: "Month", value: "month" },
          { label: "Week", value: "week" },
        ]}
        value="month"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: "Month" }).getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("tabindex")).toBe("0");
  });
});
