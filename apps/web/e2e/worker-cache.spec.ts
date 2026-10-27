import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("notification worker has uncached origin responses and native browser registration", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
  await page.route("**/api/v1/server", route => route.fulfill({ json: { socialsWeb: [], email: true } }));

  // No worker script interception: both responses come from the running app.
  for (const suffix of ["", "?fresh=1"]) {
    const reply = await request.get(`/app/sw.js${suffix}`);
    expect(reply.status()).toBe(200);
    const headers = reply.headers();
    expect(headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
    expect(headers["cdn-cache-control"]).toBe("no-store");
    expect(headers["cloudflare-cdn-cache-control"]).toBe("no-store");
    expect(headers["content-type"]).toMatch(/^text\/javascript\b/);
    expect(headers["service-worker-allowed"]).toBe("/");
    expect(await reply.text()).toContain('self.addEventListener("push"');
  }
  const head = await request.head("/app/sw.js");
  expect(head.status()).toBe(200);
  expect(head.headers()["cache-control"]).toBe("no-store, no-cache, must-revalidate");
  expect(await head.body()).toHaveLength(0);

  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle(/Musubi/);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  // Fast JSON scenarios assert production subscribeToPush passes these options.
  // Here the actual browser separately proves the served script can activate.
  const registration = await page.evaluate(async () => {
    const worker = await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/", updateViaCache: "none" });
    return { scope: new URL(worker.scope).pathname, updateViaCache: worker.updateViaCache };
  });
  expect(registration).toEqual({ scope: "/app/", updateViaCache: "none" });
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/app/"))?.active?.state)).toBe("activated");
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration("/app/"))?.update(); });

  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const screenshot = join(tmpdir(), "musubi-worker-origin.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("worker-origin-login", { path: screenshot, contentType: "image/png" });
  expect(errors).toEqual([]);
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration("/app/"))?.unregister(); });
});
