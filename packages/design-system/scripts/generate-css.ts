import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  renderFoundationTokensCss,
  renderThemeTokensCss,
} from "../src/css";
import { penpotTokens } from "../src/penpot-tokens";
import { renderTailwindThemeCss } from "../src/tailwind";
import { renderAndroidWidgetTokensXml } from "../src/android-widget";

const outputs = [
  ["../src/colors.css", renderThemeTokensCss()],
  ["../src/foundations.css", renderFoundationTokensCss()],
  // Tailwind v4 theme over the same values, for the web client.
  ["../src/tailwind.css", renderTailwindThemeCss()],
  // The same values in the shape a design tool imports. Generated beside the CSS
  // so the two can never describe different tokens.
  [
    "../design-tokens.json",
    `${JSON.stringify(penpotTokens(), null, 2)}\n`,
  ],
  [
    "../../../apps/client/modules/musubi-agenda-widget/android/src/main/res/values/musubi_widget_tokens.xml",
    renderAndroidWidgetTokensXml("light"),
  ],
  [
    "../../../apps/client/modules/musubi-agenda-widget/android/src/main/res/values-night/musubi_widget_tokens.xml",
    renderAndroidWidgetTokensXml("dark"),
  ],
] as const;

for (const [relativePath, content] of outputs) {
  const outputPath = fileURLToPath(new URL(relativePath, import.meta.url));
  writeFileSync(outputPath, content);
  console.log(`Generated ${outputPath}`);
}
