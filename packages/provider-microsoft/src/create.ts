import { z } from "zod";
import { MicrosoftProviderError } from "./types";
import type {
  MicrosoftAccountSession, MicrosoftCreateNativeProfile, MicrosoftCreateProviderPorts, MicrosoftCreateTarget,
  MicrosoftNativeCreateEvidence, MicrosoftNativeCreatePreflight, MicrosoftNativeCreateReadEvidence,
  MicrosoftNativeEvent, MicrosoftPersonalCreate, MicrosoftPersonalCreateBody,
} from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LIST_SELECT = "id,transactionId,subject,start,end,isAllDay,isCancelled,body,location,organizer,recurrence,onlineMeeting,onlineMeetingUrl";
const STRICT_SELECT = `${LIST_SELECT},type,isOrganizer,isDraft,seriesMasterId,attendees,isOnlineMeeting`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new MicrosoftProviderError("event-diff-unavailable");
const failed = () => new MicrosoftProviderError("provider-write-failed");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = record(value);
  if (Reflect.ownKeys(item).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(item, key))) throw invalid();
  return item;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value || [".", ".."].includes(value)) throw invalid();
  return value;
}
/** Retain native JSON without invoking getters/toJSON or keeping mutable port objects. */
function snapshot(value: unknown): unknown {
  let nodes = 0, units = 0;
  const active = new Set<object>();
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 10_000 || depth > 32) throw failed();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") { units += item.length; if (units > 2_000_000) throw failed(); return item; }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || active.has(item)) throw failed();
    active.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(descriptors).length !== item.length + 1) throw failed();
        return Object.freeze(Array.from({ length: item.length }, (_, index) => {
          const field = descriptors[String(index)];
          if (!field || !("value" in field) || !field.enumerable) throw failed();
          return copy(field.value, depth + 1);
        }));
      }
      record(item);
      return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, field]) => {
        units += key.length; if (units > 2_000_000 || !("value" in field) || !field.enumerable) throw failed();
        return [key, copy(field.value, depth + 1)];
      })));
    } finally { active.delete(item); }
  }
  return copy(value, 0);
}
function timed(value: unknown): number {
  const item = exact(value, ["dateTime", "timeZone"]), text = item.dateTime;
  if (item.timeZone !== "UTC" || typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z?$/.test(text)) throw invalid();
  const milliseconds = Date.parse(text.endsWith("Z") ? text : `${text}Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== text.slice(0, 19)) throw invalid();
  return milliseconds;
}
function creation(value: unknown): MicrosoftPersonalCreate {
  const item = exact(value, ["target", "body", "operationId", "attemptId", "serializer"]);
  const scope = exact(item.target, ["connectionId", "connectionGeneration", "calendarId"]);
  const serializer = exact(item.serializer, ["id", "version"]);
  if (serializer.id !== "microsoft-personal-event" || serializer.version !== 1 || typeof item.operationId !== "string" || !UUID.test(item.operationId)) throw invalid();
  const body = exact(item.body, ["subject", "body", "location", "isAllDay", "start", "end", "transactionId"]);
  const content = exact(body.body, ["contentType", "content"]), location = exact(body.location, ["displayName"]);
  if (typeof body.subject !== "string" || content.contentType !== "text" || typeof content.content !== "string" ||
      typeof location.displayName !== "string" || body.isAllDay !== false || body.transactionId !== item.operationId || timed(body.start) > timed(body.end)) throw invalid();
  return Object.freeze({ target: Object.freeze({ connectionId: identity(scope.connectionId), connectionGeneration: identity(scope.connectionGeneration), calendarId: identity(scope.calendarId) }),
    body: snapshot(body) as MicrosoftPersonalCreateBody, operationId: item.operationId, attemptId: identity(item.attemptId),
    serializer: Object.freeze({ id: "microsoft-personal-event" as const, version: 1 as const }) });
}
function capability(allowed: unknown): void {
  if (allowed !== true) throw new MicrosoftProviderError("capability-evidence", "not-written", undefined, undefined, "event-write", allowed === false ? "denied" : "unknown");
}
function unsupported(): never {
  throw new MicrosoftProviderError("capability-evidence", "not-written", undefined, undefined, "event-write", "unsupported");
}
function retryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
/** CREATE facts and correlation only; complete-listing absence never authorizes replay. */
export function createMicrosoftPersonalEventCreateProvider(ports: MicrosoftCreateProviderPorts,
  options: { readonly nativeProfile: MicrosoftCreateNativeProfile }) {
  const config = exact(options, ["nativeProfile"]), profile = config.nativeProfile;
  if (profile !== "existing-microsoft" && profile !== "strict-reference") throw invalid();
  const strict = profile === "strict-reference";
  const calendarURL = (scope: MicrosoftCreateTarget) => `${GRAPH}/me/calendars/${encodeURIComponent(scope.calendarId)}`;
  async function session(scope: MicrosoftCreateTarget, signal?: AbortSignal): Promise<MicrosoftAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted();
    if (current.connectionId !== scope.connectionId || current.connectionGeneration !== scope.connectionGeneration) throw new MicrosoftProviderError("account-session-changed");
    if (typeof current.accessToken !== "string" || !current.accessToken) throw failed();
    return Object.freeze({ connectionId: current.connectionId, connectionGeneration: current.connectionGeneration,
      accessToken: current.accessToken, eventWriteAllowed: current.eventWriteAllowed });
  }
  async function request(url: string, method: "GET" | "POST", current: MicrosoftAccountSession, signal?: AbortSignal,
    mode: "preflight" | "listing" | "post" = "listing", body?: string): Promise<Response> {
    signal?.throwIfAborted();
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const started = ports.clock.nowMonotonicMs();
    let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(url, { method, signal: bounded,
        ...(strict || mode !== "preflight" ? { redirect: "error" as const } : {}),
        headers: { Authorization: `Bearer ${current.accessToken}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : mode === "listing" ? {
            Prefer: strict ? 'outlook.timezone="UTC", outlook.body-content-type="text"' : 'outlook.timezone="UTC"',
            "Cache-Control": "no-cache" } : strict ? { "Cache-Control": "no-cache" } : {}) },
        ...(body === undefined ? {} : { body }) });
      status = response.status;
      // POST acceptance is retained independently; strict readback verifies its native identity.
      if (strict && method === "GET" && (response.redirected || response.url && response.url !== url)) throw failed();
      bounded.throwIfAborted();
      return response;
    } catch (error) {
      if (bounded.aborted || error instanceof Error && error.name === "AbortError") status = "aborted";
      if (error instanceof MicrosoftProviderError) throw error;
      if (method === "POST") throw new MicrosoftProviderError("provider-write-failed", "unconfirmed");
      if (strict) throw failed();
      throw error;
    } finally {
      try { ports.telemetry.record({ provider: "microsoft", family: "event", method, status,
        durationMs: Math.max(0, ports.clock.nowMonotonicMs() - started) }); } catch { /* Diagnostics have no authority. */ }
    }
  }
  function readable(response: Response, complete: boolean): void {
    if (!response.ok) {
      if (response.status === 429 || response.status === 408 || response.status >= 500)
        throw new MicrosoftProviderError("provider-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      throw new MicrosoftProviderError("capability-evidence", "not-written", response.status, undefined, "event-write", response.status === 401 || response.status === 403 ? "denied" : "unknown");
    }
    if (complete && (response.status !== 200 || response.headers.has("content-range"))) throw failed();
  }
  function strictPersonal(value: Record<string, unknown>): void {
    if (value.type !== "singleInstance" || value.isCancelled !== false || value.isOrganizer !== true || value.isDraft !== false ||
        value.recurrence !== null || value.seriesMasterId != null || !Array.isArray(value.attendees) || value.attendees.length !== 0 ||
        value.isOnlineMeeting !== false || value.onlineMeeting != null || value.onlineMeetingUrl != null || value["@removed"] ||
        value["attendees@odata.nextLink"] || value["@odata.nextLink"] || value.isAllDay !== false) unsupported();
    if (timed(value.start) > timed(value.end)) unsupported();
  }
  return {
    async preflightCreate(input: MicrosoftPersonalCreate, signal?: AbortSignal): Promise<MicrosoftNativeCreatePreflight> {
      const accepted = creation(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed);
      let self: Record<string, unknown> | undefined;
      if (strict) {
        const response = await request(`${GRAPH}/me?$select=id,mail,userPrincipalName`, "GET", current, signal, "preflight");
        readable(response, true); self = record(snapshot(await response.json()));
      }
      const response = await request(`${calendarURL(accepted.target)}?$select=${strict ? "id,canEdit,owner" : "canEdit"}`, "GET", current, signal, "preflight");
      readable(response, strict);
      // Keep the original host accessor floor: null and invalid JSON throw their raw errors.
      const calendar = await response.json();
      capability(calendar.canEdit);
      if (strict) {
        const owner = record(calendar.owner), email = self!.mail ?? self!.userPrincipalName;
        if (typeof self!.id !== "string" || !self!.id || !z.email().safeParse(email).success || typeof email !== "string" ||
            calendar.id !== accepted.target.calendarId || typeof owner.address !== "string" || owner.address.toLowerCase() !== email.toLowerCase()) unsupported();
      }
      signal?.throwIfAborted();
      return Object.freeze({ kind: "allowed" });
    },
    async create(input: MicrosoftPersonalCreate, signal?: AbortSignal): Promise<MicrosoftNativeCreateEvidence> {
      const accepted = creation(input), current = await session(accepted.target, signal);
      capability(current.eventWriteAllowed);
      await ports.beforeMutation(accepted, signal);
      signal?.throwIfAborted();
      const response = await request(`${calendarURL(accepted.target)}/events`, "POST", current, signal, "post", JSON.stringify(accepted.body));
      if (![200, 201, 204].includes(response.status)) throw new MicrosoftProviderError(response.status === 412 ? "provider-conflict" : "provider-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      const data = await response.json().catch(() => null);
      if (typeof data?.id !== "string" || !data.id) throw new MicrosoftProviderError("provider-write-failed", "unconfirmed", response.status);
      return Object.freeze({ kind: "created", status: response.status as 200 | 201 | 204, eventId: data.id,
        etag: typeof data["@odata.etag"] === "string" ? data["@odata.etag"] : null });
    },
    async readCreated(input: MicrosoftPersonalCreate, signal?: AbortSignal): Promise<MicrosoftNativeCreateReadEvidence> {
      const accepted = creation(input), current = await session(accepted.target, signal), base = new URL(`${calendarURL(accepted.target)}/events`);
      let next: string | null = `${base}?$select=${strict ? STRICT_SELECT : LIST_SELECT}&$top=100`;
      const visited = new Set<string>();
      let found: Record<string, unknown> | undefined;
      while (next) {
        const url: URL = new URL(next);
        if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || visited.has(url.href) || visited.size >= 1000) throw failed();
        visited.add(url.href);
        const response = await request(url.href, "GET", current, signal, "listing");
        readable(response, true);
        const data = await response.json();
        if (!Array.isArray(data.value) || data["@odata.nextLink"] !== undefined &&
            (typeof data["@odata.nextLink"] !== "string" || !data["@odata.nextLink"] || data["@odata.nextLink"].trim() !== data["@odata.nextLink"])) throw failed();
        for (const item of data.value) if (item.transactionId === accepted.operationId) {
          if (found || typeof item.id !== "string" || !item.id) throw new MicrosoftProviderError("provider-conflict");
          found = record(snapshot(item));
        }
        next = data["@odata.nextLink"] ?? null;
      }
      signal?.throwIfAborted();
      if (!found) return Object.freeze({ kind: "missing" });
      if (found.isCancelled || found.recurrence) throw new MicrosoftProviderError("provider-conflict");
      const native = record(snapshot(found));
      if (strict) strictPersonal(native);
      return Object.freeze({ kind: "present", event: native as MicrosoftNativeEvent,
        etag: typeof native["@odata.etag"] === "string" ? native["@odata.etag"] : null });
    },
  };
}
