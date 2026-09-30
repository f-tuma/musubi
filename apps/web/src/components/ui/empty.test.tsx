import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "~/components/ui/button";
import { Empty } from "~/components/ui/empty";
import { SectionLabel } from "~/components/ui/section-label";

describe("static primitives", () => {
  it("keeps section labels in the heading outline", () => {
    render(<SectionLabel level={3}>Appearance</SectionLabel>);
    expect(screen.getByRole("heading", { level: 3, name: "Appearance" })).not.toBeNull();
  });

  it("renders a useful empty state with its optional action", () => {
    render(
      <Empty
        action={<Button>Connect account</Button>}
        description="Connect a calendar provider to see events here."
        title="No calendars yet"
      />,
    );

    expect(screen.getByRole("heading", { name: "No calendars yet" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Connect account" })).not.toBeNull();
  });
});
