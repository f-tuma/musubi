import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderIosWidgetTokensSwift } from "./ios-widget";
import { widgetThemeTokens, widgetTokens } from "./widget-tokens";

const output = renderIosWidgetTokensSwift();
assert.equal(readFileSync(new URL("../../../apps/client/widgets/ios/WidgetTokens.swift", import.meta.url), "utf8"), output,
  "iOS widget tokens are stale — run design-system generate");
for (const name of Object.keys(widgetThemeTokens.light)) assert.ok(output.includes(`static func ${name}(`));
for (const [name, value] of Object.entries(widgetTokens.layout)) assert.ok(output.includes(`static let ${name}: CGFloat = ${value}`));
assert.ok(!output.includes("undefined"));
console.log("iOS widget token export self-check: OK");
