import path from "node:path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// One timezone for every run, whatever the machine is set to. Calendar code is
// full of local-time arithmetic, so a suite that passes in Prague and fails in a
// UTC CI container (or the reverse) is not a suite. Prague rather than UTC on
// purpose: it observes daylight saving, so the tests exercise offsets that
// change instead of one that never does.
const TIMEZONE = "Europe/Prague";

export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          env: { TZ: TIMEZONE },
          environment: "jsdom",
          globals: true,
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/tests/setup.ts"],
        },
      },
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.join(dirname, ".storybook"),
            storybookScript: "pnpm storybook --no-open",
          }),
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
