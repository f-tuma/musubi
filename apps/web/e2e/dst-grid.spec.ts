import { setTestTheme } from "./theme";
import { expect, test, type Page, type Route } from "@playwright/test";

const runtimeErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(runtimeErrors.get(page) ?? []).toEqual([]);
});

// Stateful API fixture follows month-read.spec.ts. All writes stay in this browser.
const pageID = "11111111-1111-4111-8111-111111111111";
const calendarID = "00000000-0000-4000-8000-000000000601";
const stamp = "2026-09-10T12:00:00.000Z";
function respond(route: Route, body: unknown, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
}
function event(id: string, start: string, end: string) {
  return { id, title: id, start, end, revision: 1, calendars: [calendarID], originCalendarID: calendarID, creatorID: "dst-user", color: "#b3492f", isAllDay: false, isCanceled: false, hasAttendees: false, organizer: "dst@example.invalid", recurrence: null };
}
async function fixture(page: Page, initial = [] as ReturnType<typeof event>[], weekStartsOn = "monday") {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem("musubi-mobile-web-test-bypass", "true"));
  const writes: { method: string; body: any }[] = [];
  let events = [...initial];
  const settings = { dateFormat: "dmy", defaultCalendarView: "week", notificationsOnByDefault: false, onboarded: true, theme: "system", timeFormat: "24h", weekStartsOn };
  await page.route(/^https?:\/\/[^/]+\/api\//, route => respond(route, []));
  await page.route("**/api/auth/get-session", route => respond(route, { session: { id: "dst-session", userId: "dst-user", createdAt: stamp, updatedAt: stamp, expiresAt: "2027-01-01T00:00:00Z", token: "fixture" }, user: { id: "dst-user", name: "DST QA", email: "dst@example.invalid", emailVerified: true, createdAt: stamp, updatedAt: stamp, image: null } }));
  await page.route("**/api/v1/calendars", route => respond(route, [{ id: calendarID, name: "Personal", color: "#b3492f", creatorID: "dst-user", members: [], role: "owner", isDefault: true }]));
  await page.route("**/api/v1/pages", route => respond(route, [{ id: pageID, name: "My calendar", position: 0, revision: 1, isDefault: true, createdAt: stamp, updatedAt: stamp, config: { schemaVersion: 1, calendarVisibility: { hiddenCalendarIds: [], mode: "all" }, filters: [], view: { configVersion: 1, id: "week" } } }]));
  await page.route("**/api/v1/users/settings", route => respond(route, settings));
  await page.route("**/api/v1/users/settings/document", route => respond(route, { revision: 1, updatedAt: stamp, value: settings }));
  await page.route("**/api/v1/tasks", route => respond(route, { tasks: [] }));
  await page.route("**/api/v1/event-deliveries", route => respond(route, { items: [], nextCursor: null }));
  await page.route("**/api/v1/announcements", route => respond(route, { announcements: [], isAdmin: false }));
  await page.route("**/api/v1/server", route => respond(route, { email: true, pushPublicKey: null, socials: [], socialsWeb: [], syncProviders: [] }));
  await page.route("**/api/v1/reminders", route => respond(route, { calendars: {}, default: { allDay: null, minutesBefore: null }, events: {} }));
  await page.route("**/api/stream?*", () => new Promise<void>(() => {}));
  await page.route(/\/api\/v1\/events(?:\?.*)?$/, route => {
    const method = route.request().method();
    if (method === "GET") return respond(route, { events, deletedIds: [], serverTime: stamp });
    const body = route.request().postDataJSON(); writes.push({ method, body });
    const saved = method === "PATCH" ? { ...events.find(item => item.id === body.id)!, ...body.patch, revision: 2 } : { ...body, revision: 1 };
    events = [...events.filter(item => item.id !== saved.id), saved];
    return respond(route, saved, method === "POST" ? 201 : 200);
  });
  return writes;
}
async function slotPoint(page: Page, date: string, minute: number, dayMinutes = 1500) {
  const column = page.locator(`[data-time-grid-column="${date}"]`);
  await expect(column).toBeVisible();
  await column.evaluate((node, fraction) => {
    let parent = node.parentElement;
    while (parent && parent.scrollHeight <= parent.clientHeight + 1) parent = parent.parentElement;
    if (parent) parent.scrollTop = (node as HTMLElement).offsetHeight * fraction - 220;
  }, minute / dayMinutes);
  const box = (await column.boundingBox())!;
  return { x: box.x + box.width * .65, y: box.y + box.height * minute / dayMinutes };
}
for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  for (const fold of [0, 1]) test(`DST create fold ${fold} ${theme} ${width} quick/full preserves UTC`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const writes = await fixture(page);
    await page.goto(`/app/p/${pageID}/day?date=2026-10-25`);
    const point = await slotPoint(page, "2026-10-25", 150 + fold * 60);
    await page.mouse.click(point.x, point.y);
    await page.getByRole("textbox", { name: "Event title" }).fill(`Fold ${fold}`);
    if (fold === 1) {
      await page.getByRole("button", { name: "Expand event editor", exact: true }).press("Enter");
      await expect(page).toHaveURL(new RegExp(`/day\\?date=2026-10-25$`));
      await expect(page.getByRole("dialog", { name: "Create event", exact: true })).toHaveAttribute("data-presentation", "expanded");
      await page.getByRole("button", { name: "Collapse event editor", exact: true }).press("Enter");
      await page.getByRole("button", { name: "Expand event editor", exact: true }).press("Enter");
    }
    await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(`Fold ${fold}`);
    await page.screenshot({ path: info.outputPath("fold-draft.png") });
    await page.getByRole("button", { name: "Create", exact: true }).press("Enter");
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ method: "POST", body: { start: `2026-10-25T0${fold}:30:00.000Z`, end: `2026-10-25T0${fold + 1}:30:00.000Z` } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

test("DST keyboard move then resize preserves second occurrence UTC", async ({ page }) => {
  const writes = await fixture(page, [event("Fold event", "2026-10-25T00:30:00.000Z", "2026-10-25T00:45:00.000Z")]);
  await page.goto(`/app/p/${pageID}/day?date=2026-10-25`);
  const item = page.locator('[data-time-event="Fold event"]');
  await item.focus();
  for (let index = 0; index < 4; index++) { await item.press("Alt+ArrowDown"); await expect.poll(() => writes.length).toBe(index + 1); await expect(item).not.toHaveAttribute("data-pending", ""); await expect.poll(() => item.getAttribute("aria-label")).toContain(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Prague" }).format(new Date(Date.parse("2026-10-25T00:30:00Z") + (index + 1) * 900000))); }
  expect(writes[3]).toMatchObject({ method: "PATCH", body: { patch: { start: "2026-10-25T01:30:00.000Z", end: "2026-10-25T01:45:00.000Z" } } });
  await item.press("Alt+Shift+ArrowDown");
  await expect.poll(() => writes.length).toBe(5);
  expect(writes[4]).toMatchObject({ body: { patch: { end: "2026-10-25T02:00:00.000Z" } } });
});

test("DST spring hole rejects pointer creation and retains an existing draft after invalid drop", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const writes = await fixture(page, [], "sunday");
  await page.goto(`/app/p/${pageID}/week?date=2026-03-29`);
  const hole = page.locator('[data-time-grid-column="2026-03-29"] [data-time-axis-hole]');
  await expect(hole).toHaveCount(1);
  const invalid = await slotPoint(page, "2026-03-29", 150, 1440);
  await page.mouse.click(invalid.x, invalid.y);
  await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
  const valid = await slotPoint(page, "2026-03-29", 90, 1440);
  await page.mouse.click(valid.x, valid.y);
  await page.getByRole("textbox", { name: "Event title" }).fill("Keep spring draft");
  const draft = page.locator('[data-time-grid-column="2026-03-29"] [data-draft]').first();
  // Hit-test the exposed part of the draft beside the overlay panel.
  await draft.scrollIntoViewIfNeeded();
  const box = (await draft.boundingBox())!;
  expect(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.closest("[data-draft]")?.outerHTML, {x:box.x+20,y:box.y+14})).toContain("data-draft");
  await page.mouse.move(box.x + 20, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 30, { steps: 4 });
  await expect(draft).toHaveAttribute("data-dragging", "");
  await page.mouse.move(box.x + 20, box.y + 80, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("Keep spring draft");
  await page.screenshot({ path: info.outputPath("spring-invalid-draft.png") });
  // A distinct Create click must work immediately after the invalid drop.
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ body: { start: "2026-03-29T00:30:00.000Z", end: "2026-03-29T01:30:00.000Z" } });
});

