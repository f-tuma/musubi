import { dispatchNativeHttp } from "./http-dispatch";
import { strongGoogleEtag } from "./etag";
import { googleTaskDataRecord, parseGoogleTaskProjection, strictGoogleTaskNativeError } from "./task-projection";
import { requireGoogleTaskEtag, taskExact, taskIdentity, taskRetryAfter } from "./task-transport";
import { GoogleTaskProviderError } from "./task-types";
import type { GoogleNativeTask, GoogleNativeTaskReadEvidence, GoogleTaskAccountSession, GoogleTaskTarget } from "./task-types";
import type { GoogleNativeTaskCreateEvidence, GoogleNativeTaskCreatePreflight, GoogleTaskCreate, GoogleTaskCreateProviderPorts, GoogleTaskCreateTarget } from "./task-create-types";

const ORIGIN = "https://tasks.googleapis.com/tasks/v1";
const invalid = () => new GoogleTaskProviderError("task-projection-unavailable");
function createTarget(value: unknown): GoogleTaskCreateTarget {
  const item = taskExact(value, ["connectionId", "connectionGeneration", "taskListId"]);
  const target = { connectionId: taskIdentity(item.connectionId), connectionGeneration: taskIdentity(item.connectionGeneration), taskListId: taskIdentity(item.taskListId) };
  try { encodeURIComponent(target.taskListId); } catch { throw invalid(); }
  return Object.freeze(target);
}
function createInput(value: unknown): GoogleTaskCreate {
  const item = taskExact(value, ["target", "body", "operationId", "attemptId", "serializer"]);
  const serializer = taskExact(item.serializer, ["id", "version"]), body = parseGoogleTaskProjection(item.body);
  if (serializer.id !== "google-task" || serializer.version !== 1 || body === null) throw invalid();
  return Object.freeze({ target: createTarget(item.target), body, operationId: taskIdentity(item.operationId), attemptId: taskIdentity(item.attemptId),
    serializer: Object.freeze({ id: "google-task" as const, version: 1 as const }) });
}

/** Generated-address Tasks CREATE. The host owns durable acceptance/address
 * storage and decides whether its recovery policy may observe a candidate ID. */
