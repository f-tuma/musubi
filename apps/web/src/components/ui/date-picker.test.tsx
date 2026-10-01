import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DatePicker, DateFormatContext } from "~/components/ui/date-picker";

function renderPicker(
  onChange: (value: string) => void,
  overrides: Partial<React.ComponentProps<typeof DatePicker>> = {},
) {
  return render(
    <DatePicker
      label="Date"
      value="2026-07-28"
      weekStartsOn="monday"
      onChange={onChange}
      {...overrides}
    />,
  );
}

describe("DatePicker", () => {
  it("opens on the selected date and chooses with the keyboard", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);

    const trigger = screen.getByRole("button", {
      name: /Date: Tuesday, July 28, 2026/,
    });
    await user.click(trigger);

    const selected = screen.getByRole("gridcell", {
      name: "Tuesday, July 28, 2026",
    });
    await waitFor(() => expect(document.activeElement).toBe(selected));
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{ArrowRight}");
    const nextDay = screen.getByRole("gridcell", {
      name: "Wednesday, July 29, 2026",
    });
    await waitFor(() => expect(document.activeElement).toBe(nextDay));
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("2026-07-29");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("supports exact typed entry without a native date input", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);

    await user.click(screen.getByRole("button", { name: /Date:/ }));
    const input = screen.getByRole("textbox", { name: "Exact date" });
    await user.clear(input);
    await user.type(input, "2026-08-05{Enter}");

    expect(onChange).toHaveBeenCalledWith("2026-08-05");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables dates before the minimum and will not focus them", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange, {
      min: "2026-07-30",
      value: "2026-07-30",
    });

    await user.click(screen.getByRole("button", { name: /Date:/ }));
    const selected = screen.getByRole("gridcell", {
      name: "Thursday, July 30, 2026",
    });
    const unavailable = screen.getByRole("gridcell", {
      name: "Wednesday, July 29, 2026",
    });
    expect((unavailable as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(selected));

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(selected);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses PageDown to preserve the day in the next month", async () => {
    const user = userEvent.setup();
    renderPicker(vi.fn());

    await user.click(screen.getByRole("button", { name: /Date:/ }));
    const selected = screen.getByRole("gridcell", {
      name: "Tuesday, July 28, 2026",
    });
    await waitFor(() => expect(document.activeElement).toBe(selected));
    await user.keyboard("{PageDown}");

    const nextMonth = screen.getByRole("gridcell", {
      name: "Friday, August 28, 2026",
    });
    await waitFor(() => expect(document.activeElement).toBe(nextMonth));
  });
});


it.each([
  ["dmy", "28/07/2026", "05/08/2026", "DD/MM/YYYY"],
  ["mdy", "07/28/2026", "08/05/2026", "MM/DD/YYYY"],
  ["ymd", "2026-07-28", "2026-08-05", "YYYY-MM-DD"],
] as const)("uses %s for typed dates", async (format, initial, entry, placeholder) => {
  const user = userEvent.setup(), onChange = vi.fn();
  render(<DateFormatContext.Provider value={format}><DatePicker label="Date" value="2026-07-28" weekStartsOn="monday" onChange={onChange} /></DateFormatContext.Provider>);
  await user.click(screen.getByRole("button", { name: /Date:/ }));
  const input = screen.getByRole("textbox", { name: "Exact date" }) as HTMLInputElement;
  expect(input.value).toBe(initial);
  expect(input.placeholder).toBe(placeholder);
  await user.clear(input);
  await user.type(input, entry + "{Enter}");
  expect(onChange).toHaveBeenCalledWith("2026-08-05");
});

it("changes year and month without committing a date", async () => {
  const onChange = vi.fn(), user = userEvent.setup();
  renderPicker(onChange);
  await user.click(screen.getByRole("button", { name: /Date:/ }));
  await user.click(screen.getByRole("button", { name: "Year: 2026" }));
  await user.click(screen.getByRole("button", { name: "Next year" }));
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Choose 2028" }));
  expect(screen.queryByRole("button", { name: "Choose 2028" })).toBeNull();
  await user.click(screen.getByRole("button", { name: /^Month:/ }));
  await user.click(screen.getByRole("button", { name: "February" }));
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("gridcell", { name: "Tuesday, February 29, 2028" }));
  expect(onChange).toHaveBeenCalledWith("2028-02-29");
});


it("browses years with the wheel without selecting a date or scrolling the page", async () => {
  const onChange = vi.fn(), user = userEvent.setup();
  renderPicker(onChange);
  await user.click(screen.getByRole("button", { name: /Date:/ }));
  await user.click(screen.getByRole("button", { name: "Year: 2026" }));
  const defaultAllowed = fireEvent.wheel(screen.getByRole("button", { name: "Choose 2026" }), { deltaY: 100 });
  expect(defaultAllowed).toBe(false);
  expect(screen.getByRole("button", { name: "Choose 2028" })).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});


it("accelerates continuous wheel scrolling and resets after pausing or reversing", async () => {
  const user = userEvent.setup();
  renderPicker(vi.fn());
  await user.click(screen.getByRole("button", { name: /Date:/ }));
  await user.click(screen.getByRole("button", { name: "Year: 2026" }));
  const center = screen.getByRole("button", { name: "Choose 2026" });
  let now = 1000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    fireEvent.wheel(center, { deltaY: 100 });
    expect(center.textContent).toBe("2027");
    now += 60;
    fireEvent.wheel(center, { deltaY: 100 });
    expect(center.textContent).toBe("2028");
    now += 40;
    fireEvent.wheel(center, { deltaY: 100 });
    expect(center.textContent).toBe("2029");
    now += 40;
    fireEvent.wheel(center, { deltaY: 100 });
    expect(center.textContent).toBe("2030");
    now += 24;
    fireEvent.wheel(center, { deltaY: 100 });
    expect(center.textContent).toBe("2031");
    now += 1;
    fireEvent.wheel(center, { deltaY: -100 });
    expect(center.textContent).toBe("2030");
    now += 500;
    fireEvent.wheel(center, { deltaY: -40 });
    expect(center.textContent).toBe("2029");
    now += 70;
    fireEvent.wheel(center, { deltaY: -40 });
    expect(center.textContent).toBe("2029");
  } finally {
    clock.mockRestore();
  }
});