test("DST scrolled day end creates exact midnight end and paints crossing-midnight pieces", async ({ page }) => {
  const writes = await fixture(page, [event("Across midnight", "2026-10-24T21:30:00.000Z", "2026-10-25T00:30:00.000Z")]);
  await page.goto(`/app/p/${pageID}/week?date=2026-10-25`);
  await expect(page.locator('[data-time-event="Across midnight"]')).toHaveCount(2);
  const point = await slotPoint(page, "2026-10-25", 1485);
  await page.mouse.click(point.x, point.y);
  await page.getByRole("textbox", { name: "Event title" }).fill("Day boundary");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ body: { start: "2026-10-25T22:45:00.000Z", end: "2026-10-25T23:00:00.000Z" } });
});

for (const fold of [0, 1]) test(`DST pointer move and resize in fold ${fold} writes exact UTC`, async ({ page }) => {
  const writes = await fixture(page, [event("Pointer fold", `2026-10-25T0${fold}:00:00.000Z`, `2026-10-25T0${fold}:15:00.000Z`)]);
  await page.goto(`/app/p/${pageID}/day?date=2026-10-25`);
  await slotPoint(page, "2026-10-25", 120 + fold * 60);
  const column = page.locator('[data-time-grid-column="2026-10-25"]');
  const scale = (await column.boundingBox())!.height / 1500;
  const item = page.locator('[data-time-event="Pointer fold"]');
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 15 * scale, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ method: "PATCH", body: { patch: { start: `2026-10-25T0${fold}:15:00.000Z`, end: `2026-10-25T0${fold}:30:00.000Z` } } });
  const resized = (await item.boundingBox())!;
  await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height - 2);
  await page.mouse.down();
  await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height - 2 + 15 * scale, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ method: "PATCH", body: { patch: { end: `2026-10-25T0${fold}:45:00.000Z` } } });
});

