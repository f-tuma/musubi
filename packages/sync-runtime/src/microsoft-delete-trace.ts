import { nativeMicrosoftEtag } from "@musubi/provider-microsoft";
import type {
  MicrosoftRuntimeDeleteDecisionContext, MicrosoftRuntimeDeleteDecisionFact,
  MicrosoftRuntimeDeleteEvaluatedDecision, MicrosoftRuntimeDeleteRecordedFrame,
} from "./microsoft-delete-ports";
import { SYNC_RUNTIME_SHADOW_MISMATCHES, type RuntimeShadowReport } from "./trace";

/** Pure replay accepts saved facts only, never credentials or write capabilities. */
export function evaluateMicrosoftPersonalDeleteFact(context: MicrosoftRuntimeDeleteDecisionContext,
  fact: MicrosoftRuntimeDeleteDecisionFact): MicrosoftRuntimeDeleteEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "delete") return { decision: "accepted" };
  const read = fact.kind === "preflight" ? { kind: "present" as const, event: fact.event, etag: fact.etag } : fact.read;
  if (read.kind === "absent") return { decision: "confirmed" };
  // A present resource after possible dispatch is never fresh DELETE authority,
  // even if its native weak ETag is identical to the admitted version.
  if (fact.kind === "readback") return { decision: "hold", reason: "resource-present" };
  if (context.observeOnly) return { decision: "hold", reason: "possible-dispatch-present" };
  if (!nativeMicrosoftEtag(read.etag)) return { decision: "conflict", reason: "remote-validator-unavailable" };
  if (read.etag !== context.acceptedEtag) return { decision: "conflict", reason: "recovery-validator-changed" };
  return { decision: fact.kind === "preflight" ? "dispatch" : "preflight" };
}

export function compareMicrosoftPersonalDeleteShadow(context: MicrosoftRuntimeDeleteDecisionContext,
  frames: readonly MicrosoftRuntimeDeleteRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<(typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number]>();
  for (const frame of frames) {
    try {
      const actual = evaluateMicrosoftPersonalDeleteFact(context, frame.fact);
      if (actual.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (actual.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
