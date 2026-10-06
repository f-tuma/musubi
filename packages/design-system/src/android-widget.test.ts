import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderAndroidWidgetTokensXml, toAndroidColor } from "./android-widget";
import { contrastRatio } from "./contrast";
import { controlHeights, typeSizes } from "./foundation-tokens";
import { themeTokens } from "./theme-tokens";
import { widgetThemeTokens, widgetTokens } from "./widget-tokens";

// Alpha changes byte position on Android, and must round rather than truncate.
assert.equal(toAndroidColor("#fff"), "#ffffff");
assert.equal(toAndroidColor("rgba(28, 27, 24, 0.08)"), "#141c1b18");
assert.equal(toAndroidColor("rgba(28, 27, 24, 0.64)"), "#a31c1b18");
assert.equal(toAndroidColor("rgba(200, 85, 61, 0.25)"), "#40c8553d");

function fromAndroidColor(value: string): string {
  if (value.length === 7) return value;
  const alpha = Number.parseInt(value.slice(1, 3), 16) / 255;
  const channels = [3, 5, 7].map(index => Number.parseInt(value.slice(index, index + 2), 16));
  return `rgba(${channels.join(", ")}, ${alpha})`;
}

for (const scheme of ["light", "dark"] as const) {
  const palette = widgetThemeTokens[scheme];
  assert.equal(palette.surface, themeTokens[scheme].surfacePanel);
  assert.equal(palette.foregroundMuted, themeTokens[scheme].textMuted);
  assert.equal(palette.onAccent, themeTokens[scheme].accentOnPrimary);

  // Verify the colours the native renderer receives, including 8-bit alpha
  // rounding, rather than proving only the original CSS palette's contrast.
  for (const ink of [palette.foreground, palette.foregroundSecondary, palette.foregroundMuted]) {
    const exportedInk = fromAndroidColor(toAndroidColor(ink));
    for (const surface of [palette.surface, palette.surfaceRaised]) {
      assert.ok(contrastRatio(exportedInk, surface) >= 4.5,
        `${scheme} widget words must retain AA contrast after Android conversion`);
    }
  }
  assert.ok(contrastRatio(palette.onAccent, palette.accent) >= 4.5);
  for (const surface of [palette.surface, palette.surfaceRaised]) {
    assert.ok(contrastRatio(palette.accentText, surface) >= 4.5, `${scheme} small accent words must remain readable`);
  }
  assert.ok(contrastRatio(palette.onControl, palette.controlFill) >= 4.5);

  // User pigments can be any colour. Both candidates must remain available in
  // both themes; accidentally using dark onAccent as the light one fails this.
  for (const red of [0, 51, 102, 153, 204, 255]) {
    for (const green of [0, 51, 102, 153, 204, 255]) {
      for (const blue of [0, 51, 102, 153, 204, 255]) {
        const pigment = `rgb(${red}, ${green}, ${blue})`;
        assert.ok(Math.max(contrastRatio(palette.pillInk, pigment),
          contrastRatio(palette.pillInkLight, pigment)) >= 4.5,
        `${scheme} widget must have readable ink for ${pigment}`);
      }
    }
  }

  const xml = renderAndroidWidgetTokensXml(scheme);
  assert.ok([...xml.matchAll(/<!--([\s\S]*?)-->/g)].every(match => !match[1]!.includes("--")),
    "XML comments must not embed command flags containing a double hyphen");
  const names = [...xml.matchAll(/name="([^"]+)"/g)].map(match => match[1]!);
  assert.equal(new Set(names).size, names.length, "Android resources must have unique names");
  assert.ok(names.every(name => /^[a-z][a-z0-9_]*$/.test(name)));
  const directory = scheme === "light" ? "values" : "values-night";
  assert.equal(readFileSync(new URL(
    `../../../apps/client/modules/musubi-agenda-widget/android/src/main/res/${directory}/musubi_widget_tokens.xml`,
    import.meta.url,
  ), "utf8"), xml, "Android widget resources are stale — run design-system generate");
}

assert.equal(widgetTokens.layout.controlSize, controlHeights.touch.compact);
assert.equal(widgetTokens.layout.controlGlyphSize, typeSizes[24]);
assert.ok(widgetTokens.layout.rowHeight >= controlHeights.touch.compact);
assert.ok(widgetTokens.layout.headerHeight >= controlHeights.touch.compact);
assert.ok(Object.values(widgetTokens.type).every(value => value >= typeSizes[11]),
  "Widgets adapt content instead of shrinking words below the readable type step");
assert.equal(widgetTokens.type.metaSize, typeSizes[12]);
assert.match(renderAndroidWidgetTokensXml("light"), /name="musubi_widget_meta_size">12sp/);
assert.match(renderAndroidWidgetTokensXml("light"), /name="musubi_widget_control_size">44dp/);
assert.match(renderAndroidWidgetTokensXml("light"), /name="musubi_widget_control_glyph_size">24dp/,
  "Named icon glyphs must not inherit user text scaling and overflow their touch target");
assert.ok(!renderAndroidWidgetTokensXml("dark").includes("<dimen"),
  "Both schemes inherit the same geometry and scalable type");

console.log("Android widget token export self-check: OK");
