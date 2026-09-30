import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "~/components/ui/select";

afterEach(cleanup);

describe("Select", () => {
  it("exposes a listbox, chooses by typeahead and returns focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Select
        id="calendar"
        label="Calendar"
        onChange={onChange}
        options={[
          { label: "Personal", value: "personal" },
          { label: "Studio", value: "studio" },
        ]}
        value="personal"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Calendar" });
    await user.click(trigger);
    const personal = screen.getByRole("option", { name: "Personal" });
    expect(personal.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("s");
    const studio = screen.getByRole("option", { name: "Studio" });
    await waitFor(() => expect(document.activeElement).toBe(studio));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("studio");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("filters searchable choices and selects with the keyboard", async () => {
    const user = userEvent.setup();
    let chosen = "";
    render(
      <Select
        label="Time zone"
        searchable
        value="UTC"
        options={[
          { value: "UTC", label: "UTC" },
          { value: "Europe/Prague", label: "Europe/Prague" },
        ]}
        onChange={(value) => {
          chosen = value;
        }}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    const search = await screen.findByRole("textbox", { name: "Search Time zone" });
    await user.type(search, "Prague");
    expect(screen.queryByRole("option", { name: "UTC" })).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(chosen).toBe("Europe/Prague");
  });
});

function SavingPreference({ save }: { save: () => Promise<void> }) {
  const [value, setValue] = useState("off");
  const [saving, setSaving] = useState(false);
  return (
    <>
      <Select
        label="Reminder"
        value={value}
        disabled={saving}
        options={[
          { value: "off", label: "Off" },
          { value: "ten", label: "10 minutes" },
        ]}
        onChange={(next) => {
          setValue(next);
          setSaving(true);
          void save().finally(() => setSaving(false));
        }}
      />
      <button type="button">Another setting</button>
    </>
  );
}

describe("Select focus after an asynchronous choice", () => {
  for (const moveFocus of [false, true]) {
    it(moveFocus ? "does not reclaim focus after the person moves on" : "returns to the trigger once saving enables it", async () => {
      let finish!: () => void;
      const saved = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const user = userEvent.setup();
      render(<SavingPreference save={() => saved} />);
      const trigger = screen.getByRole("combobox", { name: "Reminder" });
      await user.click(trigger);
      await user.click(await screen.findByRole("option", { name: "10 minutes" }));
      await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(true));
      const other = screen.getByRole("button", { name: "Another setting" });
      if (moveFocus) await user.click(other);
      await act(async () => {
        finish();
        await saved;
      });
      await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
      await waitFor(() => expect(document.activeElement).toBe(moveFocus ? other : trigger));
    });
  }
});
