import { describe, expect, it } from "vitest";
import {
  announcementParagraphs,
  newestAnnouncementId,
  pendingAnnouncements,
} from "@musubi/types";

// Modal sám je React Native strom; testovatelné jsou rozhodovací pravidla,
// která rozhodují, CO ukáže a kam posune značku.
describe("project news selection on the phone", () => {
  const announcements = [
    { id: "2026-08-20", title: "next", body: "x", minVersion: "0.1.7" },
    { id: "2026-08-10", title: "now", body: "x", minVersion: "0.1.6" },
  ];

  it("hides a message meant for a build this phone does not run yet", () => {
    const pending = pendingAnnouncements(announcements, "0.1.6");
    expect(pending.map((a) => a.id)).toEqual(["2026-08-10"]);
    // Značka se posune jen na zobrazené, takže po updatu na 0.1.7 přijde zbytek.
    expect(newestAnnouncementId(pending)).toBe("2026-08-10");
  });

  it("delivers the held-back message after the update", () => {
    const pending = pendingAnnouncements(announcements, "0.1.7");
    expect(pending.map((a) => a.id)).toEqual(["2026-08-20", "2026-08-10"]);
    expect(newestAnnouncementId(pending)).toBe("2026-08-20");
  });

  it("splits the body into paragraphs and links", () => {
    const [first, second] = announcementParagraphs(
      "hello\n\njoin https://discord.gg/example",
    );
    expect(first).toEqual([{ type: "text", value: "hello" }]);
    expect(second[1]).toEqual({
      type: "link",
      url: "https://discord.gg/example",
      value: "https://discord.gg/example",
    });
  });
});
