import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button";
import { Checkbox } from "./Checkbox";
import { Dialog } from "./Dialog";
import { Empty } from "./Empty";
import { Field } from "./Field";
import { RowAction, RowOptions, RowToggle } from "./Row";
import { Segmented } from "./Segmented";
import { Select } from "./Select";
import { SectionLabel } from "./SectionLabel";
import { SettingsSection } from "./SettingsSection";
import { Switch } from "./Switch";
import { Toast } from "./Toast";

function DialogHarness() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      closeLabel="Close event editor"
      description="Choose the calendar and time for this event."
      open={open}
      title="Edit event"
      trigger={<button type="button">Open editor</button>}
      onOpenChange={setOpen}
    >
      <label htmlFor="dialog-title">Title</label>
      <input id="dialog-title" />
    </Dialog>
  );
}

describe("Button primitives", () => {
  it("uses a safe default type and invokes its action", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<Button onClick={onClick}>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect((button as HTMLButtonElement).type).toBe("button");
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("blocks interaction and exposes a busy state while loading", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe("Save");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps icon content mounted while loading", () => {
    const { rerender } = render(
      <Button icon={<span data-testid="save-icon">+</span>}>Save</Button>,
    );
    const icon = screen.getByTestId("save-icon");

    rerender(
      <Button icon={<span data-testid="save-icon">+</span>} loading>
        Save
      </Button>,
    );

    expect(screen.getByTestId("save-icon")).toBe(icon);
    expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
  });

  it("requires and renders an accessible name for icon-only actions", () => {
    render(
      <IconButton label="Close">
        <span>×</span>
      </IconButton>,
    );

    expect(
      screen.getByRole("button", { name: "Close" }).getAttribute("title"),
    ).toBe("Close");
  });

  it("passes toggle state through the icon-only contract", () => {
    render(
      <IconButton aria-pressed="true" label="Toggle settings">
        <span>×</span>
      </IconButton>,
    );

    expect(
      screen.getByRole("button", { name: "Toggle settings", pressed: true }),
    ).not.toBeNull();
  });
});

describe("Field", () => {
  it("connects its label, description and error to the control", () => {
    render(
      <Field
        description="Visible to people you invite."
        error="Enter a title."
        label="Event title"
      >
        <input />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: "Event title" });
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy).toContain("-description");
    expect(describedBy).toContain("-error");
    expect(screen.getByRole("alert").textContent).toBe("Enter a title.");
  });
});

describe("static primitives", () => {
  it("keeps section labels in the heading outline", () => {
    render(<SectionLabel level={3}>Appearance</SectionLabel>);
    expect(
      screen.getByRole("heading", { level: 3, name: "Appearance" }),
    ).not.toBeNull();
  });

  it("renders a useful empty state with its optional action", () => {
    render(
      <Empty
        action={<Button>Connect account</Button>}
        description="Connect a calendar provider to see events here."
        title="No calendars yet"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No calendars yet" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect account" }),
    ).not.toBeNull();
  });
});

