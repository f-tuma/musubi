import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CalendarSchema, DEFAULT_CALENDAR_COLOR, PRODUCT_VERSION, SettingsSchema, TaskSchema } from "@musubi/types";
import { EventsResponseSchema } from "../src/api/contracts";
import { TaskInspectorSuiteSchema, exchangeReply, taskForScenario, type InspectorScenario, type InspectorStep } from "../src/tests/behavior/task-inspector";
import { setTestTheme } from "./theme";

const suite = TaskInspectorSuiteSchema.parse(JSON.parse(readFileSync(new URL("../src/tests/behavior/task-inspector.json", import.meta.url), "utf8")));
const pageId = "11111111-1111-4111-8111-111111111111";
const settings = SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", dateFormat: "dmy", timeFormat: "24h", onboarded: true, theme: "system" });
const calendar = CalendarSchema.parse({ id: "personal", creatorID: "behavior-user", name: "Personal", color: DEFAULT_CALENDAR_COLOR, role: "owner", members: [], isDefault: true });
const events = EventsResponseSchema.parse({ events: [], deletedIds: [], serverTime: "2026-10-24T10:00:00Z" });

/** Run the actual web app; replace HTTP boundaries only, never its components. */
async function fixture(page: Page, scenario: InspectorScenario) {
  let task = taskForScenario(suite, scenario);
  const requests: { method: string; body: unknown }[] = [];
  const violations: string[] = [];
  const expectedHttpErrors = new Map<string, number>();
  await page.addInitScript(() => sessionStorage.setItem("musubi-mobile-web-test-bypass", "true"));
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === `/api/v1/task-mutations/${task.id}`) {
      const body: unknown = request.postDataJSON();
      const exchange = scenario.exchanges[requests.length];
      requests.push({ method, body });
      if (!exchange || method !== exchange.method) {
        violations.push(`Unexpected mutation ${method} ${path}`);
        return json({ error: "Unexpected fixture mutation" }, 500);
      }
      const reply = exchangeReply(task, exchange);
      if (exchange.response.kind === "rejected") expectedHttpErrors.set(request.url(), reply.status);
      if (exchange.response.kind === "saved" && "task" in reply.body) task = TaskSchema.parse(reply.body.task);
      return json(reply.body, reply.status);
    }
    if (path === "/api/stream") return new Promise<void>(() => {});
    if (method !== "GET") {
      violations.push(`Unexpected mutation ${method} ${path}`);
      return json({ error: "Unexpected fixture mutation" }, 500);
    }
    switch (path) {
      case "/api/auth/get-session": return json({
        session: { id: "behavior-session", userId: "behavior-user", token: "synthetic", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" },
        user: { id: "behavior-user", name: "Behavior QA", email: "behavior@example.invalid", emailVerified: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", image: null },
      });
      case "/api/v1/server": return json({ version: PRODUCT_VERSION, minClientVersion: "0.2.0", email: true, socials: [], socialsWeb: [], syncProviders: [], pushPublicKey: null });
      case "/api/v1/calendars": return json([calendar]);
      case "/api/v1/tasks": return json({ tasks: [task] });
      case "/api/v1/events": return json(events);
      case "/api/v1/users/settings": return json(settings);
      case "/api/v1/users/settings/document": return json({ revision: 1, updatedAt: "2026-01-01T00:00:00Z", value: settings });
      case "/api/v1/pages": return json([{
        id: pageId, name: "My calendar", isDefault: true, position: 0, revision: 1,
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        config: { schemaVersion: 1, calendarVisibility: { hiddenCalendarIds: [], mode: "all" }, filters: [], view: { configVersion: 1, id: "month", showAdjacentDays: true } },
      }]);
      case "/api/v1/announcements": return json({ announcements: [], isAdmin: false });
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
  return { requests, violations, expectedHttpErrors, initialTitle: task.title };
}

async function runStep(page: Page, step: InspectorStep) {
  if (step.action === "fill") await page.getByRole("textbox", { name: step.name, exact: true }).fill(step.value);
  else if (step.action === "expect-value") await expect(page.getByRole("textbox", { name: step.name, exact: true })).toHaveValue(step.value);
  else {
    const target = page.getByRole(step.role, { name: step.name, exact: true });
    if (step.action === "click") await target.click();
    else if (step.state === "absent") await expect(target).toHaveCount(0);
    else if (step.state === "visible") await expect(target).toBeVisible();
    else if (step.state === "disabled") await expect(target).toBeDisabled();
    else await expect(target).toBeEnabled();
  }
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "narrow", width: 390, height: 844 }]) {
  for (const scenario of suite.scenarios) {
    test(`JSON behavior ${scenario.id}: ${viewport.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await setTestTheme(page, viewport.name === "desktop" ? "light" : "dark");
      const errors: string[] = [];
      const consoleErrors: { text: string; url: string }[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url }); });
      const state = await fixture(page, scenario);
      await page.goto(`/app/p/${pageId}/tasks?date=2026-10-24`);
      await expect(page).toHaveURL(new RegExp(`/app/p/${pageId}/tasks`));
      const tasks = page.getByRole("region", { name: "Tasks", exact: true });
      await expect(tasks).toBeVisible();
      const row = tasks.getByRole("button").filter({ hasText: state.initialTitle }).first();
      await expect(row).toBeVisible();
      await row.click();
      for (const [index, step] of scenario.steps.entries())
        await test.step(`${index + 1}: ${step.action}`, () => runStep(page, step));
      expect(state.violations).toEqual([]);
      expect(state.requests).toHaveLength(scenario.exchanges.length);
      for (const [index, exchange] of scenario.exchanges.entries())
        expect(state.requests[index]).toMatchObject({ method: exchange.method, body: exchange.body });
      expect(errors).toEqual([]);
      expect(consoleErrors.filter(error => {
        const status = state.expectedHttpErrors.get(error.url);
        return !status || error.text !== `Failed to load resource: the server responded with a status of ${status} (Conflict)`;
      })).toEqual([]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", viewport.name === "desktop" ? "light" : "dark");
      expect(await page.locator("vite-error-overlay").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const screenshot = join(tmpdir(), `musubi-behavior-${scenario.id}-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      await testInfo.attach("running-app", { path: screenshot, contentType: "image/png" });
    });
  }
}
