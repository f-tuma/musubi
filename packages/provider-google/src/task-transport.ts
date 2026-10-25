import { strongGoogleEtag } from "./etag";
import { googleTaskDataRecord, strictGoogleTaskNativeError } from "./task-projection";
import { GoogleTaskProviderError } from "./task-types";
import type { GoogleNativeTask, GoogleNativeTaskReadEvidence, GoogleTaskAccountSession, GoogleTaskProviderPorts,
  GoogleTaskRequestMetric, GoogleTaskTarget } from "./task-types";

const ORIGIN = "https://tasks.googleapis.com/tasks/v1";
const invalid = () => new GoogleTaskProviderError("task-projection-unavailable");
export function taskExact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const item = googleTaskDataRecord(value);
  if (!item || Object.keys(item).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(item, key))) throw invalid();
  return item;
}
export function taskIdentity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw invalid();
  return value;
}
export function snapshotGoogleTaskTarget(value: unknown): GoogleTaskTarget {
  const item = taskExact(value, ["connectionId", "connectionGeneration", "taskListId", "taskId"]);
  const scope = { connectionId: taskIdentity(item.connectionId), connectionGeneration: taskIdentity(item.connectionGeneration),
    taskListId: taskIdentity(item.taskListId), taskId: taskIdentity(item.taskId) };
  try { encodeURIComponent(scope.taskListId); encodeURIComponent(scope.taskId); } catch { throw invalid(); }
  return Object.freeze(scope);
}
export function requireGoogleTaskEtag(value: unknown): string {
  const tag = strongGoogleEtag(value);
  if (tag === null) throw new GoogleTaskProviderError("task-version-unavailable");
  return tag;
}
export function taskURL(scope: GoogleTaskTarget): string {
  return `${ORIGIN}/lists/${encodeURIComponent(scope.taskListId)}/tasks/${encodeURIComponent(scope.taskId)}`;
}
export function taskRetryAfter(response: Response, epochMs: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - epochMs;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
type TaskTransportPorts<M extends "PATCH" | "DELETE"> = Pick<GoogleTaskProviderPorts, "accountSession" | "http" | "clock"> & {
  readonly telemetry: { record(metric: Omit<GoogleTaskRequestMetric, "method"> & { readonly method: "GET" | M }): void };
};

/** Package-private common transport. The generic mutation keeps the public
 * UPDATE and DELETE metric/callback contracts separate. */
export function createGoogleTaskTransport<M extends "PATCH" | "DELETE">(ports: TaskTransportPorts<M>,
  options: { readonly nativeProfile: "existing-google" | "strict-reference" }, exactAbsence = false) {
  const configuration = taskExact(options, ["nativeProfile"]), profile = configuration.nativeProfile;
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
  async function request(scope: GoogleTaskTarget, current: GoogleTaskAccountSession, method: "GET" | M, signal?: AbortSignal,
    serializedBody?: string, etag?: string): Promise<Response> {
    signal?.throwIfAborted();
    const started = ports.clock.nowMonotonicMs(); let status: number | "network-error" | "aborted" = "network-error";
    try {
      const response = await ports.http.fetch(taskURL(scope), { method, signal,
        ...(method === "GET" || strict ? { redirect: "error" as const } : {}),
        headers: { Authorization: `Bearer ${current.accessToken}`, ...(method === "GET" ? { "Cache-Control": "no-cache" } :
          method === "PATCH" ? { "Content-Type": "application/json", "If-Match": etag! } : { "If-Match": etag! }) },
        ...(serializedBody === undefined ? {} : { body: serializedBody }) });
      status = response.status; return response;
    } catch (error) {
      if (signal?.aborted || error instanceof Error && error.name === "AbortError") status = "aborted";
      throw error;
    } finally {
      try { ports.telemetry.record({ provider: "google", family: "task", method, status,
        durationMs: Math.max(0, ports.clock.nowMonotonicMs() - started) }); } catch { /* Diagnostics cannot alter native evidence. */ }
    }
  }
  function invalidScope(response: Response, scope: GoogleTaskTarget): boolean {
    return response.redirected || response.url !== "" && response.url !== taskURL(scope);
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
    if (response.status === 404 || response.status === 410) {
      if (strict && exactAbsence && (response.headers.has("content-range") || invalidScope(response, scope)))
        throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status);
      return { kind: "absent", status: response.status };
    }
    if (!response.ok) throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status, taskRetryAfter(response, ports.clock.nowEpochMs()));
    if (strict && (response.status !== 200 || response.headers.has("content-range") || invalidScope(response, scope)))
      throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status);
    const task = await response.json() as GoogleNativeTask;
    if (strict) {
      const item = googleTaskDataRecord(task), etag = item?.etag;
      const error = strictGoogleTaskNativeError(task, scope.taskId, typeof etag === "string" ? etag : "");
      if (error) throw new GoogleTaskProviderError(error);
      return { kind: "present", task: item as GoogleNativeTask, etag: etag as string };
    }
    if (task.id !== scope.taskId || typeof task.title !== "string" || !["needsAction", "completed"].includes(task.status)) throw invalid();
    if (task.assignmentInfo) throw new GoogleTaskProviderError("task-source-read-only");
    return { kind: "present", task, etag: requireGoogleTaskEtag(task.etag) };
  }
  return { strict, session, request, read, invalidScope };
}
