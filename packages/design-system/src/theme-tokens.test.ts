import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderFoundationTokensCss, renderThemeTokensCss } from "./css";
import { paletteFailures } from "./palette-rules";
import {
  controlHeights,
  motionDurations,
  spacing,
  typeSizes,
} from "./foundation-tokens";
import { renderTailwindThemeCss } from "./tailwind";
import { themeTokens } from "./theme-tokens";

const generatedCssPath = fileURLToPath(
  new URL("./colors.css", import.meta.url),
);
const generatedFoundationsCssPath = fileURLToPath(
  new URL("./foundations.css", import.meta.url),
);

assert.equal(
  readFileSync(generatedCssPath, "utf8"),
  renderThemeTokensCss(),
  "The committed web representation must match the canonical theme tokens",
);

assert.equal(
  readFileSync(generatedFoundationsCssPath, "utf8"),
  renderFoundationTokensCss(),
  "The committed web representation must match the canonical foundation tokens",
);

assert.equal(
  readFileSync(fileURLToPath(new URL("./tailwind.css", import.meta.url)), "utf8"),
  renderTailwindThemeCss(),
  "The committed Tailwind theme must match the canonical tokens",
);

assert.deepEqual(
  Object.keys(themeTokens.light),
  Object.keys(themeTokens.dark),
  "Light and dark themes must expose the same semantic roles",
);

assert.equal(typeSizes[13], 13, "Type sizes stay renderer-independent");
assert.equal(spacing[4], 16, "Spacing steps stay renderer-independent");
assert.equal(
  controlHeights.touch.control,
  48,
  "Touch controls keep their minimum target",
);
assert.ok(
  motionDurations.native.standard >= motionDurations.web.standard,
  "Native standard motion must remain at least as legible as web motion",
);

// Every token that carries words must be legible on every surface it can land
// on, and `textFaint` must stay under the bar so it cannot become a second text
// colour. The rules live in `palette-rules.ts` because a palette edited in a
// design tool has to clear the same ones before it comes back in.
for (const scheme of ["light", "dark"] as const) {
  assert.deepEqual(
    paletteFailures(scheme, themeTokens[scheme]),
    [],
    `${scheme} palette fails its own contrast rules`,
  );
}

console.log("design-system theme token self-check: OK");
