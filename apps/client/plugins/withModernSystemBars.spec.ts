import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { patchBuildGradle } = createRequire(import.meta.url)("./withModernSystemBars.js");
const divider = "// Register in the app script's existing AGP classloader.";
const original = 'apply plugin: "com.android.application"\nandroid {}\n';
const source = `class NativeMigration {}\n${divider}\nregisterMigration()\n`;

describe("native system bar build integration", () => {
  it("preserves app Gradle and updates a previously generated migration on repeat prebuild", () => {
    const first = patchBuildGradle(original, source);
    expect(patchBuildGradle(first, source)).toBe(first);
    const updated = patchBuildGradle(first, source.replace("registerMigration()", "registerNewMigration()"));
    expect(updated).toContain(original);
    expect(updated).toContain("registerNewMigration()");
    expect(updated).not.toContain("registerMigration()");
    expect(updated.match(/class NativeMigration/g)).toHaveLength(1);
  });

  it("fails on a partial generated block rather than retaining stale native code", () => {
    expect(() => patchBuildGradle("// musubi-system-bars-types\nold code", source)).toThrow("Incomplete generated");
    expect(() => patchBuildGradle("old code\n// end musubi-system-bars-types", source)).toThrow("Incomplete generated");
  });

  it("fails if the source loses its registration boundary", () => {
    expect(() => patchBuildGradle(original, "class NativeMigration {}")).toThrow("Invalid Musubi");
  });
});
