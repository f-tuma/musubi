import { strongGoogleEtag, type GoogleNativeEvent } from "@musubi/provider-google";
import type {
  GooglePersonalUpdatePolicy, GoogleTimedProjection, RuntimeDecisionContext, RuntimeDecisionFact,
  RuntimeEvaluatedDecision, RuntimeRecordedFrame,
} from "./ports";

export function projectGoogleTimedEvent(event: GoogleNativeEvent, policy: GooglePersonalUpdatePolicy): GoogleTimedProjection | null {
  try {
    if (policy.nativeProfile === "strict-reference" &&
        (event.status !== undefined && !["confirmed", "tentative"].includes(event.status) ||
        event.eventType !== undefined && event.eventType !== "default")) return null;
    if (!event.start.dateTime || !event.end.dateTime || event.start.date || event.end.date ||
        event.recurringEventId || event.originalStartTime || event.recurrence?.length) return null;
    const start = new Date(event.start.dateTime).toISOString(), end = new Date(event.end.dateTime).toISOString();
    if (start > end) return null;
    return { title: event.summary ?? "(untitled)", description: event.description ?? null, location: event.location ?? null,
      start, end, isAllDay: false, recurrence: null };
  } catch { return null; }
}
function fieldEqual(key: string, left: unknown, right: unknown, policy: GooglePersonalUpdatePolicy) {
  if (policy.compareContent === "nullable-empty" && ["description", "location"].includes(key))
    return (left ?? "") === (right ?? "");
  return left === right;
}
export function matchesGoogleTimedProjection(expected: GoogleTimedProjection, observed: GoogleTimedProjection,
  policy: GooglePersonalUpdatePolicy): boolean {
  return Object.entries(expected).every(([key, value]) => fieldEqual(key, value, observed[key as keyof GoogleTimedProjection], policy));
}
/** A capability-free decision over saved admission and observed native facts. */
export function evaluateGooglePersonalUpdateFact(context: RuntimeDecisionContext, fact: RuntimeDecisionFact): RuntimeEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "write") return { decision: fact.write.kind === "written" ? "accepted" : "hold" };
  if (fact.kind === "preflight") {
    if (!context.policy.untouchedPreflight) return { decision: "dispatch" };
    const observed = projectGoogleTimedEvent(fact.event, context.policy);
    if (!observed) return { decision: "conflict", reason: "profile-unavailable" };
    const changed = new Set(Object.keys(context.body).map(key => key === "summary" ? "title" : key));
    if (context.policy.untouchedPreflight && Object.entries(context.projection).some(([key, value]) =>
      !changed.has(key) && !fieldEqual(key, value, observed[key as keyof GoogleTimedProjection], context.policy)))
      return { decision: "conflict", reason: "untouched-fields-differ" };
    return { decision: "dispatch" };
  }
  if (fact.read.kind !== "present") return { decision: "conflict", reason: fact.read.kind === "absent" ? "resource-absent" : "resource-cancelled" };
  const observed = projectGoogleTimedEvent(fact.read.event, context.policy);
  if (!strongGoogleEtag(fact.read.etag)) return { decision: "conflict", reason: "profile-unavailable" };
  if (observed && matchesGoogleTimedProjection(context.projection, observed, context.policy)) return { decision: "confirmed" };
  if (fact.kind === "recovery-read" && fact.read.etag === context.acceptedEtag &&
      (observed !== null || context.policy.nativeProfile === "existing-google")) return { decision: "preflight" };
  if (!observed) return { decision: "conflict", reason: "profile-unavailable" };
  return { decision: "conflict", reason: fact.kind === "recovery-read" ? "recovery-validator-changed" : "readback-differs" };
}
export const SYNC_RUNTIME_SHADOW_MISMATCHES = ["decision", "reason", "invalid-frame", "too-many-frames"] as const;
export interface RuntimeShadowReport {
  readonly matches: boolean;
  readonly compared: number;
  readonly mismatches: readonly (typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number][];
}
/** No host/provider capability is accepted here. Replay under the SAME policy;
 * kernel self-comparison is a smoke check, not legacy parity evidence. */
export function compareGooglePersonalUpdateShadow(context: RuntimeDecisionContext, frames: readonly RuntimeRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<(typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number]>();
  for (const frame of frames) {
    try {
      const evaluated = evaluateGooglePersonalUpdateFact(context, frame.fact);
      if (evaluated.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (evaluated.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
