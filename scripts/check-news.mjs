import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_NEWS_MAX_BYTES, ProjectNewsFeedSchema } from "../packages/types/src/project-news.ts";

export function validateProjectNews(source) {
  if (source.byteLength > PROJECT_NEWS_MAX_BYTES) throw new Error("news.json exceeds the bounded server reader size.");
  const feed = ProjectNewsFeedSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source)));
  const ids = feed.items.map(item => item.id);
  if (ids.some((id, index) => index > 0 && ids[index - 1] <= id)) throw new Error("Keep news.json newest first, using lexical IDs.");
  return feed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const feed = validateProjectNews(await readFile(new URL("../news.json", import.meta.url)));
  console.log(`Project news: ${feed.items.length} valid entries`);
}
