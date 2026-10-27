import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarSchema, DEFAULT_CALENDAR_COLOR, PRODUCT_VERSION, SettingsSchema, type AnnouncementsResponse, type PatchSettingsRequest } from "@musubi/types";
import { expect, test, type Page } from "@playwright/test";
import { setTestTheme } from "./theme";

const pageId = "11111111-1111-4111-8111-111111111111";
const initialSettings = SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", dateFormat: "dmy", timeFormat: "24h", onboarded: true, theme: "system" });
const news = { id: "2026-10-27", title: "Across every Musubi server", body: "Project news is shared.\n\nRead https://musubi.pro/news." };

/** Replace HTTP only; the running app owns its reader, queries and settings writes. */
async function fixture(page: Page, response: AnnouncementsResponse) {
  let value = { ...initialSettings };
  let revision = 7;
  let reads = 0;
  const writes: PatchSettingsRequest[] = [];
  const violations: string[] = [];
  const document = () => ({ revision, updatedAt: "2026-10-27T10:00:00Z", value });
  const calendar = CalendarSchema.parse({ id: "personal", creatorID: "news-user", name: "Personal", color: DEFAULT_CALENDAR_COLOR, role: "owner", members: [], isDefault: true });

  await page.addInitScript(() => sessionStorage.setItem("musubi-mobile-web-test-bypass", "true"));
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/v1/users/me/settings" && request.method() === "PATCH") {
      const body = request.postDataJSON() as PatchSettingsRequest;
      writes.push(body);
      value = { ...value, ...body.patch };
      revision += 1;
      return json(document());
    }
    if (path === "/api/stream") return new Promise<void>(() => {});
    if (request.method() !== "GET") {
      violations.push(`Unexpected mutation ${request.method()} ${path}`);
      return json({ error: "Unexpected fixture mutation" }, 500);
    }
    switch (path) {
      case "/api/auth/get-session": return json({
        session: { id: "news-session", userId: "news-user", token: "synthetic", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: "news-user", name: "News QA", email: "news@example.invalid", emailVerified: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", image: null },
      });
      case "/api/v1/server": return json({ version: PRODUCT_VERSION, minClientVersion: "0.2.0", email: true, socials: [], socialsWeb: [], syncProviders: [], pushPublicKey: null });
      case "/api/v1/calendars": return json([calendar]);
      case "/api/v1/tasks": return json({ tasks: [] });
      case "/api/v1/events": return json({ events: [], deletedIds: [], serverTime: "2026-10-27T10:00:00Z" });
      case "/api/v1/users/settings": return json(value);
      case "/api/v1/users/settings/document": return json(document());
      case "/api/v1/pages": return json([{
        id: pageId, name: "My calendar", isDefault: true, position: 0, revision: 1,
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        config: { schemaVersion: 1, calendarVisibility: { hiddenCalendarIds: [], mode: "all" }, filters: [], view: { configVersion: 1, id: "month", showAdjacentDays: true } },
      }]);
      case "/api/v1/announcements": reads += 1; return json(response);
      case "/api/v1/event-deliveries":
      case "/api/v1/task-deliveries": return json({ items: [], nextCursor: null });
      case "/api/v1/federation/connections":
      case "/api/v1/connections": return json([]);
      case "/api/v1/reminders": return json({ calendars: {}, events: {}, default: { allDay: { atMinute: 1080, daysBefore: 1 }, minutesBefore: 10 } });
      default:
        violations.push(`Unexpected read ${path}`);
        return json({ error: "Unexpected fixture read" }, 500);
    }
  });
  return { writes, violations, readCount: () => reads };
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
  test(`news closes with Escape and keeps the calendar context: ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await setTestTheme(page, viewport.name === "desktop" ? "light" : "dark");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const state = await fixture(page, { announcements: [news, { ...news, id: "2026-10-28", title: "Future client", minVersion: "9999.0.0" }], isAdmin: false });
    await page.goto(`/app/p/${pageId}/month?date=2026-10-27`);
    await expect(page).toHaveTitle(/Musubi/);
    const dialog = page.getByRole("dialog", { name: "News and updates" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: news.title, level: 3 })).toBeVisible();
    await expect(dialog.getByText("Future client")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    const link = dialog.getByRole("link", { name: "https://musubi.pro/news" });
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noreferrer noopener");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    expect(state.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const screenshot = join(tmpdir(), `musubi-project-news-${viewport.name}.png`);
    await page.screenshot({ path: screenshot, animations: "disabled" });
    await testInfo.attach("news-reader", { path: screenshot, contentType: "image/png" });

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => state.writes).toEqual([{ baseRevision: 7, patch: { lastSeenProjectNews: news.id, lastSeenAnnouncement: news.id } }]);
    await expect(page).toHaveURL(new RegExp(`/app/p/${pageId}/month\\?date=2026-10-27`));
    const readsBeforeFocus = state.readCount();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(dialog).toHaveCount(0);
    expect(state.readCount()).toBe(readsBeforeFocus);
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(state.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("first project-news read initializes both markers without showing history", async ({ page }) => {
  const state = await fixture(page, { announcements: [], isAdmin: false, markTo: news.id });
  await page.goto(`/app/p/${pageId}/month?date=2026-10-27`);
  await expect.poll(() => state.writes).toEqual([{ baseRevision: 7, patch: { lastSeenProjectNews: news.id, lastSeenAnnouncement: news.id } }]);
  await expect(page.getByRole("dialog", { name: "News and updates" })).toHaveCount(0);
  expect(state.violations).toEqual([]);
});

test("settings and a former admin bookmark have no announcement editor", async ({ page }) => {
  // An older server may still advertise this legacy field. Current UI has no
  // local publishing surface even when that server considers the account admin.
  const state = await fixture(page, { announcements: [], isAdmin: true });
  await page.goto(`/app/p/${pageId}/month?date=2026-10-27`);
  await expect.poll(state.readCount).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("tablist", { name: "Settings sections" }).getByRole("tab"))
    .toHaveText(["General", "Calendars", "Connections", "Account", "About"]);
  await expect(page.locator('a[href="/app/admin"]')).toHaveCount(0);
  await settings.getByRole("button", { name: "Close settings" }).click();
  await page.goto("/app/admin");
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.violations).toEqual([]);
});
