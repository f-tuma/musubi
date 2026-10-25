import { GoogleTaskProviderError } from "./task-types";
import { createGoogleTaskTransport, taskExact, taskIdentity, snapshotGoogleTaskTarget, requireGoogleTaskEtag, taskRetryAfter } from "./task-transport";
import { isGoogleTaskDeleteAcceptedStatus } from "./task-delete-types";
import type { GoogleTaskDelete, GoogleTaskDeleteProviderPorts, GoogleNativeTaskDeleteReadEvidence,
  GoogleNativeTaskDeletePreflight, GoogleNativeTaskDeleteEvidence, GoogleNativeTaskDeleteResponse } from "./task-delete-types";
import type { GoogleTaskTarget } from "./task-types";

function deleteInput(value: unknown): GoogleTaskDelete {
  const item = taskExact(value, ["target", "acceptedEtag", "operationId", "attemptId", "serializer"]);
  const serializer = taskExact(item.serializer, ["id", "version"]);
  if (serializer.id !== "google-task" || serializer.version !== 1) throw new GoogleTaskProviderError("task-projection-unavailable");
  return Object.freeze({ target: snapshotGoogleTaskTarget(item.target), acceptedEtag: requireGoogleTaskEtag(item.acceptedEtag),
    operationId: taskIdentity(item.operationId), attemptId: taskIdentity(item.attemptId),
    serializer: Object.freeze({ id: "google-task" as const, version: 1 as const }) });
}
/** Addressed conditional DELETE. Native HTTP fulfillment and scoped absence
 * remain distinct from host mapping retirement or canonical task deletion. */
export function createGoogleTaskDeleteProvider(ports: GoogleTaskDeleteProviderPorts,
  options: { readonly nativeProfile: "existing-google" | "strict-reference" }) {
  const { strict, session, request, read, invalidScope } = createGoogleTaskTransport<"DELETE">(ports, options, true);
  return {
    async readForDelete(input: GoogleTaskTarget, signal?: AbortSignal, mode: "delivery" | "mutation-preflight" = "delivery"): Promise<GoogleNativeTaskDeleteReadEvidence> {
      const scope = snapshotGoogleTaskTarget(input);
      if (mode !== "delivery" && mode !== "mutation-preflight") throw new GoogleTaskProviderError("task-projection-unavailable");
      return read(scope, await session(scope, signal), signal, mode);
    },
    async preflightDelete(input: GoogleTaskDelete, signal?: AbortSignal): Promise<GoogleNativeTaskDeletePreflight> {
      const accepted = deleteInput(input), current = await session(accepted.target, signal);
      const evidence = await read(accepted.target, current, signal, "delivery");
      // The existing API continues to the writer's final fresh GET even here.
      if (evidence.kind === "absent") return evidence;
      if (evidence.etag !== accepted.acceptedEtag) throw new GoogleTaskProviderError("task-provider-conflict");
      return { kind: "allowed", read: evidence };
    },
    async delete(input: GoogleTaskDelete, signal?: AbortSignal): Promise<GoogleNativeTaskDeleteEvidence> {
      const accepted = deleteInput(input), current = await session(accepted.target, signal);
      const evidence = await read(accepted.target, current, signal, "mutation-preflight");
      if (evidence.kind === "absent") return { kind: "absent", status: evidence.status, source: "writer-read" };
      if (evidence.etag !== accepted.acceptedEtag) throw new GoogleTaskProviderError("task-provider-conflict");
      await ports.beforeMutation(accepted, signal); signal?.throwIfAborted();
      const response = await request(accepted.target, current, "DELETE", signal, undefined, accepted.acceptedEtag);
      let receipt: GoogleNativeTaskDeleteResponse;
      if (isGoogleTaskDeleteAcceptedStatus(response.status)) receipt = { kind: "accepted", status: response.status, validator: null };
      else if (response.status === 404 || response.status === 410) receipt = { kind: "absent", status: response.status };
      else throw new GoogleTaskProviderError(response.status === 412 ? "task-provider-conflict" : "task-write-failed",
        response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status, taskRetryAfter(response, ports.clock.nowEpochMs()));
      // No body/tag parsing or hidden observation occurs after this response.
      await ports.onDeleteResponse(Object.freeze(receipt), signal);
      if (strict && invalidScope(response, accepted.target)) throw new GoogleTaskProviderError("task-write-failed", "unconfirmed", response.status);
      return receipt.kind === "accepted" ? { kind: "deleted", status: receipt.status } : { kind: "absent", status: receipt.status, source: "delete-response" };
    },
  };
}
