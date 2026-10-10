import { parseColor } from "./contrast";
import { widgetThemeTokens, widgetTokens } from "./widget-tokens";

/** SwiftUI receives the same semantic colours and geometry as RemoteViews. */
export function renderIosWidgetTokensSwift() {
  const sections = Object.entries(widgetTokens).filter(([name]) => name === "layout" || name === "type")
    .map(([name, values]) => `  enum ${name === "type" ? "Typography" : "Layout"} {\n${Object.entries(values).map(([key, value]) => `    static let ${key}: CGFloat = ${value}`).join("\n")}\n  }`);
  const colours = Object.keys(widgetThemeTokens.light).map(key => {
    const value = (scheme: "light" | "dark") => {
      const { rgb, alpha } = parseColor(widgetThemeTokens[scheme][key as keyof typeof widgetThemeTokens.light]);
      return `Color(.sRGB, red: ${rgb[0]} / 255.0, green: ${rgb[1]} / 255.0, blue: ${rgb[2]} / 255.0, opacity: ${alpha})`;
    };
    return `  static func ${key}(_ scheme: ColorScheme) -> Color {\n    scheme == .dark ? ${value("dark")} : ${value("light")}\n  }`;
  });
  return `// Generated from packages/design-system. Edit TypeScript sources and regenerate.\nimport SwiftUI\n\nenum WidgetTokens {\n${sections.join("\n")}\n${colours.join("\n")}\n}\n`;
}
