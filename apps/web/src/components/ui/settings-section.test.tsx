import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RowToggle } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";

describe("SettingsSection", () => {
  it("groups row controls under a semantic heading", () => {
    render(
      <SettingsSection title="Appearance">
        <RowToggle checked label="Show week numbers" onCheckedChange={vi.fn()} />
      </SettingsSection>,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Appearance" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "Appearance" })).not.toBeNull();
    expect(screen.getByRole("switch", { name: "Show week numbers" })).not.toBeNull();
  });

  it("puts background help behind a named question mark", () => {
    render(
      <SettingsSection help="Preferences sync across your devices." title="Appearance">
        <RowToggle checked label="Show week numbers" onCheckedChange={vi.fn()} />
      </SettingsSection>,
    );

    expect(screen.getByRole("button", { name: "About Appearance" })).not.toBeNull();
  });
});