test("DST spring one-minute event never paints across the missing-hour band", async ({ page }) => {
  await fixture(page, [event("Last real minute", "2026-03-29T00:59:00.000Z", "2026-03-29T01:00:00.000Z")]);
  await page.goto(`/app/p/${pageID}/week?date=2026-03-29`);
  await slotPoint(page, "2026-03-29", 119, 1440);
  const column = page.locator('[data-time-grid-column="2026-03-29"]');
  const gap = (await column.locator('[data-time-axis-hole]').boundingBox())!;
  const painted = await column.locator('[data-time-event="Last real minute"] > span').first().boundingBox();
  expect(painted).not.toBeNull();
  expect(painted!.y + painted!.height).toBeLessThanOrEqual(gap.y + 1);
});

test.describe("Lord Howe half-hour transition", () => {
  test.use({ timezoneId: "Australia/Lord_Howe" });
  for (const fold of [0, 1]) test(`creates repeated 01:45 fold ${fold} with exact UTC`, async ({ page }) => {
    const writes = await fixture(page);
    await page.goto(`/app/p/${pageID}/day?date=2026-04-05`);
    const point = await slotPoint(page, "2026-04-05", 105 + fold * 30, 1470);
    await page.mouse.click(point.x, point.y);
    await page.getByRole("textbox", { name: "Event title" }).fill("Half-hour fold");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ body: { start: fold ? "2026-04-04T15:15:00.000Z" : "2026-04-04T14:45:00.000Z", end: fold ? "2026-04-04T16:15:00.000Z" : "2026-04-04T15:45:00.000Z" } });
  });
  test("refuses missing 02:15 on spring week", async ({ page }) => {
    const writes = await fixture(page);
    await page.goto(`/app/p/${pageID}/week?date=2026-10-04`);
    const point = await slotPoint(page, "2026-10-04", 135, 1440);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });
});

test("DST cross-midnight draft move keeps next-day 00:45 endpoint when saved", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const writes = await fixture(page);
  await page.goto(`/app/p/${pageID}/day?date=2026-10-25`);
  const point = await slotPoint(page, "2026-10-25", 1440);
  await page.mouse.click(point.x, point.y);
  await page.getByRole("textbox", { name: "Event title" }).fill("Cross-midnight draft");
  const start = page.getByRole("combobox", { name: "Start time" });
  await expect(start).toHaveValue("23:00");
  await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText("Monday, October 26, 2026");
  const end = page.getByRole("combobox", { name: "End time" });
  await end.fill("01:00");
  await end.press("Tab");
  await expect(end).toHaveValue("01:00");
  await expect(start).toHaveValue("23:00");
  const column = page.locator('[data-time-grid-column="2026-10-25"]');
  const scale = (await column.boundingBox())!.height / 1500;
  const draft = column.locator("[data-draft]").first();
  // Docking makes the viewport shorter. Reveal the whole draft before this
  // fixed-distance gesture, so edge auto-scroll cannot add its own time delta.
  await draft.scrollIntoViewIfNeeded();
  const box = (await draft.boundingBox())!;
  const grab = { x: box.x + 20, y: box.y + 20 };
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[data-draft]")), grab)).toBe(true);
  const calendar = page.locator("[data-calendar-area]");
  const scrollTop = await calendar.evaluate(element => element.scrollTop);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  expect(await calendar.evaluate(element => element.scrollTop)).toBe(scrollTop);
  await page.mouse.move(grab.x, grab.y - 15 * scale, { steps: 8 });
  await expect(draft).toHaveAttribute("data-dragging", "");
  await page.mouse.up();
  expect(await calendar.evaluate(element => element.scrollTop)).toBe(scrollTop);
  await expect(page.getByRole("combobox", { name: "Start time" })).toHaveValue("22:45");
  await expect(end).toHaveValue("00:45");
  await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText("Monday, October 26, 2026");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ method: "POST", body: { start: "2026-10-25T21:45:00.000Z", end: "2026-10-25T23:45:00.000Z" } });
});
