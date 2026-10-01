import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";

describe("Field", () => {
  it("connects its label, description and error to the control", () => {
    render(
      <Field description="Visible to people you invite." error="Enter a title." label="Event title">
        <Input />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: "Event title" });
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy).toContain("-description");
    expect(describedBy).toContain("-error");
    expect(screen.getByRole("alert").textContent).toBe("Enter a title.");
  });

  it("keeps a caller's id and description and offers help beside the label", () => {
    render(
      <>
        <p id="zone-note">Saved per device.</p>
        <Field help="Events are shown in this zone." label="Time zone">
          <Input aria-describedby="zone-note" id="zone" />
        </Field>
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Time zone" });
    expect(input.id).toBe("zone");
    expect(input.getAttribute("aria-describedby")).toBe("zone-note");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByRole("button", { name: "Help for Time zone" })).not.toBeNull();
  });
});
