import type { GoogleTaskTarget } from "@musubi/provider-google";
import type { SyncOperationEnvelope } from "@musubi/types";
import { SyncRuntimeHostError } from "./ports";
import { own, identity, baseline, sameTask } from "./task-data";
import { copyNativeTaskEvidence as nativeCopy } from "./task-native-data";
import type { GoogleTaskClaimTarget, GoogleTaskPreparation, GoogleTaskPredecessorResolution } from "./google-task-address-ports";

const invalid = (): never => { throw new SyncRuntimeHostError({ code: "task-projection-unavailable", outcome: "not-written" }); };
function optional(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) invalid();
  return descriptor?.value;
}
export function claimedTaskTarget(value: unknown, envelope: SyncOperationEnvelope, collectionIdentity: unknown): GoogleTaskClaimTarget {
  const target = { connectionId: identity(own(value, "connectionId")), connectionGeneration: identity(own(value, "connectionGeneration")),
    taskListId: identity(own(value, "taskListId")), taskId: own(value, "taskId") };
  const collection = collectionIdentity === "native" ? envelope.locator.collectionId :
    collectionIdentity === "musubi-google-task-list" && envelope.locator.collectionId.startsWith("musubi-google-task-list:")
      ? envelope.locator.collectionId.slice("musubi-google-task-list:".length) : null;
  if (target.taskListId !== collection || target.taskId !== envelope.locator.resourceId ||
      target.taskId === null && !envelope.predecessorOperationId) invalid();
  return Object.freeze({ ...target, taskId: target.taskId === null ? null : identity(target.taskId) });
}
export type PreparedTaskTarget = { readonly kind: "target"; readonly target: GoogleTaskTarget } |
  { readonly kind: "no-resource"; readonly proof: Extract<GoogleTaskPredecessorResolution, { kind: "predecessor-no-task" }> };

/** Resolve only through preparation inside the existing attempt budget. Native
 * IDs/baselines do not acquire the admitted envelope's artificial JSON limits. */
export function preparedTaskTarget(target: GoogleTaskClaimTarget, envelope: SyncOperationEnvelope, operationId: string, attemptId: string,
  prepared: GoogleTaskPreparation, profile: "existing-google" | "strict-reference"): PreparedTaskTarget {
  try { return resolvePreparedTaskTarget(target, envelope, operationId, attemptId, prepared, profile); }
  catch { return invalid(); }
}
function resolvePreparedTaskTarget(target: GoogleTaskClaimTarget, envelope: SyncOperationEnvelope, operationId: string, attemptId: string,
  prepared: GoogleTaskPreparation, profile: "existing-google" | "strict-reference"): PreparedTaskTarget {
  const raw = optional(prepared, "predecessorAddress");
  if (target.taskId !== null) {
    if (raw !== undefined) invalid();
    return { kind: "target", target: target as GoogleTaskTarget };
  }
  if (raw === undefined) invalid();
  const proof = nativeCopy(raw);
  const kind = own(proof, "kind"), required = ["kind", "operationId", "attemptId", "predecessorOperationId", "evidenceOperationId", "witness",
    ...(kind === "predecessor-task-reference" ? ["taskId", "validator", "projectionBaseline"] : [])];
  if (kind !== "predecessor-task-reference" && kind !== "predecessor-no-task" || Reflect.ownKeys(proof as object).length !== required.length ||
      required.some(key => !Object.prototype.hasOwnProperty.call(proof, key)) || own(proof, "operationId") !== operationId ||
      own(proof, "attemptId") !== attemptId || own(proof, "predecessorOperationId") !== envelope.predecessorOperationId ||
      identity(own(proof, "evidenceOperationId")) === operationId || !identity(own(proof, "witness"))) invalid();
  if (kind === "predecessor-no-task") {
    if (profile !== "existing-google" || own(prepared, "acceptedEtag") !== null || own(prepared, "baseline") !== null || optional(prepared, "saved") != null) invalid();
    return { kind: "no-resource", proof: proof as Extract<GoogleTaskPredecessorResolution, { kind: "predecessor-no-task" }> };
  }
  const taskId = own(proof, "taskId"), validator = own(proof, "validator"), rawBaseline = own(proof, "projectionBaseline");
  if (typeof taskId !== "string" || !taskId || profile === "strict-reference" && taskId.length > 2048 ||
      profile === "strict-reference" && rawBaseline === null || validator !== null && typeof validator !== "string" || validator !== own(prepared, "acceptedEtag")) invalid();
  const pairedBaseline = rawBaseline === null ? null : baseline(rawBaseline), preparedBaseline = own(prepared, "baseline");
  if (pairedBaseline === null ? preparedBaseline !== null : preparedBaseline == null || !sameTask(pairedBaseline, baseline(preparedBaseline))) invalid();
  const saved = optional(prepared, "saved");
  if (saved != null && pairedBaseline !== null && !sameTask(pairedBaseline, baseline(own(saved, "baseline")))) invalid();
  try { encodeURIComponent(taskId as string); } catch { invalid(); }
  return { kind: "target", target: nativeCopy({ ...target, taskId: taskId as string }) };
}