describe("choice primitives", () => {
  it("moves a segmented selection with arrows and Home/End", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <Segmented
        label="Theme"
        options={[
          { label: "System", value: "system" },
          { disabled: true, label: "Light", value: "light" },
          { label: "Dark", value: "dark" },
        ]}
        value="system"
        onChange={onChange}
      />,
    );

    const system = screen.getByRole("radio", { name: "System" });
    system.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("dark");

    rerender(
      <Segmented
        label="Theme"
        options={[
          { label: "System", value: "system" },
          { disabled: true, label: "Light", value: "light" },
          { label: "Dark", value: "dark" },
        ]}
        value="dark"
        onChange={onChange}
      />,
    );
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("dark");
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("system");
    expect(
      screen
        .getByRole("radiogroup", { name: "Theme" })
        .getAttribute("aria-orientation"),
    ).toBe("horizontal");
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

    expect(
      screen.getByRole("radio", { name: "Month" }).getAttribute("tabindex"),
    ).toBe("-1");
    expect(
      screen.getByRole("radio", { name: "Week" }).getAttribute("tabindex"),
    ).toBe("0");
  });

  it("uses native button keyboard behaviour for a switch", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();

    render(
      <Switch
        checked={false}
        label="Event notifications"
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Event notifications",
    });
    toggle.focus();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("keeps checkbox semantics and exposes a custom select listbox", async () => {
    const user = userEvent.setup();
    const onCheckboxChange = vi.fn();
    const onSelectChange = vi.fn();

    render(
      <>
        <Checkbox label="Studio" onChange={onCheckboxChange} />
        <Select
          id="calendar"
          label="Calendar"
          onChange={onSelectChange}
          options={[
            { label: "Personal", value: "personal" },
            { label: "Studio", value: "studio" },
          ]}
          value="personal"
        />
      </>,
    );

    await user.click(screen.getByRole("checkbox", { name: "Studio" }));
    expect(onCheckboxChange).toHaveBeenCalledOnce();
    const trigger = screen.getByRole("combobox", { name: "Calendar" });
    await user.click(trigger);
    const personal = screen.getByRole("option", { name: "Personal" });
    expect(personal.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("s");
    const studio = screen.getByRole("option", { name: "Studio" });
    await waitFor(() => expect(document.activeElement).toBe(studio));
    await user.keyboard("{Enter}");
    expect(onSelectChange).toHaveBeenCalledWith("studio");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("row variants", () => {
  it("makes the whole action row operable", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(
      <RowAction
        detail="web-qa@example.invalid"
        label="Account"
        value="Owner"
        onClick={onClick}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Account/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("exposes a row toggle as one switch without nested controls", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();

    render(
      <RowToggle
        checked
        label="Show week numbers"
        onCheckedChange={onCheckedChange}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Show week numbers",
    });
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

    expect(
      screen
        .getAllByRole("radio")
        .every((option) => (option as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it("exposes selected and destructive variants through the named API", () => {
    render(
      <>
        <RowAction label="Current page" selected />
        <RowAction label="Delete account" tone="destructive" />
      </>,
    );

    expect(
      screen
        .getByRole("button", { name: "Current page" })
        .hasAttribute("data-selected"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Delete account" })
        .getAttribute("data-tone"),
    ).toBe("destructive");
  });
});

describe("SettingsSection", () => {
  it("groups row controls under a semantic heading", () => {
    render(
      <SettingsSection title="Appearance">
        <RowToggle
          checked
          label="Show week numbers"
          onCheckedChange={vi.fn()}
        />
      </SettingsSection>,
    );

    expect(
      screen.getByRole("heading", { level: 3, name: "Appearance" }),
    ).not.toBeNull();
    expect(screen.getByRole("region", { name: "Appearance" })).not.toBeNull();
    expect(screen.getByRole("switch", { name: "Show week numbers" })).not.toBeNull();
  });
});

describe("overlay primitives", () => {
  it("names a dialog, closes it with Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const trigger = screen.getByRole("button", { name: "Open editor" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", {
        name: "Edit event",
        description: "Choose the calendar and time for this event.",
      });
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("data-body-layout")).toBe("padded");
    expect(document.activeElement).not.toBe(trigger);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("announces a toast without moving focus and keeps its action operable", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Keep focus</button>
        <Toast
          action={{ label: "Undo", onClick: onAction }}
          message="Event moved."
        />
      </>,
    );

    const focusTarget = screen.getByRole("button", { name: "Keep focus" });
    focusTarget.focus();
    const status = screen.getByRole("status");
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(status.textContent).toContain("Event moved.");
    expect(status.contains(undo)).toBe(false);
    expect(document.activeElement).toBe(focusTarget);

    await user.click(undo);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("uses an assertive alert only for error toasts", () => {
    render(<Toast message="Could not save event." tone="error" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not save event.",
    );
  });
});
