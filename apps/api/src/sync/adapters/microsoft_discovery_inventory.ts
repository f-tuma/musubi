type Resource = "events" | "tasks";
// Host namespace used to dispatch Tasks independently from Outlook calendars.
// Native calendar IDs may not alias these normalized Task collection IDs.
export const MICROSOFT_TASK_LIST_PREFIX = "musubi-microsoft-task-list:";
type CalendarItem = { id: string; name: string; hexColor?: string | null; canEdit?: boolean | null; canViewPrivateItems?: boolean | null; isDefaultCalendar?: boolean | null };
export type TaskListItem = { id: string; displayName?: string | null; isOwner?: boolean | null };
type DiscoveryItem<R extends Resource> = R extends "events" ? CalendarItem : TaskListItem;
type Reason = "response" | "body" | "value" | "item" | "duplicate" | "link" | "cycle" | "page-limit";

/** No provider content, request identity, URL or caught parser error is retained. */
export class GraphDiscoveryInventoryError extends Error {
  readonly cause: Readonly<{ code: "graph-discovery-inventory-invalid"; resource: Resource; reason: Reason; httpStatus: number | null }>;
  constructor(resource: Resource, reason: Reason, httpStatus: number | null = null) {
    super("Outlook discovery inventory is incomplete or invalid.");
    this.name = "GraphDiscoveryInventoryError";
    this.cause = Object.freeze({ code: "graph-discovery-inventory-invalid", resource, reason, httpStatus });
  }
}

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function text(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  // Provider IDs become URI path components. A lone surrogate must fail before
  // inventory authority, rather than later at encodeURIComponent during pull.
  try { encodeURIComponent(value); return true; } catch { return false; }
}
const storedText = (value: unknown): value is string => typeof value === "string" && !value.includes("\u0000");
const optional = (value: unknown, type: "boolean" | "string") => value === undefined || value === null || (type === "string" ? storedText(value) : typeof value === type);

/** Complete collection inventory only. The endpoint path is pinned to the
 * requested resource; a same-origin event/task detail URL cannot grant absence
 * authority for a different collection. Fetch the original opaque URL bytes. */
export function graphDiscoveryInventory<R extends Resource>(resource: R, initialURL: string) {
  const initial = new URL(initialURL), visited = new Set<string>(), ids = new Set<string>();
  let pages = 0;
  const invalid = (reason: Reason, status: number | null = null) => new GraphDiscoveryInventoryError(resource, reason, status);
  const link = (value: unknown) => {
    if (!text(value)) throw invalid("link");
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw invalid("link"); }
    const raw = /^([A-Za-z][A-Za-z\d+.-]*:)\/\/([^/?#]*)(\/[^?#]*)?/.exec(value);
    if (!raw || raw[1] !== parsed.protocol || raw[2] !== parsed.host || raw[3] !== parsed.pathname ||
      parsed.origin !== initial.origin || parsed.protocol !== "https:" || parsed.pathname !== initial.pathname ||
      parsed.username || parsed.password || value.includes("#")) throw invalid("link");
    return value;
  };
  return {
    visit(value: string) {
      const original = link(value), identity = new URL(original).href;
      if (visited.has(identity)) throw invalid("cycle");
      if (pages >= 1000) throw invalid("page-limit");
      visited.add(identity); pages++;
      return original;
    },
    async page(response: Response) {
      if (response.status !== 200 || response.redirected || response.headers.has("content-range")) throw invalid("response", response.status);
      let data: unknown;
      try { data = await response.json(); } catch { throw invalid("body", response.status); }
      if (!record(data) || owns(data, "error") || owns(data, "@odata.deltaLink")) throw invalid("body", response.status);
      if (!owns(data, "value") || !Array.isArray(data.value)) throw invalid("value", response.status);
      for (const item of data.value) {
        if (!record(item) || !text(item.id) || [".", ".."].includes(item.id) || owns(item, "@removed")) throw invalid("item", response.status);
        if (resource === "events" && item.id.startsWith(MICROSOFT_TASK_LIST_PREFIX)) throw invalid("item", response.status);
        if (resource === "events" ? !storedText(item.name) || !optional(item.hexColor, "string") ||
          !optional(item.canEdit, "boolean") || !optional(item.canViewPrivateItems, "boolean") || !optional(item.isDefaultCalendar, "boolean")
          : !optional(item.displayName, "string") || !optional(item.isOwner, "boolean")) throw invalid("item", response.status);
        if (ids.has(item.id)) throw invalid("duplicate", response.status);
        ids.add(item.id);
      }
      const nextLink = owns(data, "@odata.nextLink") ? link(data["@odata.nextLink"]) : null;
      return { items: data.value as DiscoveryItem<R>[], nextLink };
    },
  };
}
