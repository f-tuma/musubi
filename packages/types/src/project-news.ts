import { z } from "zod";
import { AnnouncementSchema } from "./announcement";

export const PROJECT_NEWS_BASELINE = "0000-00-00";
export const PROJECT_NEWS_MAX_BYTES = 128 * 1024;
// Project news describes available updates for every version. Version gating
// plus a single read watermark could permanently hide an older gated item.
const ProjectNewsItemSchema = AnnouncementSchema.omit({ minVersion: true }).extend({ id: AnnouncementSchema.shape.id.max(64) }).strict().superRefine((item, ctx) => {
  const date = item.id.slice(0, 10), parsed = new Date(`${date}T00:00:00.000Z`);
  if (date.startsWith("0000-") || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    ctx.addIssue({ code: "custom", path: ["id"], message: "News IDs need a real calendar date." });
  if (!item.title.trim() || !item.body.trim()) ctx.addIssue({ code: "custom", message: "News title and body cannot be blank." });
});
export const ProjectNewsFeedSchema = z.object({ schemaVersion: z.literal(1), items: z.array(ProjectNewsItemSchema).max(100) }).strict().superRefine((feed, ctx) => {
  const seen = new Set<string>();
  feed.items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: ["items", index, "id"], message: "News IDs must be unique." });
    seen.add(item.id);
  });
});
export type ProjectNewsFeed = z.infer<typeof ProjectNewsFeedSchema>;
