import { expect, test } from "@playwright/test";
import { THEME_STORAGE_KEY } from "../src/design/theme";

for (const { stored, system, applied } of [
  { stored: "dark", system: "light", applied: "dark" },
  { stored: "light", system: "dark", applied: "light" },
  { stored: "system", system: "dark", applied: "dark" },
  { stored: "sepia", system: "dark", applied: "dark" },
  { stored: null, system: "light", applied: "light" },
] as const) {
  test(`theme bootstrap: ${stored ?? "unset"} preference with ${system} system`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: system });
    await page.addInitScript(({ key, value }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }, { key: THEME_STORAGE_KEY, value: stored });
    await page.route("**/api/auth/get-session", route => route.fulfill({ json: null }));
    await page.route("**/api/v1/server", route => route.fulfill({ json: { socialsWeb: [], email: true } }));
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", applied);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", applied === "dark" ? "#0c0c0e" : "#f4f1e8");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-canvas").trim())).toBe(applied === "dark" ? "#0c0c0e" : "#f4f1e8");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", applied);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}
