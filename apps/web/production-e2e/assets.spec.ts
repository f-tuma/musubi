import { expect, test } from "@playwright/test";

test("production asset links resolve from the initial SSR HTML before hydration", async ({ page, request }, testInfo) => {
  const initial = await request.get("/login");
  expect(initial.status()).toBe(200);
  expect(initial.headers()["content-type"]).toMatch(/^text\/html\b/);

  // Parse the raw response in an inert document while the browser is still on
  // about:blank. App JavaScript cannot replace an invalid SSR stylesheet href.
  expect(page.url()).toBe("about:blank");
  const hrefs = await page.evaluate(html => {
    const document = new DOMParser().parseFromString(html, "text/html");
    return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'), link => link.getAttribute("href"));
  }, await initial.text());
  expect(hrefs.length).toBeGreaterThan(0);
  const origin = new URL(initial.url()).origin;
  const stylesheets: { href: string; contentType: string | undefined; status: number }[] = [];
  for (const href of hrefs) {
    expect(href).toBeTruthy();
    const url = new URL(href!, initial.url());
    expect(url.origin).toBe(origin);
    expect(url.pathname).toMatch(/^\/assets\/.+\.css$/);
    const response = await request.get(url.href);
    const asset = { href: url.href, contentType: response.headers()["content-type"], status: response.status() };
    stylesheets.push(asset);
    expect(asset.status, asset.href).toBe(200);
    expect(asset.contentType, asset.href).toMatch(/^text\/css\b/);
    expect((await response.text()).trim().length, asset.href).toBeGreaterThan(0);
  }
  await testInfo.attach("initial-ssr-stylesheets", { body: JSON.stringify(stylesheets, null, 2), contentType: "application/json" });

  // Only the login's API dependencies are replaced. All HTML, CSS, fonts and
  // executable chunks continue to come from the running production server.
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
  await page.route("**/api/v1/server", route => route.fulfill({ json: { socialsWeb: [], email: false } }));
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle(/Musubi/);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "Create one", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await testInfo.attach("production-sign-up", { body: await page.screenshot({ animations: "disabled" }), contentType: "image/png" });
  expect(errors).toEqual([]);
});
