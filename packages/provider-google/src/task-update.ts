import { parseGoogleTaskPatch } from "./task-projection";
import { GoogleTaskProviderError } from "./task-types";
import { createGoogleTaskTransport, taskExact as exact, taskIdentity as identity, snapshotGoogleTaskTarget as target,
  requireGoogleTaskEtag as version, taskURL, taskRetryAfter as retryAfter } from "./task-transport";
import type { GoogleNativeTaskReadEvidence, GoogleNativeTaskUpdateEvidence, GoogleNativeTaskUpdatePreflight,
  GoogleTaskProviderPorts, GoogleTaskTarget, GoogleTaskUpdate } from "./task-types";

const invalid = () => new GoogleTaskProviderError("task-projection-unavailable");
function updateInput(value: unknown): GoogleTaskUpdate {
  const item = exact(value, ["target", "acceptedEtag", "body", "operationId", "attemptId", "serializer"]);
  const serializer = exact(item.serializer, ["id", "version"]);
  if (serializer.id !== "google-task" || serializer.version !== 1) throw invalid();
  const scope = target(item.target), acceptedEtag = version(item.acceptedEtag), body = parseGoogleTaskPatch(item.body);
  if (body === null) throw invalid();
  return Object.freeze({ target: scope, acceptedEtag, body, operationId: identity(item.operationId), attemptId: identity(item.attemptId),
    serializer: Object.freeze({ id: "google-task" as const, version: 1 as const }) });
}

/** Native Google Tasks only. Canonical authority, OAuth storage and ACK remain host-owned. */
export function createGoogleTaskUpdateProvider(ports: GoogleTaskProviderPorts,
  options: { readonly nativeProfile: "existing-google" | "strict-reference" }) {
  const { strict, session, request, read } = createGoogleTaskTransport<"PATCH">(ports, options);
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
