import { SettingsSchema, type AnnouncementsResponse } from "@musubi/types";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAnnouncements, getSettingsDocument, patchSettings } from "~/api/resources";
import { AnnouncementBody, AnnouncementGate } from "./AnnouncementDialog";

vi.mock("~/auth/use-session-user", () => ({ useSessionUser: () => ({ user: { id: "news-reader" } }) }));
vi.mock("~/api/resources", () => ({
  getAnnouncements: vi.fn(),
  getSettingsDocument: vi.fn(),
  patchSettings: vi.fn(),
}));

const DOCUMENT = {
  revision: 7,
  updatedAt: new Date("2026-10-27T10:00:00Z"),
  value: SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", timeFormat: "24h", dateFormat: "dmy" }),
};
const NEWS = { id: "2026-10-27", title: "Across all Musubi servers", body: "Project news is shared.\n\nRead https://musubi.pro/news." };
const clients: QueryClient[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSettingsDocument).mockResolvedValue(DOCUMENT);
  vi.mocked(patchSettings).mockResolvedValue({ ...DOCUMENT, revision: 8 });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  focusManager.setFocused(undefined);
});

function renderGate(response: AnnouncementsResponse) {
  vi.mocked(getAnnouncements).mockResolvedValue(response);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><AnnouncementGate /></QueryClientProvider>);
}

describe("AnnouncementBody", () => {
  it("renders paragraphs as separate blocks", () => {
    render(<AnnouncementBody body={"first line\n\nsecond line"} />);
    expect(document.body.contains(screen.getByText("first line"))).toBe(true);
    expect(document.body.contains(screen.getByText("second line"))).toBe(
      true,
    );
  });

  it("turns an http url into a link that opens safely", () => {
    render(<AnnouncementBody body="join us at https://discord.gg/example now" />);
    const link = screen.getByRole("link", { name: "https://discord.gg/example" });
    expect(link.getAttribute("href")).toBe("https://discord.gg/example");
    expect(link.getAttribute("target")).toBe("_blank");
    // Public project links must not receive Musubi's window.opener.
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("leaves a javascript url as plain text", () => {
    render(<AnnouncementBody body="javascript:alert(1)" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      document.body.contains(screen.getByText("javascript:alert(1)")),
    ).toBe(true);
  });
});

describe("project news reader", () => {
  for (const dismissal of ["Escape", "Close"] as const) {
    it(`names the news surface and marks only displayed news on ${dismissal}`, async () => {
      const user = userEvent.setup();
      renderGate({ announcements: [NEWS, { ...NEWS, id: "2026-10-28", title: "Future client", minVersion: "9999.0.0" }], isAdmin: false });
      const dialog = await screen.findByRole("dialog", { name: "News and updates" });
      expect(within(dialog).getByRole("heading", { name: NEWS.title, level: 3 })).toBeTruthy();
      expect(within(dialog).queryByText("Future client")).toBeNull();
      expect(patchSettings).not.toHaveBeenCalled();

      if (dismissal === "Escape") await user.keyboard("{Escape}");
      else await user.click(within(dialog).getByRole("button", { name: "Close" }));

      await waitFor(() => expect(patchSettings).toHaveBeenCalledExactlyOnceWith({
        baseRevision: 7,
        patch: { lastSeenProjectNews: NEWS.id, lastSeenAnnouncement: NEWS.id },
      }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
      expect(getAnnouncements).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }

  it("initializes both read markers without opening the history", async () => {
    renderGate({ announcements: [NEWS], isAdmin: false, markTo: NEWS.id });
    await waitFor(() => expect(patchSettings).toHaveBeenCalledExactlyOnceWith({
      baseRevision: 7,
      patch: { lastSeenProjectNews: NEWS.id, lastSeenAnnouncement: NEWS.id },
    }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not advance read state for an empty feed", async () => {
    renderGate({ announcements: [], isAdmin: false });
    await waitFor(() => expect(getAnnouncements).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it("keeps the reader dismissed when saving the marker fails", async () => {
    const user = userEvent.setup();
    vi.mocked(patchSettings).mockRejectedValue(new Error("Offline"));
    renderGate({ announcements: [NEWS], isAdmin: false });
    await screen.findByRole("dialog", { name: "News and updates" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(patchSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
