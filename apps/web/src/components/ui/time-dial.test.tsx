import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { dialValue, TimeDial } from "~/components/ui/time-dial";

describe("clock geometry", () => {
  it("distinguishes midnight, noon and both 24-hour rings", () => {
    expect(dialValue(0, -104, "hour", "24h", 9)).toBe(12);
    expect(dialValue(0, -64, "hour", "24h", 9)).toBe(0);
    expect(dialValue(104, 0, "hour", "24h", 9)).toBe(3);
    expect(dialValue(64, 0, "hour", "24h", 9)).toBe(15);
  });
  it("preserves AM/PM and selects individual minutes across midnight", () => {
    expect(dialValue(104, 0, "hour", "12h", 21)).toBe(15);
    expect(dialValue(104, 0, "hour", "12h", 9)).toBe(3);
    const point = (minute: number) => [Math.sin(minute * Math.PI / 30) * 104, -Math.cos(minute * Math.PI / 30) * 104] as const;
    expect(dialValue(...point(7), "minute", "24h", 9)).toBe(7);
    expect(dialValue(...point(59.8), "minute", "24h", 9)).toBe(0);
  });
});

it("previews hours, skips unavailable values and commits minutes only on confirmation", () => {
  const choose = vi.fn();
  function Example() {
    const [phase, setPhase] = useState<"hour" | "minute">("hour");
    const [time, setTime] = useState([9, 15]);
    return <TimeDial hour={time[0]!} minute={time[1]!} format="24h" phase={phase}
      hours={[9, 10, 11]} minutes={[15, 16, 17]} onPhase={setPhase}
      onPreview={(hour, minute) => setTime([hour, minute])} onChoose={choose} />;
  }
  render(<Example />);
  const dial = screen.getByRole("slider", { name: "Hour dial" });
  fireEvent.keyDown(dial, { key: "End" });
  expect(dial.getAttribute("aria-valuenow")).toBe("11");
  expect(choose).not.toHaveBeenCalled();
  fireEvent.keyDown(dial, { key: "Enter" });
  expect(screen.getByRole("slider", { name: "Minute dial" })).toBe(dial);
  fireEvent.keyDown(dial, { key: "ArrowRight" });
  fireEvent.keyDown(dial, { key: "Enter" });
  expect(choose).toHaveBeenCalledWith(11, 16);
});
