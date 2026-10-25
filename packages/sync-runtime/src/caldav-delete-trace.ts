import { strongCaldavEtag } from "@musubi/provider-caldav";
import type {
  CaldavRuntimeDeleteDecisionContext, CaldavRuntimeDeleteDecisionFact,
  CaldavRuntimeDeleteEvaluatedDecision, CaldavRuntimeDeleteRecordedFrame,
} from "./caldav-delete-ports";
import { SYNC_RUNTIME_SHADOW_MISMATCHES, type RuntimeShadowReport } from "./trace";

/** A conditional DAV retry uses the captured UID/address and accepted version.
 * This pure function receives no HTTP, credentials, DNS or storage capability. */
export function evaluateCaldavPersonalDeleteFact(context: CaldavRuntimeDeleteDecisionContext,
  fact: CaldavRuntimeDeleteDecisionFact): CaldavRuntimeDeleteEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "delete") return { decision: "accepted" };
  const read = fact.kind === "preflight" ? { kind: "present" as const, resource: fact.resource, etag: fact.etag } : fact.read;
  if (read.kind === "absent") return { decision: "confirmed" };
  if (read.resource.resourceUrl !== context.resourceUrl || read.resource.uid !== context.uid)
    return { decision: "conflict", reason: "resource-identity-changed" };
  if (!strongCaldavEtag(read.etag)) return { decision: "conflict", reason: "remote-validator-unavailable" };
  if (fact.kind === "readback") return { decision: "conflict", reason: "resource-present" };
  if (read.etag !== context.acceptedEtag) return { decision: "conflict", reason: "recovery-validator-changed" };
  return { decision: fact.kind === "preflight" ? "dispatch" : "preflight" };
}

export function compareCaldavPersonalDeleteShadow(context: CaldavRuntimeDeleteDecisionContext,
  frames: readonly CaldavRuntimeDeleteRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<(typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number]>();
  for (const frame of frames) {
    try {
      const actual = evaluateCaldavPersonalDeleteFact(context, frame.fact);
      if (actual.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (actual.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
