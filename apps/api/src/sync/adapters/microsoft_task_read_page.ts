import type { GraphTaskReadKind } from "./microsoft_task_read_error";

type InvalidReason = "response" | "body" | "value" | "item" | "removal" |
  "completion" | "link" | "cycle" | "page-limit" | "normalization";

/** A successful HTTP response grants no full-set authority until its entire
 * page chain is validated. Never retain provider bodies, links or parse errors. */
export class GraphTaskReadResponseError extends Error {
  readonly cause: Readonly<{
    code: "graph-task-read-response-invalid";
    readKind: GraphTaskReadKind;
    reason: InvalidReason;
    httpStatus: number | null;
  }>;
  constructor(readKind: GraphTaskReadKind, reason: InvalidReason, httpStatus: number | null = null) {
    super("Outlook task read response is incomplete or invalid.");
    this.name = "GraphTaskReadResponseError";
    this.cause = Object.freeze({ code: "graph-task-read-response-invalid", readKind, reason, httpStatus });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value);
}

function taskReadLink(value: unknown, graphBase: string, kind: GraphTaskReadKind, status: number | null): string {
  const invalid = () => new GraphTaskReadResponseError(kind, "link", status);
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  let parsed: URL, base: URL;
  try { parsed = new URL(value); base = new URL(graphBase); }
  catch { throw invalid(); }
  // Reject URL-parser repairs (dot segments, backslashes, missing slashes or
  // malformed authorities). Parse only for validation: fetch/save original bytes.
  const raw = /^([A-Za-z][A-Za-z\d+.-]*:)\/\/([^/?#]*)(\/[^?#]*)?/.exec(value);
  if (!raw || raw[1] !== parsed.protocol || raw[2] !== parsed.host || raw[3] !== parsed.pathname ||
    parsed.origin !== base.origin || parsed.protocol !== base.protocol || !["https:", "http:"].includes(base.protocol) ||
    parsed.username || parsed.password || value.includes("#")) throw invalid();
  return value;
}

/** The budget is shared across renewal and unsupported-delta fallback. Clearing
 * visited pages for a 410 permits a legitimate initial request again, without
 * allowing repeated renewals to create an unbounded read. */
export function graphTaskReadTraversal(graphBase: string) {
  const visited = new Set<string>();
  let pages = 0;
  return {
    visit(value: string, kind: GraphTaskReadKind) {
      const link = taskReadLink(value, graphBase, kind, null);
      const key = new URL(link).href;
      if (visited.has(key)) throw new GraphTaskReadResponseError(kind, "cycle");
      if (pages >= 1000) throw new GraphTaskReadResponseError(kind, "page-limit");
      pages++;
      visited.add(key);
      return link;
    },
    clearVisited() { visited.clear(); },
  };
}

export async function graphTaskReadPage(response: Response, kind: GraphTaskReadKind, graphBase: string) {
  const invalid = (reason: InvalidReason) => new GraphTaskReadResponseError(kind, reason, response.status);
  if (response.status !== 200 || response.redirected || response.headers.has("content-range")) throw invalid("response");
  let data: unknown;
  try { data = await response.json(); }
  catch { throw invalid("body"); }
  if (!record(data) || owns(data, "error")) throw invalid("body");
  if (!owns(data, "value") || !Array.isArray(data.value)) throw invalid("value");
  for (const item of data.value) {
    if (!record(item) || !validID(item.id)) throw invalid("item");
    if (owns(item, "@removed") && !record(item["@removed"])) throw invalid("removal");
  }
  const hasNext = owns(data, "@odata.nextLink");
  const hasDelta = owns(data, "@odata.deltaLink");
  if (kind === "delta" ? hasNext === hasDelta : hasDelta) throw invalid("completion");
  // Presence is significant. null/empty links do not mean a terminal snapshot.
  const nextLink = hasNext ? taskReadLink(data["@odata.nextLink"], graphBase, kind, response.status) : null;
  const deltaLink = hasDelta ? taskReadLink(data["@odata.deltaLink"], graphBase, kind, response.status) : null;
  return { items: data.value as Record<string, unknown>[], nextLink, deltaLink };
}
