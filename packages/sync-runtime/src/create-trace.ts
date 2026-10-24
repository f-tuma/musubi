import { strongGoogleEtag } from "@musubi/provider-google";
import type { RuntimeCreateDecisionContext, RuntimeCreateDecisionFact, RuntimeCreateEvaluatedDecision, RuntimeCreateRecordedFrame } from "./create-ports";
import { matchesGoogleTimedProjection, projectGoogleTimedEvent, type RuntimeShadowReport } from "./trace";

/** CREATE v1 refines opaque operation identity only for this admitted profile. */
export function googlePersonalCreateIdentityV1(value: unknown): { operationId: string; eventId: string } | null {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return null;
  return { operationId: value, eventId: `musubi${value.replace(/-/g, "")}` };
}

/** Pure replay over admitted identity/content and native facts; no capabilities. */
export function evaluateGooglePersonalCreateFact(context: RuntimeCreateDecisionContext, fact: RuntimeCreateDecisionFact): RuntimeCreateEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "create") return { decision: "accepted" };
  if (fact.read.kind === "absent") return fact.kind === "recovery-read" && fact.read.status === 404
    ? { decision: "preflight" } : { decision: "conflict", reason: "resource-absent" };
  const { event } = fact.read;
  if (event.id !== context.eventId || event.extendedProperties?.private?.musubiOperationID !== context.operationId)
    return { decision: "conflict", reason: "creation-identity-changed" };
  const projection = projectGoogleTimedEvent(event, context.policy);
  if (!projection || context.policy.nativeProfile === "strict-reference" &&
    (event.attendeesOmitted === true || event.attendees?.some(attendee => !attendee.self && !attendee.organizer)))
    return { decision: "conflict", reason: "profile-unavailable" };
  if (!matchesGoogleTimedProjection(context.projection, projection, context.policy)) return { decision: "conflict", reason: "readback-differs" };
  if (context.policy.requireStrongReadback && !strongGoogleEtag(fact.read.etag))
    return { decision: "conflict", reason: "remote-validator-unavailable" };
  return { decision: "confirmed" };
}

export function compareGooglePersonalCreateShadow(context: RuntimeCreateDecisionContext, frames: readonly RuntimeCreateRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<"decision" | "reason" | "invalid-frame">();
  for (const frame of frames) {
    try {
      const result = evaluateGooglePersonalCreateFact(context, frame.fact);
      if (result.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (result.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
