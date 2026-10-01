import { cn } from "./utils";

describe("cn", () => {
  it("merges Musubi type sizes as font sizes", () => {
    expect(cn("text-13 text-muted-foreground", "text-15")).toBe("text-muted-foreground text-15");
  });

  it("merges Musubi radii and control heights", () => {
    expect(cn("rounded-control h-control", "rounded-card h-control-compact")).toBe("rounded-card h-control-compact");
  });
});
