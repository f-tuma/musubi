import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { getServerOrigin } from "~/api/query-keys";
import type { PageConfigV1 } from "@musubi/types";
import { render as renderBase, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "~/api/http";
import { fixtureCalendars, fixtureEvents } from "../fixtures";
import type { SavePageResult } from "../page-editor";
import { Workspace } from "./Workspace";

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(["server-capabilities", getServerOrigin()], { googleAvailability: false });
  return renderBase(ui, { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

const commonProps = {
  activeView: "month" as const,
  calendars: fixtureCalendars,
  date: "2026-07-26",
  events: fixtureEvents,
  isRefreshing: false,
  onCreateEvent: vi.fn(async (event) => event),
  onDateChange: vi.fn(),
  onPageChange: vi.fn(),
  onRemoveEvent: vi.fn(async (event) => ({
    calendars: [],
    id: event.id,
    removed: true,
  })),
  onSignOut: vi.fn(),
  onUpdateEvent: vi.fn(async (event) => event),
  onViewChange: vi.fn(),
  onCreatePage: vi.fn(),
  onSavePage: vi.fn(),
  pageId: "my-calendar",
  pages: [
    {
      config: {
        calendarVisibility: { hiddenCalendarIds: [], mode: "all" as const },
        filters: [],
        icon: "house" as const,
        schemaVersion: 1 as const,
        view: {
          configVersion: 1 as const,
          id: "month" as const,
          showAdjacentDays: true,
        },
      },
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      id: "my-calendar",
      isDefault: true,
      name: "My calendar",
      position: 0,
      revision: 1,
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  ],
  settings: {
    dateFormat: "dmy" as const,
    defaultCalendarView: "month" as const,
    notificationsOnByDefault: true,
    theme: "system" as const,
    timeFormat: "24h" as const,
    weekStartsOn: "monday" as const,
  },
  user: {
    email: "alex@example.com",
    id: "alex",
    name: "Alex",
  },
};

describe("Workspace", () => {
  it("saves calendar filters from Page settings", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn(async (input) => ({
      page: { ...commonProps.pages[0]!, config: input.config, revision: 2 },
      status: "saved" as const,
    }));

    render(<Workspace {...commonProps} onSavePage={onSavePage} />);

    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Page settings" }),
    );
    const studio = dialog.getByRole("button", { name: "Studio" });
    await user.click(studio);

    expect(studio.getAttribute("aria-pressed")).toBe("false");
    expect(onSavePage).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(onSavePage).toHaveBeenCalledWith({
      baseRevision: 1,
      config: {
        ...commonProps.pages[0]!.config,
        calendarVisibility: { hiddenCalendarIds: ["studio"], mode: "all" },
      },
      id: "my-calendar",
      name: "My calendar",
    });
  });

  it("saves item type switches in Page settings", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn(async input => ({
      page: { ...commonProps.pages[0]!, config: input.config, revision: 2 }, status: "saved" as const,
    }));
    render(<Workspace {...commonProps} onSavePage={onSavePage} />);
    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(screen.getByRole("dialog", { name: "Page settings" }));
    await user.click(dialog.getByRole("switch", { name: "Events" }));
    await user.click(dialog.getByRole("switch", { name: "Tasks" }));
    await user.click(dialog.getByRole("button", { name: "Save" }));
    expect(onSavePage).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ filters: [{ type: "item-types", value: ["meetings"] }] }),
    }));
  });

  it("switches views without drafting Page settings", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn();
    const onViewChange = vi.fn();

    render(
      <Workspace
        {...commonProps}
        onSavePage={onSavePage}
        onViewChange={onViewChange}
      />,
    );

    await user.keyboard("a");
    expect(onViewChange).toHaveBeenCalledWith("agenda");
    await user.keyboard("t");
    expect(onViewChange).toHaveBeenCalledWith("tasks");
    expect(
      screen.queryByRole("region", { name: "Unsaved Page changes" }),
    ).toBeNull();

    await user.keyboard("{Control>}s{/Control}");
    expect(onSavePage).not.toHaveBeenCalled();
  });

  it("keeps shortcuts working while focus sits on the last button clicked", async () => {
    const user = userEvent.setup();
    const onDateChange = vi.fn();
    const onViewChange = vi.fn();

    render(
      <Workspace
        {...commonProps}
        onDateChange={onDateChange}
        onViewChange={onViewChange}
      />,
    );

    const today = within(screen.getByLabelText("Jump to date")).getByRole("button", { name: "Today" });
    await user.click(today);
    expect(document.activeElement).toBe(today);

    await user.keyboard("w");
    expect(onViewChange).toHaveBeenCalledWith("week");
  });

  it("allows view changes while Page settings are saving", async () => {
    const user = userEvent.setup();
    let resolveSave!: (result: SavePageResult) => void;
    const pendingSave = new Promise<SavePageResult>((resolve) => {
      resolveSave = resolve;
    });
    const onSavePage = vi.fn<
      (input: {
        baseRevision: number;
        config: PageConfigV1;
        id: string;
        name: string;
      }) => Promise<SavePageResult>
    >(() => pendingSave);
    const onViewChange = vi.fn();
    const config = {
      ...commonProps.pages[0]!.config,
      calendarVisibility: {
        hiddenCalendarIds: ["studio"],
        mode: "all" as const,
      },
    };

    render(
      <Workspace
        {...commonProps}
        onPageDraftsChange={vi.fn()}
        onSavePage={onSavePage}
        onViewChange={onViewChange}
        pageDrafts={
          new Map([
            [
              "my-calendar",
              {
                config,
                conflict: false,
                persisted: commonProps.pages[0]!,
              },
            ],
          ])
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.keyboard("w");
    expect(onViewChange).toHaveBeenCalledWith("week");

    resolveSave({
      page: { ...commonProps.pages[0]!, config, revision: 2 },
      status: "saved",
    });
  });

  it("opens each Page in its saved view without drafting transient views", async () => {
    const user = userEvent.setup();
    const onDateChange = vi.fn();
    const onPageChange = vi.fn();
    const workPage = {
      ...commonProps.pages[0]!,
      config: {
        ...commonProps.pages[0]!.config,
        view: {
          configVersion: 1 as const,
          density: "comfortable" as const,
          id: "week" as const,
          weekend: true,
        },
      },
      id: "work",
      isDefault: false,
      name: "Work",
      position: 1,
    };
    const props = {
      ...commonProps,
      onDateChange,
      onPageChange,
      pages: [...commonProps.pages, workPage],
    };
    const rendered = render(<Workspace {...props} />);

    await user.click(screen.getByRole("radio", { name: "Agenda" }));
    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(onPageChange).toHaveBeenLastCalledWith("work", "week");
    expect(onDateChange).not.toHaveBeenCalled();

    rendered.rerender(<Workspace {...props} activeView="week" pageId="work" />);
    await user.click(screen.getByRole("button", { name: "My calendar" }));
    expect(onPageChange).toHaveBeenLastCalledWith("my-calendar", "month");

    rendered.rerender(
      <Workspace {...props} activeView="month" pageId="my-calendar" />,
    );
    expect(
      screen.queryByRole("region", { name: "Unsaved Page changes" }),
    ).toBeNull();
  });

  it("retains a conflicting draft and can save it as a copy", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn(async () => ({ status: "conflict" as const }));
    const onCreatePage = vi.fn(async (request) => ({
      ...commonProps.pages[0]!,
      config: request.config,
      id: "my-calendar-copy",
      isDefault: false,
      name: request.name,
      revision: 1,
    }));
    const onPageChange = vi.fn();

    render(
      <Workspace
        {...commonProps}
        onCreatePage={onCreatePage}
        onPageChange={onPageChange}
        onSavePage={onSavePage}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Page settings" }),
    );
    await user.click(dialog.getByRole("button", { name: "Studio" }));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert").textContent).toContain(
      "changed on another device",
    );
    expect(
      screen.getByRole("button", { name: "Save as a copy" }),
    ).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Save as a copy" }));

    expect(onCreatePage).toHaveBeenCalledWith({
      config: {
        ...commonProps.pages[0]!.config,
        calendarVisibility: { hiddenCalendarIds: ["studio"], mode: "all" },
      },
      name: "My calendar copy",
    });
    expect(onPageChange).toHaveBeenCalledWith("my-calendar-copy", "month");
  });

  it("keeps a transient view out of saved Page settings", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn(async (input) => ({
      page: {
        ...commonProps.pages[0]!,
        config: input.config,
        name: input.name,
        revision: 2,
      },
      status: "saved" as const,
    }));

    render(<Workspace {...commonProps} onSavePage={onSavePage} />);

    await user.click(screen.getByRole("radio", { name: "Agenda" }));
    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Page settings" }),
    );
    await user.clear(dialog.getByLabelText("Page name"));
    await user.type(dialog.getByLabelText("Page name"), "Focused");
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(onSavePage).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRevision: 1,
        config: expect.objectContaining({
          view: commonProps.pages[0]!.config.view,
        }),
        id: "my-calendar",
        name: "Focused",
      }),
    );
    expect(
      screen.queryByRole("region", { name: "Unsaved Page changes" }),
    ).toBeNull();
  });

  it("clears the shared draft when Page settings conflict edits are discarded", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn(async () => ({ status: "conflict" as const }));

    render(<Workspace {...commonProps} onSavePage={onSavePage} />);

    await user.click(screen.getByRole("radio", { name: "Agenda" }));
    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Page settings" }),
    );
    await user.clear(dialog.getByLabelText("Page name"));
    await user.type(dialog.getByLabelText("Page name"), "Conflicting");
    await user.click(dialog.getByRole("button", { name: "Save" }));
    await user.click(
      dialog.getByRole("button", { name: "Discard my changes" }),
    );

    expect(screen.queryByRole("dialog", { name: "Page settings" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Unsaved Page changes" }),
    ).toBeNull();
  });

  it("saves name, icon and visibility from the page settings dialog", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn<
      (input: {
        baseRevision: number;
        config: { calendarVisibility: unknown; icon?: string };
        id: string;
        name: string;
      }) => Promise<{ page: (typeof commonProps.pages)[0]; status: "saved" }>
    >(async () => ({
      page: commonProps.pages[0]!,
      status: "saved" as const,
    }));

    render(<Workspace {...commonProps} onSavePage={onSavePage} />);

    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(screen.getByRole("dialog"));

    // Nothing to save until something actually changes.
    expect(
      dialog.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);

    await user.clear(dialog.getByLabelText("Page name"));
    await user.type(dialog.getByLabelText("Page name"), "Studio only");
    await user.click(dialog.getByRole("radio", { name: "Star" }));
    await user.click(dialog.getByRole("button", { name: "Studio" }));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(onSavePage).toHaveBeenCalledTimes(1);
    const request = onSavePage.mock.calls[0]![0];
    expect(request).toMatchObject({
      baseRevision: 1,
      id: "my-calendar",
      name: "Studio only",
    });
    expect(request.config.icon).toBe("star");
    expect(request.config.calendarVisibility).toEqual({
      hiddenCalendarIds: ["studio"],
      mode: "all",
    });
  });

  it("creates a page from the current Page filters", async () => {
    const user = userEvent.setup();
    const onCreatePage = vi.fn(
      async (request: { config: unknown; name: string }) => ({
        ...commonProps.pages[0]!,
        id: "work",
        isDefault: false,
        name: request.name,
      }),
    );
    const onPageChange = vi.fn();
    const filteredPage = {
      ...commonProps.pages[0]!,
      config: {
        ...commonProps.pages[0]!.config,
        calendarVisibility: {
          hiddenCalendarIds: ["studio"],
          mode: "all" as const,
        },
      },
    };

    render(
      <Workspace
        {...commonProps}
        onCreatePage={onCreatePage}
        onPageChange={onPageChange}
        pages={[filteredPage]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "New page" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog
        .getByRole("button", { name: "Create page" })
        .hasAttribute("disabled"),
    ).toBe(true);

    await user.type(dialog.getByLabelText("Page name"), "Work");
    await user.click(dialog.getByRole("radio", { name: "Briefcase" }));
    await user.click(dialog.getByRole("button", { name: "Create page" }));

    expect(onCreatePage.mock.calls[0]![0]).toEqual({
      config: {
        calendarVisibility: {
          calendarIds: ["personal", "client-work", "family-calendar"],
          mode: "include",
        },
        filters: [],
        icon: "briefcase",
        schemaVersion: 1,
        view: { configVersion: 1, id: "month", showAdjacentDays: true },
      },
      name: "Work",
    });
    expect(onPageChange).toHaveBeenCalledWith("work", "month");
  });

  it("deletes a page from its settings, but never the last one", async () => {
    const user = userEvent.setup();
    const onDeletePage = vi.fn(async () => undefined);
    const secondPage = {
      ...commonProps.pages[0]!,
      id: "work",
      isDefault: false,
      name: "Work",
      position: 1,
    };
    const single = render(
      <Workspace {...commonProps} onDeletePage={onDeletePage} />,
    );
    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    expect(
      within(screen.getByRole("dialog")).queryByRole("button", {
        name: "Delete page",
      }),
    ).toBeNull();
    single.unmount();

    render(
      <Workspace
        {...commonProps}
        onDeletePage={onDeletePage}
        pages={[...commonProps.pages, secondPage]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit Work" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete page",
      }),
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete “Work”?" })).getByRole(
        "button",
        { name: "Delete page" },
      ),
    );

    expect(onDeletePage).toHaveBeenCalledWith("work");
  });

  it("sets a Page as default without discarding its unsaved draft", async () => {
    const user = userEvent.setup();
    const onSetDefaultPage = vi.fn(async () => undefined);
    const workPage = {
      ...commonProps.pages[0]!,
      id: "work",
      isDefault: false,
      name: "Work",
      position: 1,
    };

    render(
      <Workspace
        {...commonProps}
        onSetDefaultPage={onSetDefaultPage}
        pages={[...commonProps.pages, workPage]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Page settings" }),
    );
    await user.clear(dialog.getByLabelText("Page name"));
    await user.type(dialog.getByLabelText("Page name"), "Deep work");
    await user.click(dialog.getByRole("button", { name: "Set as default" }));

    expect(onSetDefaultPage).toHaveBeenCalledWith("work");
    expect(dialog.getByText("Default", { selector: "span" })).not.toBeNull();
    expect((dialog.getByLabelText("Page name") as HTMLInputElement).value).toBe(
      "Deep work",
    );
    expect(
      dialog.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("stops syncing one external calendar without disconnecting its account", async () => {
    const user = userEvent.setup();
    const externalCalendar = {
      ...fixtureCalendars[1]!,
      accountId: "google-work",
      accountLabel: "work@example.com",
      provider: "google" as const,
    };
    const onDisconnectExternalCalendar = vi.fn(async () => undefined);

    render(
      <Workspace
        {...commonProps}
        calendars={[fixtureCalendars[0]!, externalCalendar]}
        onDisconnectExternalCalendar={onDisconnectExternalCalendar}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Calendars" }));
    const settingsWindow = within(
      screen.getByRole("dialog", { name: "Settings" }),
    );
    await user.click(
      settingsWindow.getByRole("button", { name: "Settings for Studio" }),
    );
    const stopButton = within(
      screen.getByRole("dialog", { name: "Calendar settings" }),
    ).getByRole("button", { name: "Stop syncing" });
    await user.click(stopButton);

    const confirmation = within(
      screen.getByRole("dialog", { name: "Stop syncing “Studio”?" }),
    );
    expect(
      confirmation.getByText("It stays in Google Calendar, and the account stays connected."),
    ).not.toBeNull();
    await user.click(confirmation.getByRole("button", { name: "Cancel" }));

    await user.click(stopButton);
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Stop syncing “Studio”?" }),
      ).getByRole("button", { name: "Stop syncing" }),
    );

    expect(onDisconnectExternalCalendar).toHaveBeenCalledWith(externalCalendar);
    expect(screen.getByRole("status").textContent).toContain(
      "Stopped syncing Studio.",
    );
  });

  it("keeps Page filter edits when discard is declined", async () => {
    const user = userEvent.setup();
    const onSavePage = vi.fn();

    render(<Workspace {...commonProps} onSavePage={onSavePage} />);
    await user.click(screen.getByRole("button", { name: "Edit My calendar" }));
    const dialog = within(
      screen.getByRole("dialog", { name: "Page settings" }),
    );
    await user.click(dialog.getByRole("button", { name: "Studio" }));
    await user.click(
      dialog.getByRole("button", { name: "Close page settings" }),
    );
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Discard page changes?" }),
      ).getByRole("button", { name: "Cancel" }),
    );

    expect(
      within(screen.getByRole("dialog", { name: "Page settings" }))
        .getByRole("button", { name: "Studio" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(onSavePage).not.toHaveBeenCalled();
  });

  it("finds events and actions from the search palette", async () => {
    const user = userEvent.setup();
    const onDateChange = vi.fn();

    render(<Workspace {...commonProps} onDateChange={onDateChange} />);
    await user.click(
      screen.getByRole("button", { name: "Search events and actions" }),
    );

    const dialog = within(
      screen.getByRole("dialog", { name: "Search Musubi" }),
    );
    expect(dialog.getByRole("button", { name: "Go to today" })).not.toBeNull();
    await user.type(
      dialog.getByRole("searchbox", { name: "Search events and actions" }),
      "quarterly",
    );

    const quarterly = dialog.getByRole("button", {
      name: /Quarterly planning/,
    });
    expect(quarterly).not.toBeNull();
    expect(dialog.queryByRole("button", { name: /Design review/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Design review/, hidden: true }),
    ).not.toBeNull();

    await user.click(quarterly);
    expect(screen.getByRole("dialog", { name: "Quarterly planning" })).toBeTruthy();
    expect(onDateChange).not.toHaveBeenCalled();
  });

  it("keeps a read-only search detail readable and retires refreshed private content", async () => {
    const user = userEvent.setup();
    const original = { ...fixtureEvents[0]!, title: "Private search event", description: "Secret search notes" };
    const readCalendars = fixtureCalendars.map(calendar => ({ ...calendar, role: "reader" }));
    const source = { data: { events: [original], tasks: [], calendars: readCalendars }, loading: false, error: false, retry: vi.fn() };
    const props = { ...commonProps, calendars: readCalendars, events: [], searchAccount: source, onOpenFullEditor: vi.fn() };
    const view = render(<Workspace {...props} />);
    await user.click(screen.getByRole("button", { name: "Search events and actions" }));
    await user.type(screen.getByRole("searchbox"), "Private search event");
    await user.click(screen.getByRole("button", { name: /Private search event/ }));
    const detail = screen.getByRole("dialog", { name: original.title });
    expect(within(detail).getByText(original.description)).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: "Edit" })).toBeNull();
    view.rerender(<Workspace {...props} searchAccount={{ ...source, data: { ...source.data, events: [{ ...original, title: "Busy", description: "" }] } }} />);
    expect(screen.queryByText(original.description)).toBeNull();
    expect(screen.getByRole("dialog", { name: "Busy" })).toBeTruthy();
    view.rerender(<Workspace {...props} searchAccount={{ ...source, data: { ...source.data, events: [] } }} />);
    expect(screen.queryByText("Busy")).toBeNull();
    expect(screen.getByText("This event is no longer available.")).toBeTruthy();
  });

  it("renders future event days as one continuous Agenda", () => {
    const { container } = render(
      <Workspace {...commonProps} activeView="agenda" />,
    );

    expect(screen.getByText("From Jul 26, 2026")).not.toBeNull();
    expect(container.querySelectorAll("[data-agenda-date]")).toHaveLength(5);
    expect(
      container.querySelectorAll('[data-agenda-year="2026"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-agenda-date="2026-07-26"]'),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Board games/ })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Previous agenda start" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Next agenda start" }),
    ).toBeNull();
  });

  it("exposes Agenda as an enabled view", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();

    render(<Workspace {...commonProps} onViewChange={onViewChange} />);

    await user.click(screen.getByRole("radio", { name: "Agenda" }));

    expect(onViewChange).toHaveBeenCalledWith("agenda");
  });

  it("limits the initial Agenda DOM to fourteen event-day groups", () => {
    const manyEvents = Array.from({ length: 20 }, (_, index) => {
      const start = new Date(2026, 6, 27 + index, 10);
      const end = new Date(2026, 6, 27 + index, 11);

      return {
        ...fixtureEvents[1]!,
        end,
        id: `agenda-${index}`,
        recurrence: null,
        start,
        title: `Agenda item ${index}`,
      };
    });
    const { container } = render(
      <Workspace {...commonProps} activeView="agenda" events={manyEvents} />,
    );

    expect(container.querySelectorAll("[data-agenda-date]")).toHaveLength(14);
    expect(container.querySelector("[data-agenda-sentinel]")).not.toBeNull();
  });

  it("renders one shared time grid for Day and pages by one day", async () => {
    const user = userEvent.setup();
    const onDateChange = vi.fn();
    const { container } = render(
      <Workspace
        {...commonProps}
        activeView="day"
        date="2026-07-27"
        onDateChange={onDateChange}
      />,
    );

    expect(screen.getByText("Monday, July 27, 2026")).not.toBeNull();
    expect(container.querySelectorAll("[data-time-grid-day]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Board games/ })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Next day" }));
    expect(onDateChange).toHaveBeenCalledWith("2026-07-28");
  });

  it("renders seven Week columns with a continuous all-day span", () => {
    const { container } = render(
      <Workspace {...commonProps} activeView="week" />,
    );

    expect(screen.getByText("Jul 20 – 26, 2026")).not.toBeNull();
    expect(container.querySelectorAll("[data-time-grid-day]")).toHaveLength(7);
    expect(
      screen.getByRole("button", { name: /All-day event, Family holiday/ }),
    ).not.toBeNull();
  });

  it("creates an event through the anchored quick form", async () => {
    const user = userEvent.setup();
    const onCreateEvent = vi.fn(async (event) => event);

    render(<Workspace {...commonProps} onCreateEvent={onCreateEvent} />);

    await user.click(
      screen.getByRole("button", { name: "Create event, meeting or task" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Event" }));
    await user.type(
      screen.getByRole("textbox", { name: "Event title" }),
      "Release check",
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "Create event" })).getByRole(
        "button",
        { name: "Create" },
      ),
    );

    expect(onCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendars: ["personal"],
        creatorID: "alex",
        title: "Release check",
      }),
    );
    expect(screen.getByRole("status").textContent).toContain("Event created.");
  });

  it("opens the task editor from the create menu without a duplicate heading", async () => {
    const user = userEvent.setup();

    render(<Workspace {...commonProps} activeView="tasks" />);

    expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Create event, meeting or task" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Task" }));

    expect(screen.getByRole("dialog", { name: "New task" })).not.toBeNull();
  });

  it.each(["month", "week", "agenda"] as const)("opens and reopens a task sidebar without leaving %s", async (activeView) => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<Workspace {...commonProps} activeView={activeView} onViewChange={onViewChange} />);
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.click(screen.getByRole("button", { name: "Create event, meeting or task" }));
      await user.click(screen.getByRole("menuitem", { name: "Task" }));
      const editor = screen.getByRole("dialog", { name: "New task" });
      expect(editor).not.toBeNull();
      expect(onViewChange).not.toHaveBeenCalled();
      await user.click(within(editor).getByRole("button", { name: "Close task editor" }));
      expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
    }
  });

  it("offers tasks but not events for a task-only calendar", async () => {
    const user = userEvent.setup();
    render(
      <Workspace
        {...commonProps}
        activeView="tasks"
        calendars={[
          {
            ...fixtureCalendars[0]!,
            supportsEvents: false,
            supportsTasks: true,
          },
        ]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Create event, meeting or task" }),
    );
    expect(
      screen
        .getByRole("menuitem", { name: "Event" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitem", { name: "Task" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("keeps saved tasks readable but not editable offline", () => {
    render(
      <Workspace
        {...commonProps}
        activeView="tasks"
        offline
        tasks={[
          {
            calendarID: "personal",
            completedAt: null,
            creatorID: "alex",
            description: null,
            due: null,
            id: "offline-task",
            isAllDay: false,
            percentComplete: 0,
            priority: 0,
            recurrence: null,
            relatedTo: null,
            sequence: 0,
            start: null,
            status: "needs-action",
            title: "Saved offline task",
            url: null,
          },
        ]}
      />,
    );

    const tasks = screen.getByRole("region", { name: "Tasks" });
    expect(tasks.textContent).toContain("Saved offline task");
    expect(
      within(tasks)
        .getByRole("combobox", {
          name: "Status of Saved offline task",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(tasks).queryByRole("button", { name: /Saved offline task/ }),
    ).toBeNull();
  });

  it("edits and deletes an event when its home calendar is writable", async () => {
    const user = userEvent.setup();
    const onUpdateEvent = vi.fn(async (event) => event);
    const onRemoveEvent = vi.fn(async (event) => ({
      calendars: [],
      id: event.id,
      removed: true,
    }));

    render(
      <Workspace
        {...commonProps}
        onRemoveEvent={onRemoveEvent}
        onUpdateEvent={onUpdateEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Board game pub/ }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Event title" });
    await user.clear(title);
    await user.type(title, "Board games");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onUpdateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "board-game", title: "Board games" }),
    );

    // Successful save returns to the detail; deletion still requires confirmation.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRemoveEvent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onRemoveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "board-game" }),
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("also confirms provider-backed event deletion", async () => {
    const user = userEvent.setup();
    const onRemoveEvent = vi.fn(async (event) => ({
      calendars: [],
      id: event.id,
      removed: true,
    }));
    // A provider-backed calendar: the delete leaves for the other system, so a
    // restore would land there as a new event.
    const providerCalendars = fixtureCalendars.map((calendar) => ({
      ...calendar,
      provider: "google" as const,
    }));

    render(
      <Workspace
        {...commonProps}
        calendars={providerCalendars}
        onRemoveEvent={onRemoveEvent}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Board game pub/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRemoveEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRemoveEvent).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows the full create form in the panel without an editor page", async () => {
    const user = userEvent.setup();

    render(<Workspace {...commonProps} />);

    await user.click(
      screen.getByRole("button", { name: "Create event, meeting or task" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Event" }));
    await user.type(
      screen.getByRole("textbox", { name: "Event title" }),
      "Studio time",
    );
    expect(screen.getByPlaceholderText("Add location")).not.toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "Event title" }) as HTMLInputElement)
        .value,
    ).toBe("Studio time");
  });

  it("expands creation in place even when an editor route is available", async () => {
    const user = userEvent.setup();
    const onOpenFullEditor = vi.fn();

    render(<Workspace {...commonProps} onOpenFullEditor={onOpenFullEditor} />);

    await user.click(
      screen.getByRole("button", { name: "Create event, meeting or task" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Event" }));
    await user.type(
      screen.getByRole("textbox", { name: "Event title" }),
      "Studio time",
    );
    await user.click(screen.getByRole("button", { name: "Expand event editor" }));

    expect(onOpenFullEditor).not.toHaveBeenCalled();
    const title = screen.getByRole("textbox", { name: "Event title" }) as HTMLInputElement;
    expect(title.value).toBe("Studio time");
    expect(title.closest("form")?.dataset.layout).toBe("page");
    await user.click(screen.getByRole("button", { name: "Collapse event editor" }));
    expect(title.closest("form")?.dataset.layout).toBe("panel");
    expect(title.value).toBe("Studio time");
  });

  it("does not expose write controls for viewer-only calendars", async () => {
    const user = userEvent.setup();
    const viewerCalendars = fixtureCalendars.map((calendar) => ({
      ...calendar,
      role: "viewer",
      provider: "microsoft",
    }));

    render(<Workspace {...commonProps} calendars={viewerCalendars} />);

    expect(
      screen.queryByRole("button", { name: "Create event, meeting or task" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: /Board game pub/ }));
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(
      screen.getByText("Outlook reports this calendar as read-only", {
        exact: false,
      }),
    ).not.toBeNull();
  });

  it("marks a read-only block in the grid, not only in its popover", () => {
    const { container } = render(
      <Workspace
        {...commonProps}
        activeView="day"
        date="2026-07-06"
        calendars={fixtureCalendars.map((calendar) => ({
          ...calendar,
          role: "viewer",
        }))}
      />,
    );

    const blocks = container.querySelectorAll("[data-time-event]");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.getAttribute("data-readonly")).toBe("");
      expect(block.querySelector(".lucide-lock")).not.toBeNull();
    }
  });

  it.each([
    {
      scenario: "an unconfirmed save",
      error: new ApiError("Provider unavailable", 502, "provider-request"),
      message: "Google Calendar did not confirm this change",
    },
    {
      scenario: "an unsupported explicit time create",
      error: new ApiError(
        "Creating or copying events with an explicit time model is not supported for this calendar. No changes were saved.",
        403,
        "provider-request",
        "unsupported",
      ),
      message: "Creating or copying events with an explicit time model is not supported for this calendar. No changes were saved.",
    },
  ])("keeps a provider-backed form open after $scenario", async ({ error, message }) => {
    const user = userEvent.setup();
    const providerCalendar = {
      ...fixtureCalendars[0]!,
      provider: "google",
    };
    const onCreateEvent = vi
      .fn()
      .mockRejectedValue(error);

    render(
      <Workspace
        {...commonProps}
        calendars={[providerCalendar]}
        events={[]}
        onCreateEvent={onCreateEvent}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Create event, meeting or task" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Event" }));
    await user.type(
      screen.getByRole("textbox", { name: "Event title" }),
      "Provider event",
    );
    await user.click(
      within(screen.getByRole("dialog", { name: "Create event" })).getByRole(
        "button",
        { name: "Create" },
      ),
    );

    expect(screen.getByRole("alert").textContent).toContain(
      message,
    );
    expect(screen.getByRole("alert").textContent).toContain("provider-request");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Event title",
        }) as HTMLInputElement
      ).value,
    ).toBe("Provider event");
  });
});
