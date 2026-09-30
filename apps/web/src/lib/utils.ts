import { createCn } from "cn/config";

const typeSizes = ["display", "ambient", "10", "11", "12", "13", "14", "15", "16", "18", "19", "20", "22", "24", "26", "28", "32"];

/**
 * Class merging taught Musubi's theme. The default engine only knows
 * Tailwind's scale, so without this `text-13` would read as a colour and
 * survive next to `text-15` instead of being replaced by it.
 */
export const cn = createCn({
  extend: {
    theme: {
      text: typeSizes,
      radius: ["sm", "md", "lg", "sheet", "card", "control", "chip"],
      spacing: ["control", "control-compact", "row", "sidebar", "inspector", "popover", "dialog", "safe-bottom"],
      shadow: ["raised", "overlay"],
      breakpoint: ["sm", "md", "lg"],
      container: ["compact", "form", "default", "wide"],
      tracking: ["normal", "label", "wide"],
    },
    classGroups: {
      duration: [{ duration: ["panel", "fast", "standard", "slow"] }],
      "focus-inset": ["focus-inset"],
      z: [{ z: ["dialog-overlay", "dialog", "popover", "dialog-overlay-elevated", "dialog-elevated", "popover-elevated"] }],
    },
  },
});
