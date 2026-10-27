import {
  newestAnnouncementId, PROJECT_NEWS_BASELINE, PROJECT_NEWS_MAX_BYTES, ProjectNewsFeedSchema,
  type Announcement, type AnnouncementsResponse,
} from "@musubi/types";
import type { Request, Response as ApiResponse } from "express";

export const PROJECT_NEWS_URL = "https://raw.githubusercontent.com/f-tuma/musubi/main/news.json";
export const PROJECT_NEWS_TTL_MS = 15 * 60_000;
export { PROJECT_NEWS_MAX_BYTES };
const FAILURE_RETRY_MS = 60_000, MAX_RETRY_MS = 24 * 60 * 60_000;
export class ProjectNewsUnavailable extends Error {
  constructor() { super("News and updates are temporarily unavailable."); }
}
export type ProjectNewsReader = () => Promise<readonly Announcement[]>;

function retryDelay(headers: Headers, now: number) {
  const retry = headers.get("retry-after");
  let delay = FAILURE_RETRY_MS;
  if (retry) {
    const seconds = /^\d+$/.test(retry.trim()) ? Number(retry) : NaN;
    const target = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry);
    if (Number.isFinite(target)) delay = Math.max(delay, target - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) delay = Math.max(delay, Number(reset) * 1000 - now);
  return Math.min(MAX_RETRY_MS, delay);
}

async function readBoundedJson(response: Response) {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > PROJECT_NEWS_MAX_BYTES) {
    await response.body?.cancel(); throw new ProjectNewsUnavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProjectNewsUnavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PROJECT_NEWS_MAX_BYTES) { await reader.cancel(); throw new ProjectNewsUnavailable(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

/** One cache per API process, shared across accounts; no user data leaves the server. */
export function createProjectNewsReader(dependencies: {
  fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number;
} = {}): ProjectNewsReader {
  const send: typeof globalThis.fetch = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = dependencies.now ?? Date.now, timeoutMs = dependencies.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError("Invalid news request timeout.");
  let cached: readonly Announcement[] | undefined, etag: string | undefined, nextRefresh = 0;
  let inFlight: Promise<readonly Announcement[]> | undefined;
  async function refresh(): Promise<readonly Announcement[]> {
    let failureDelay = FAILURE_RETRY_MS;
    try {
      const response = await send(PROJECT_NEWS_URL, {
        method: "GET", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", "user-agent": "Musubi-project-news", ...(etag ? { "if-none-match": etag } : {}) },
      });
      if (response.status === 304) {
        if (cached === undefined) throw new ProjectNewsUnavailable();
        nextRefresh = now() + PROJECT_NEWS_TTL_MS; return cached;
      }
      if (!response.ok) {
        failureDelay = retryDelay(response.headers, now());
        await response.body?.cancel(); throw new ProjectNewsUnavailable();
      }
      const feed = ProjectNewsFeedSchema.parse(await readBoundedJson(response));
      const items = [...feed.items].sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
      cached = Object.freeze(items.map(item => Object.freeze({ ...item, minVersion: null })));
      const candidateEtag = response.headers.get("etag");
      etag = candidateEtag && candidateEtag.length <= 512 && !/[\r\n]/.test(candidateEtag) ? candidateEtag : undefined;
      nextRefresh = now() + PROJECT_NEWS_TTL_MS; return cached;
    } catch {
      nextRefresh = now() + failureDelay;
      if (cached !== undefined) return cached;
      throw new ProjectNewsUnavailable();
    }
  }
  return function readProjectNews() {
    if (inFlight) return inFlight;
    if (now() < nextRefresh) return cached !== undefined ? Promise.resolve(cached) : Promise.reject(new ProjectNewsUnavailable());
    const pending = refresh(); inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = undefined; }).catch(() => {});
    return pending;
  };
}
export const getProjectNews = createProjectNewsReader();

type NewsSettings = { lastSeenProjectNews?: string };
export function createProjectNewsHandler(dependencies: {
  getSettings: (userId: string) => Promise<NewsSettings>;
  initialize: (userId: string, marker: string) => Promise<{ initialized: boolean; settings: NewsSettings }>;
  read: ProjectNewsReader;
}) {
  return async (req: Request, res: ApiResponse) => {
    let settings: NewsSettings, items: readonly Announcement[];
    try { [settings, items] = await Promise.all([dependencies.getSettings(req.user!.id), dependencies.read()]); }
    catch (error) {
      if (!(error instanceof ProjectNewsUnavailable)) throw error;
      return res.status(503).json({ error: "NewsUnavailable", message: error.message });
    }
    if (!settings.lastSeenProjectNews) {
      const baseline = newestAnnouncementId(items) ?? PROJECT_NEWS_BASELINE;
      const initialized = await dependencies.initialize(req.user!.id, baseline);
      if (initialized.initialized)
        return res.status(200).json({ announcements: [], isAdmin: false, markTo: initialized.settings.lastSeenProjectNews } satisfies AnnouncementsResponse);
      settings = initialized.settings;
    }
    return res.status(200).json({
      announcements: items.filter(item => item.id > (settings.lastSeenProjectNews ?? "")), isAdmin: false,
    } satisfies AnnouncementsResponse);
  };
}

/** Both generations can hold an old server's response across an upgrade. */
export async function withProjectNewsReadMarker<T extends { lastSeenAnnouncement?: string; lastSeenProjectNews?: string }>(
  values: T, dependencies: { getSettings: () => Promise<NewsSettings>; read?: ProjectNewsReader },
): Promise<T> {
  if (values.lastSeenProjectNews === undefined && values.lastSeenAnnouncement === undefined) return values;
  const withoutProjectMarker = { ...values };
  delete withoutProjectMarker.lastSeenProjectNews;
  // Only the validated first GET establishes this namespace. A stale old PUT
  // or a new client holding an old response cannot establish it on dismissal.
  if (!(await dependencies.getSettings()).lastSeenProjectNews) return withoutProjectMarker;
  let items: readonly Announcement[];
  try { items = await (dependencies.read ?? getProjectNews)(); } catch { return withoutProjectMarker; }
  const marker = values.lastSeenProjectNews ?? values.lastSeenAnnouncement;
  if (marker !== PROJECT_NEWS_BASELINE && !items.some(item => item.id === marker)) return withoutProjectMarker;
  return { ...values, lastSeenProjectNews: marker };
}
