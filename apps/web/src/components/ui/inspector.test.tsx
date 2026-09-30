import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Inspector, InspectorClose, InspectorContent, InspectorTrigger, requestInspectorTransition } from "~/components/ui/inspector";

afterEach(cleanup);

function SelectedObject({ name, guard = false }: { name: string; guard?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState<(() => void) | null>(null);
  return <Inspector open={open} onOpenChange={setOpen} onRequestClose={after => {
    const finish = () => { setOpen(false); after(); };
    if (guard) setPendingClose(() => finish);
    else finish();
  }}>
    <InspectorTrigger>{`Inspect ${name}`}</InspectorTrigger>
    <InspectorContent accessibleTitle={name} onInteractOutside={event => event.preventDefault()}>
      <p>{`${name} content`}</p>
      <InspectorClose>{`Close ${name}`}</InspectorClose>
      {pendingClose ? <>
        <button onClick={() => setPendingClose(null)}>Keep editing</button>
        <button onClick={() => { pendingClose(); setPendingClose(null); }}>Discard draft</button>
      </> : null}
    </InspectorContent>
  </Inspector>;
}

describe("Inspector", () => {
  it("guards an imperative create entry point before replacing an edited object", async () => {
    const user = userEvent.setup();
    function WorkspaceEntry() {
      const [creating, setCreating] = useState(false);
      return <>
        <SelectedObject name="Event" guard />
        <button onClick={() => requestInspectorTransition(() => setCreating(true))}>New event</button>
        {creating ? <p>Creating event</p> : null}
      </>;
    }
    render(<WorkspaceEntry />);
    await user.click(screen.getByRole("button", { name: "Inspect Event" }));
    await user.click(screen.getByRole("button", { name: "New event" }));
    expect(screen.queryByText("Creating event")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New event" }));
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByRole("dialog", { name: "Event" })).toBeNull();
    expect(screen.getByText("Creating event")).toBeTruthy();
  });

  it("switches selection with only one object panel open", async () => {
    const user = userEvent.setup();
    render(<><SelectedObject name="Event" /><SelectedObject name="Calendar" /></>);
    await user.click(screen.getByRole("button", { name: "Inspect Event" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Inspect Calendar" }));
    expect(screen.queryByRole("dialog", { name: "Event" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Calendar" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("keeps selection until the draft owner accepts the close continuation", async () => {
    const user = userEvent.setup();
    render(<><SelectedObject name="Event" guard /><SelectedObject name="Calendar" /></>);
    await user.click(screen.getByRole("button", { name: "Inspect Event" }));
    await user.click(screen.getByRole("button", { name: "Inspect Calendar" }));
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Inspect Calendar" }));
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByRole("dialog", { name: "Event" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Calendar" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("closes on Escape and returns focus to the selected object's trigger", async () => {
    const user = userEvent.setup();
    render(<SelectedObject name="Event" />);
    const trigger = screen.getByRole("button", { name: "Inspect Event" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("routes Escape through the draft guard", async () => {
    const user = userEvent.setup();
    render(<SelectedObject name="Event" guard />);
    await user.click(screen.getByRole("button", { name: "Inspect Event" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Event" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
