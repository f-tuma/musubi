import { strongGoogleEtag, type GoogleNativeEvent } from "@musubi/provider-google";
import type {
  GooglePersonalDeletePolicy, RuntimeDeleteDecisionContext, RuntimeDeleteDecisionFact,
  RuntimeDeleteEvaluatedDecision, RuntimeDeleteRecordedFrame,
} from "./delete-ports";
import { SYNC_RUNTIME_SHADOW_MISMATCHES, type RuntimeShadowReport } from "./trace";

function profile(event: GoogleNativeEvent, policy: GooglePersonalDeletePolicy): boolean {
  if (event.recurringEventId || event.originalStartTime || event.recurrence?.length) return false;
  if (policy.nativeProfile === "existing-google") return true;
  const start = Date.parse(event.start.dateTime ?? ""), end = Date.parse(event.end.dateTime ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && start <= end &&
    !!event.start.dateTime && !!event.end.dateTime && !event.start.date && !event.end.date &&
    (event.status === undefined || ["confirmed", "tentative"].includes(event.status)) &&
    (event.eventType === undefined || event.eventType === "default");
}
/** Evaluates saved native facts only; no host, credentials, HTTP or storage capability is accepted. */
export function evaluateGooglePersonalDeleteFact(context: RuntimeDeleteDecisionContext, fact: RuntimeDeleteDecisionFact): RuntimeDeleteEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "delete") return { decision: "accepted" };
  const read = fact.kind === "preflight" ? { kind: "present" as const, event: fact.event, etag: fact.etag } : fact.read;
  if (read.kind !== "present") return { decision: "confirmed" };
  if (!strongGoogleEtag(read.etag)) return { decision: "conflict", reason: "remote-validator-unavailable" };
  if (fact.kind === "readback") return { decision: "conflict", reason: "resource-present" };
  if (read.etag !== context.acceptedEtag) return { decision: "conflict", reason: "recovery-validator-changed" };
  if (!profile(read.event, context.policy)) return { decision: "conflict", reason: "profile-unavailable" };
  return { decision: fact.kind === "preflight" ? "dispatch" : "preflight" };
}
/** Pure replay under the same captured policy. Self-comparison is not legacy parity evidence. */
export function compareGooglePersonalDeleteShadow(context: RuntimeDeleteDecisionContext, frames: readonly RuntimeDeleteRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<(typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number]>();
  for (const frame of frames) {
    try {
      const evaluated = evaluateGooglePersonalDeleteFact(context, frame.fact);
      if (evaluated.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (evaluated.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
