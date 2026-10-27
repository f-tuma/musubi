import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Exercise initial SSR assets, the native worker and production route chunks.
// API fixtures cover UI reads; real DB/auth is verified separately at release.
// Never fall back to a dev server if the container dies.
export default defineConfig({
  ...base,
  grep: /redirects an anonymous Month request to sign in$|opens a calendar for a bare \/app request$|reads, filters and signs out of the authenticated Month$|production asset links resolve from the initial SSR HTML before hydration$|notification worker has uncached origin responses and native browser registration$/,
  retries: 0,
  testDir: ".",
  testMatch: [
    "**/e2e/month-read.spec.ts",
    "**/e2e/worker-cache.spec.ts",
    "**/production-e2e/assets.spec.ts",
  ],
  use: {
    ...base.use,
    baseURL: process.env.PLAYWRIGHT_ORIGIN ?? "http://127.0.0.1:4330",
  },
  webServer: undefined,
  workers: 1,
});
