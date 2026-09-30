import type { Page } from "@playwright/test";
import { THEME_STORAGE_KEY, type AppliedTheme } from "../src/design/theme";

/** The account fixture uses System, so pin both the bootstrap and OS scheme. */
export async function setTestTheme(page: Page, theme: AppliedTheme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: THEME_STORAGE_KEY, value: theme },
  );
}
