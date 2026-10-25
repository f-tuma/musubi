import { strongCaldavEtag, normalizeCaldavCreateProjection, type CaldavNativeResource } from "@musubi/provider-caldav";
import type {
  CaldavRuntimeCreateDecisionContext, CaldavRuntimeCreateDecisionFact, CaldavRuntimeCreateEvaluatedDecision,
  CaldavRuntimeCreateRecordedFrame, CaldavTimedProjection,
} from "./caldav-create-ports";
import { SYNC_RUNTIME_SHADOW_MISMATCHES, type RuntimeShadowReport } from "./trace";
export { caldavPersonalCreateIdentityV1 } from "@musubi/provider-caldav";

/** Independent reference projection; Musubi supplies its actual CREATE normalizer. */
export function projectCaldavCreatedEvent(resource: CaldavNativeResource): CaldavTimedProjection | null {
  return normalizeCaldavCreateProjection(resource);
}
function same(left: CaldavTimedProjection, right: CaldavTimedProjection): boolean {
  return (["title", "description", "location", "start", "end", "isAllDay", "recurrence"] as const).every(key => left[key] === right[key]);
}
/** Pure replay of saved native facts and normalized observations. A scoped 404
 * authorizes only a later-attempt original conditional PUT, never an overwrite. */
export function evaluateCaldavPersonalCreateFact(context: CaldavRuntimeCreateDecisionContext,
  fact: CaldavRuntimeCreateDecisionFact): CaldavRuntimeCreateEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "create") return { decision: "accepted" };
  if (fact.read.kind === "absent") return fact.kind === "recovery-read" && fact.read.status === 404
    ? { decision: "preflight" } : { decision: "conflict", reason: "resource-absent" };
  if (fact.read.resource.resourceUrl !== context.resourceUrl || fact.read.resource.uid !== context.uid)
    return { decision: "conflict", reason: "creation-identity-changed" };
  if (!fact.projection) return { decision: "conflict", reason: "profile-unavailable" };
  if (!same(context.projection, fact.projection)) return { decision: "conflict", reason: "readback-differs" };
  if (context.policy.requireStrongReadback && !strongCaldavEtag(fact.read.etag))
    return { decision: "conflict", reason: "remote-validator-unavailable" };
  return { decision: "confirmed" };
}
export function compareCaldavPersonalCreateShadow(context: CaldavRuntimeCreateDecisionContext,
  frames: readonly CaldavRuntimeCreateRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<(typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number]>();
  for (const frame of frames) {
    try {
      const actual = evaluateCaldavPersonalCreateFact(context, frame.fact);
      if (actual.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (actual.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
