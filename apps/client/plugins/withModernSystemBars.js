const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { withAppBuildGradle, withDangerousMod, withAndroidStyles } = require("@expo/config-plugins");
const pluginRoot = path.dirname(require.resolve("./withModernSystemBars.js"));

const TYPES = "// musubi-system-bars-types";
const REGISTER = "// musubi-system-bars-registration";

function replaceBlock(contents, marker, body, prepend) {
  const end = `// end ${marker.slice(3)}`;
  const startAt = contents.indexOf(marker);
  const block = `${marker}\n${body.trim()}\n${end}\n`;
  if (startAt === -1) {
    if (contents.includes(end)) throw new Error(`Incomplete generated ${marker.slice(3)} block.`);
    return prepend ? block + contents : contents + "\n" + block;
  }
  const endAt = contents.indexOf(end, startAt);
  if (endAt === -1) throw new Error(`Incomplete generated ${marker.slice(3)} block.`);
  return contents.slice(0, startAt) + block + contents.slice(endAt + end.length).replace(/^\n/, "");
}

function patchBuildGradle(contents, source) {
  const parts = source.split("// Register in the app script's existing AGP classloader.");
  if (parts.length !== 2) throw new Error("Invalid Musubi system bars Gradle source.");
  contents = replaceBlock(contents, TYPES, parts[0], true);
  return replaceBlock(contents, REGISTER, parts[1], false);
}

module.exports = function withModernSystemBars(config) {
  config = withAndroidStyles(config, cfg => {
    const styles = cfg.modResults.resources.style;
    const theme = styles.find(style => style.$.name === "AppTheme");
    if (!theme) throw new Error("Musubi system bars require AppTheme.");
    const set = (style, name, value) => {
      style.item ??= [];
      const item = style.item.find(item => item.$.name === name);
      if (item) item._ = value;
      else style.item.push({ $: { name }, _: value });
    };
    set(theme, "android:statusBarColor", "@android:color/transparent");
    set(theme, "android:navigationBarColor", "@android:color/transparent");
    for (const [kind, parent] of [
      ["BottomSheet", "Theme.MaterialComponents.DayNight.BottomSheetDialog"],
      ["SideSheet", "Theme.Material3.DayNight.SideSheetDialog"],
    ]) {
      const name = `Musubi.EdgeToEdge.${kind}Dialog`;
      set(theme, kind === "BottomSheet" ? "bottomSheetDialogTheme" : "sideSheetDialogTheme", `@style/${name}`);
      let sheet = styles.find(style => style.$.name === name);
      if (!sheet) {
        sheet = { $: { name, parent }, item: [] };
        styles.push(sheet);
      }
      sheet.$.parent = parent;
      set(sheet, "android:statusBarColor", "@android:color/transparent");
      set(sheet, "android:navigationBarColor", "@android:color/transparent");
      set(sheet, "enableEdgeToEdge", "true");
    }
    return cfg;
  });
  config = withAppBuildGradle(config, cfg => {
    if (cfg.modResults.language !== "groovy") throw new Error("Musubi system bars require Groovy app Gradle.");
    cfg.modResults.contents = patchBuildGradle(cfg.modResults.contents,
      readFileSync(path.join(pluginRoot, "android-system-bars.gradle"), "utf8"));
    return cfg;
  });
  return withDangerousMod(config, ["android", async cfg => {
    const root = cfg.modRequest.platformProjectRoot;
    const java = path.join(root, "app/src/main/java/dev/frgtn/musubi/compat");
    await fs.mkdir(java, { recursive: true });
    await fs.copyFile(path.join(pluginRoot, "android-system-bars/DisplayCutout.java"), path.join(java, "DisplayCutout.java"));
    return cfg;
  }]);
};

module.exports.patchBuildGradle = patchBuildGradle;
