import { strongGoogleEtag } from "./etag";
import { googleTaskDataRecord, parseGoogleTaskPatch, strictGoogleTaskNativeError } from "./task-projection";
import { GoogleTaskProviderError } from "./task-types";
import type {
  GoogleNativeTask, GoogleNativeTaskReadEvidence, GoogleNativeTaskUpdateEvidence, GoogleNativeTaskUpdatePreflight,
  GoogleTaskAccountSession, GoogleTaskProviderPorts, GoogleTaskTarget, GoogleTaskUpdate,
} from "./task-types";

const ORIGIN = "https://tasks.googleapis.com/tasks/v1";
const invalid = () => new GoogleTaskProviderError("task-projection-unavailable");
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const item = googleTaskDataRecord(value);
  if (!item || Object.keys(item).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(item, key))) throw invalid();
  return item;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw invalid();
  return value;
}
function target(value: unknown): GoogleTaskTarget {
  const item = exact(value, ["connectionId", "connectionGeneration", "taskListId", "taskId"]);
  const scope = { connectionId: identity(item.connectionId), connectionGeneration: identity(item.connectionGeneration),
    taskListId: identity(item.taskListId), taskId: identity(item.taskId) };
  // URI encoding is part of input validation, before credential suspension.
  try { encodeURIComponent(scope.taskListId); encodeURIComponent(scope.taskId); } catch { throw invalid(); }
  return Object.freeze(scope);
}
function version(value: unknown): string {
  const tag = strongGoogleEtag(value);
  if (tag === null) throw new GoogleTaskProviderError("task-version-unavailable");
  return tag;
}
function updateInput(value: unknown): GoogleTaskUpdate {
  const item = exact(value, ["target", "acceptedEtag", "body", "operationId", "attemptId", "serializer"]);
  const serializer = exact(item.serializer, ["id", "version"]);
  if (serializer.id !== "google-task" || serializer.version !== 1) throw invalid();
  const scope = target(item.target), acceptedEtag = version(item.acceptedEtag), body = parseGoogleTaskPatch(item.body);
  if (body === null) throw invalid();
  return Object.freeze({ target: scope, acceptedEtag, body, operationId: identity(item.operationId), attemptId: identity(item.attemptId),
    serializer: Object.freeze({ id: "google-task" as const, version: 1 as const }) });
}
function taskURL(scope: GoogleTaskTarget): string {
  return `${ORIGIN}/lists/${encodeURIComponent(scope.taskListId)}/tasks/${encodeURIComponent(scope.taskId)}`;
}
function retryAfter(response: Response, epochMs: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - epochMs;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

/** Native Google Tasks only. Canonical task authority, frozen mask selection,
 * OAuth refresh storage, leases and ACK remain the invoking host's ports. */
export function createGoogleTaskUpdateProvider(ports: GoogleTaskProviderPorts,
  options: { readonly nativeProfile: "existing-google" | "strict-reference" }) {
  const configuration = exact(options, ["nativeProfile"]), profile = configuration.nativeProfile;
  if (profile !== "existing-google" && profile !== "strict-reference") throw invalid();
  const strict = profile === "strict-reference";
  function checkedSession(value: GoogleTaskAccountSession, scope: GoogleTaskTarget): GoogleTaskAccountSession {
    const item = googleTaskDataRecord(value);
    if (!item || item.connectionId !== scope.connectionId || item.connectionGeneration !== scope.connectionGeneration)
      throw new GoogleTaskProviderError("account-session-changed");
    if (typeof item.accessToken !== "string" || !item.accessToken || item.accessToken.length > 2_000_000) throw new GoogleTaskProviderError("task-write-failed");
    if (item.taskWriteAllowed !== true) throw new GoogleTaskProviderError("task-scope-missing");
    return Object.freeze({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration,
      accessToken: item.accessToken, taskWriteAllowed: true });
  }
  async function session(scope: GoogleTaskTarget, signal?: AbortSignal): Promise<GoogleTaskAccountSession> {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted(); return checkedSession(current, scope);
  }
  async function request(scope: GoogleTaskTarget, current: GoogleTaskAccountSession, method: "GET" | "PATCH", signal?: AbortSignal,
    serializedBody?: string, etag?: string): Promise<Response> {
    signal?.throwIfAborted();
    const started = ports.clock.nowMonotonicMs(); let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(taskURL(scope), { method, signal,
        ...(method === "GET" || strict ? { redirect: "error" as const } : {}),
        headers: { Authorization: `Bearer ${current.accessToken}`, ...(method === "GET" ? { "Cache-Control": "no-cache" } : { "Content-Type": "application/json", "If-Match": etag! }) },
        ...(serializedBody === undefined ? {} : { body: serializedBody }) });
      status = response.status; return response;
    } catch (error) {
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") status = "aborted";
      // Existing raw transport errors are interpreted by the host according to
      // dispatch evidence; wrapping them here would change retry/blocked floors.
      throw error;
    } finally {
      try { ports.telemetry.record({ provider: "google", family: "task", method, status,
        durationMs: Math.max(0, ports.clock.nowMonotonicMs() - started) }); } catch { /* Diagnostics cannot alter native evidence. */ }
    }
  }
  function completeResponse(response: Response, scope: GoogleTaskTarget, outcome: "not-written" | "unconfirmed") {
    if (strict && (response.status !== 200 || response.headers.has("content-range") || response.redirected ||
        response.url !== "" && response.url !== taskURL(scope))) throw new GoogleTaskProviderError("task-write-failed", outcome, response.status);
  }
  async function read(scope: GoogleTaskTarget, current: GoogleTaskAccountSession, signal: AbortSignal | undefined,
    mode: "delivery" | "mutation-preflight"): Promise<GoogleNativeTaskReadEvidence> {
    let response = await request(scope, current, "GET", signal);
    if (response.status === 401 && mode === "delivery" && ports.accountSession.recoverRejectedRead) {
      await response.body?.cancel(); signal?.throwIfAborted();
      const recovered = await ports.accountSession.recoverRejectedRead({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, current.accessToken, signal);
      signal?.throwIfAborted(); response = await request(scope, checkedSession(recovered, scope), "GET", signal);
      if (response.status === 401) {
        await response.body?.cancel();
        if (ports.accountSession.onReadAuthenticationRejected) return await ports.accountSession.onReadAuthenticationRejected(signal);
        throw new GoogleTaskProviderError("task-write-failed", "not-written", 401);
      }
    }
    if (response.status === 404 || response.status === 410) return { kind: "absent", status: response.status };
    if (!response.ok) throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
    completeResponse(response, scope, "not-written");
    // Keep the original JSON/null/primitive exception floor in existing-google.
    const task = await response.json() as GoogleNativeTask;
    if (strict) {
      const item = googleTaskDataRecord(task), etag = item?.etag;
      const error = strictGoogleTaskNativeError(task, scope.taskId, typeof etag === "string" ? etag : "");
      if (error) throw new GoogleTaskProviderError(error);
      return { kind: "present", task: item as GoogleNativeTask, etag: etag as string };
    }
    if (task.id !== scope.taskId || typeof task.title !== "string" || !["needsAction", "completed"].includes(task.status)) throw invalid();
    if (task.assignmentInfo) throw new GoogleTaskProviderError("task-source-read-only");
    const etag = version(task.etag);
    return { kind: "present", task, etag };
  }
  return {
    async readForUpdate(input: GoogleTaskTarget, signal?: AbortSignal, mode: "delivery" | "mutation-preflight" = "delivery"): Promise<GoogleNativeTaskReadEvidence> {
      const scope = target(input);
      if (mode !== "delivery" && mode !== "mutation-preflight") throw invalid();
      return read(scope, await session(scope, signal), signal, mode);
    },
    async preflightUpdate(input: GoogleTaskUpdate, signal?: AbortSignal): Promise<GoogleNativeTaskUpdatePreflight> {
      const accepted = updateInput(input), current = await session(accepted.target, signal);
      const evidence = await read(accepted.target, current, signal, "delivery");
      if (evidence.kind !== "present" || evidence.etag !== accepted.acceptedEtag) throw new GoogleTaskProviderError("task-provider-conflict");
      return { kind: "allowed", read: evidence };
    },
    async update(input: GoogleTaskUpdate, signal?: AbortSignal): Promise<GoogleNativeTaskUpdateEvidence> {
      // Capture every descriptor/value and exact serialized body before refresh.
      const accepted = updateInput(input), serialized = JSON.stringify(accepted.body);
      const current = await session(accepted.target, signal);
      const evidence = await read(accepted.target, current, signal, "mutation-preflight");
      if (evidence.kind !== "present" || evidence.etag !== accepted.acceptedEtag) throw new GoogleTaskProviderError("task-provider-conflict");
      if (!Object.keys(accepted.body).length) return { kind: "not-written", reason: "empty-body" };
      await ports.beforeMutation(accepted, signal); signal?.throwIfAborted();
      const response = await request(accepted.target, current, "PATCH", signal, serialized, accepted.acceptedEtag);
      if (![200, 201, 204].includes(response.status)) throw new GoogleTaskProviderError(response.status === 412 ? "task-provider-conflict" : "task-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, retryAfter(response, ports.clock.nowEpochMs()));
      await ports.onAcceptedResponse(Object.freeze({ status: response.status as 200 | 201 | 204, validator: null }), signal);
      if (strict && (response.redirected || response.url !== "" && response.url !== taskURL(accepted.target)))
        throw new GoogleTaskProviderError("task-write-failed", "unconfirmed", response.status);
      // Do not add an ID check or require exact200 in the existing host profile.
      const updated = await response.json();
      return { kind: "written", etag: version(updated.etag) };
    },
  };
}