export function createGoogleTaskCreateProvider(ports: GoogleTaskCreateProviderPorts,
  options: { readonly nativeProfile: "existing-google" | "strict-reference" }) {
  const configuration = taskExact(options, ["nativeProfile"]), profile = configuration.nativeProfile;
  if (profile !== "existing-google" && profile !== "strict-reference") throw invalid();
  const strict = profile === "strict-reference";
  function readTarget(value: unknown): GoogleTaskTarget {
    const item = taskExact(value, ["connectionId", "connectionGeneration", "taskListId", "taskId"]);
    const target = createTarget({ connectionId: item.connectionId, connectionGeneration: item.connectionGeneration, taskListId: item.taskListId });
    // Existing CREATE only checked a nonempty response ID. Applying the bounded
    // addressed-writer ID parser here would narrow its subsequent read floor.
    if (typeof item.taskId !== "string" || !item.taskId || strict && item.taskId.length > 2048) throw invalid();
    return Object.freeze({ ...target, taskId: item.taskId });
  }
  const collectionURL = (scope: GoogleTaskCreateTarget) => `${ORIGIN}/lists/${encodeURIComponent(scope.taskListId)}/tasks`;
  const resourceURL = (scope: GoogleTaskTarget) => `${collectionURL(scope)}/${encodeURIComponent(scope.taskId)}`;
  function checkedSession(value: GoogleTaskAccountSession, scope: GoogleTaskCreateTarget): GoogleTaskAccountSession {
    const item = googleTaskDataRecord(value);
    if (!item || item.connectionId !== scope.connectionId || item.connectionGeneration !== scope.connectionGeneration)
      throw new GoogleTaskProviderError("account-session-changed");
    if (typeof item.accessToken !== "string" || !item.accessToken || item.accessToken.length > 2_000_000) throw new GoogleTaskProviderError("task-write-failed");
    if (item.taskWriteAllowed !== true) throw new GoogleTaskProviderError("task-scope-missing");
    return Object.freeze({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration, accessToken: item.accessToken, taskWriteAllowed: true });
  }
  async function session(scope: GoogleTaskCreateTarget, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const current = await ports.accountSession.open({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, signal);
    signal?.throwIfAborted(); return checkedSession(current, scope);
  }
  async function request(url: string, current: GoogleTaskAccountSession, method: "GET" | "POST", signal?: AbortSignal, serialized?: string): Promise<Response> {
    signal?.throwIfAborted();
    try {
      const response = await dispatchNativeHttp(ports.http, String(url), { method, signal, ...(method === "GET" || strict ? { redirect: "error" as const } : {}),
        headers: { Authorization: `Bearer ${current.accessToken}`, ...(method === "GET" ?
          strict || !url.startsWith(`${ORIGIN}/users/@me/lists/`) ? { "Cache-Control": "no-cache" } : {} : { "Content-Type": "application/json" }) },
        ...(serialized === undefined ? {} : { body: serialized }) }, (requestInit) => ports.http.fetch(url, requestInit), ports.clock, (status, durationMs) => ports.telemetry.record({ provider: "google", family: "task", method, status, durationMs }));
      return response;
    } catch (error) {
      if (ports.http.isDispatchDeferred?.(error)) throw error;
      throw error;
    }
  }
  const invalidScope = (response: Response, url: string) => response.redirected || response.url !== "" && response.url !== url;
  async function readRequest(url: string, scope: GoogleTaskCreateTarget, current: GoogleTaskAccountSession, signal: AbortSignal | undefined,
    mode: "delivery" | "mutation-preflight") {
    let response = await request(url, current, "GET", signal);
    if (response.status === 401 && mode === "delivery" && ports.accountSession.recoverRejectedRead) {
      await response.body?.cancel(); signal?.throwIfAborted();
      const recovered = await ports.accountSession.recoverRejectedRead({ connectionId: scope.connectionId, connectionGeneration: scope.connectionGeneration }, current.accessToken, signal);
      signal?.throwIfAborted(); response = await request(url, checkedSession(recovered, scope), "GET", signal);
      if (response.status === 401) {
        await response.body?.cancel();
        if (ports.accountSession.onReadAuthenticationRejected) return await ports.accountSession.onReadAuthenticationRejected(signal);
        throw new GoogleTaskProviderError("task-write-failed", "not-written", 401);
      }
    }
    return response;
  }
  function completeRead(response: Response, url: string) {
    if (!response.ok) throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status, taskRetryAfter(response, ports.clock.nowEpochMs()));
    if (strict && (response.status !== 200 || response.headers.has("content-range") || invalidScope(response, url)))
      throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status);
  }
  return {
    async preflightCreate(input: GoogleTaskCreate, signal?: AbortSignal): Promise<GoogleNativeTaskCreatePreflight> {
      const accepted = createInput(input), current = await session(accepted.target, signal);
      const url = `${ORIGIN}/users/@me/lists/${encodeURIComponent(accepted.target.taskListId)}`;
      const response = await readRequest(url, accepted.target, current, signal, "delivery");
      completeRead(response, url);
      const value = await response.json();
      if ((strict ? googleTaskDataRecord(value)?.id : value.id) !== accepted.target.taskListId) throw invalid();
      return { kind: "allowed" };
    },
    async create(input: GoogleTaskCreate, signal?: AbortSignal): Promise<GoogleNativeTaskCreateEvidence> {
      // Own all values and the exact serialized body before credential refresh.
      const accepted = createInput(input), serialized = JSON.stringify(accepted.body);
      const current = await session(accepted.target, signal);
      await ports.beforeMutation(accepted, signal); signal?.throwIfAborted();
      const url = collectionURL(accepted.target), response = await request(url, current, "POST", signal, serialized);
      if (![200, 201, 204].includes(response.status)) throw new GoogleTaskProviderError(response.status === 412 ? "task-provider-conflict" : "task-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, taskRetryAfter(response, ports.clock.nowEpochMs()));
      await ports.onAcceptedResponse(Object.freeze({ status: response.status as 200 | 201 | 204, validator: null }), signal);
      if (strict && (response.headers.has("content-range") || invalidScope(response, url))) throw new GoogleTaskProviderError("task-write-failed", "unconfirmed", response.status);
      const value = await response.json(), created = strict ? googleTaskDataRecord(value) : value;
      if (typeof created?.id !== "string" || !created.id || strict && created.id.length > 2048) throw new GoogleTaskProviderError("task-write-failed", "unconfirmed");
      if (strict) { try { encodeURIComponent(created.id); } catch { throw new GoogleTaskProviderError("task-write-failed", "unconfirmed"); } }
      const taskId = created.id, etag = created.etag;
      await ports.onResponseAddress(Object.freeze({ taskId, validator: strongGoogleEtag(etag) }), signal);
      return { kind: "created", taskId, etag: requireGoogleTaskEtag(etag) };
    },
    async readForCreate(input: GoogleTaskTarget, signal?: AbortSignal, mode: "delivery" | "mutation-preflight" = "delivery"): Promise<GoogleNativeTaskReadEvidence> {
      const scope = readTarget(input);
      if (mode !== "delivery" && mode !== "mutation-preflight") throw invalid();
      const current = await session(scope, signal), url = resourceURL(scope);
      const response = await readRequest(url, scope, current, signal, mode);
      if (response.status === 404 || response.status === 410) {
        if (strict && (response.headers.has("content-range") || invalidScope(response, url))) throw new GoogleTaskProviderError("task-write-failed", "not-written", response.status);
        return { kind: "absent", status: response.status };
      }
      completeRead(response, url);
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
    },
  };
}
