import { nativeMicrosoftEtag, type MicrosoftNativeEvent } from "@musubi/provider-microsoft";
import type {
  MicrosoftRuntimeCreateDecisionContext, MicrosoftRuntimeCreateDecisionFact,
  MicrosoftRuntimeCreateEvaluatedDecision, MicrosoftRuntimeCreateRecordedFrame, MicrosoftTimedProjection,
} from "./microsoft-create-ports";
import { SYNC_RUNTIME_SHADOW_MISMATCHES, type RuntimeShadowReport } from "./trace";

/** CREATE v1 binds transactionId to the original admitted canonical UUID. */
export function microsoftPersonalCreateIdentityV1(value: unknown): { operationId: string } | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? { operationId: value } : null;
}
function own(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, name);
  return field && "value" in field ? field.value : undefined;
}
function date(value: unknown): string | null {
  const raw = own(value, "dateTime");
  if (own(value, "timeZone") !== "UTC" || typeof raw !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z?$/.test(raw)) return null;
  const normalized = raw.replace(/(\.\d{3})\d*/, "$1");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== raw.slice(0, 19)) return null;
  return parsed.toISOString();
}
/** Independent reference projection. The provider establishes the strict native
 * personal profile; Musubi instead supplies its actual existing normalizer port. */
export function projectMicrosoftCreatedEvent(event: MicrosoftNativeEvent): MicrosoftTimedProjection | null {
  const title = own(event, "subject"), body = own(event, "body"), location = own(event, "location"),
    description = own(body, "content"), place = own(location, "displayName"), start = date(own(event, "start")), end = date(own(event, "end"));
  if (typeof title !== "string" || own(body, "contentType") !== "text" || typeof description !== "string" || typeof place !== "string" ||
      own(event, "isAllDay") !== false || own(event, "recurrence") !== null || !start || !end || start > end) return null;
  return Object.freeze({ title, description: description.trim() || null, location: place.trim() || null,
    start, end, isAllDay: false, recurrence: null });
}
function same(left: MicrosoftTimedProjection, right: MicrosoftTimedProjection): boolean {
  return (["title", "description", "location", "start", "end", "isAllDay", "recurrence"] as const).every(key => left[key] === right[key]);
}

/** Pure replay of normalized saved observations; no credentials, storage or transport. */
export function evaluateMicrosoftPersonalCreateFact(context: MicrosoftRuntimeCreateDecisionContext,
  fact: MicrosoftRuntimeCreateDecisionFact): MicrosoftRuntimeCreateEvaluatedDecision {
  if (fact.kind === "failure") {
    if (fact.error.code === "provider-conflict") return { decision: "conflict", reason: "native-rejection" };
    if (fact.error.phase === "mutation" && fact.error.outcome === "unconfirmed")
      return { decision: context.policy.ambiguousRecovery === "within-attempt" ? "observe" : "uncertain" };
    return { decision: "hold", reason: "native-rejection" };
  }
  if (fact.kind === "create") return { decision: "accepted" };
  if (fact.read.kind === "missing") return { decision: "hold", reason: "create-outcome-unknown" };
  if (fact.read.event.transactionId !== context.operationId ||
      context.candidateEventId !== null && fact.read.event.id !== context.candidateEventId)
    return { decision: "conflict", reason: "creation-identity-changed" };
  if (!fact.projection) return { decision: "conflict", reason: "profile-unavailable" };
  if (!same(context.projection, fact.projection)) return { decision: "conflict", reason: "readback-differs" };
  if (context.policy.nativeProfile === "strict-reference" && fact.read.etag !== null && !nativeMicrosoftEtag(fact.read.etag))
    return { decision: "conflict", reason: "remote-validator-unavailable" };
  return { decision: "confirmed" };
}
export function compareMicrosoftPersonalCreateShadow(context: MicrosoftRuntimeCreateDecisionContext,
  frames: readonly MicrosoftRuntimeCreateRecordedFrame[]): RuntimeShadowReport {
  if (!Array.isArray(frames) || frames.length > 32) return { matches: false, compared: 0, mismatches: ["too-many-frames"] };
  const mismatches = new Set<(typeof SYNC_RUNTIME_SHADOW_MISMATCHES)[number]>();
  for (const frame of frames) {
    try {
      const actual = evaluateMicrosoftPersonalCreateFact(context, frame.fact);
      if (actual.decision !== frame.authoritative.decision) mismatches.add("decision");
      if (actual.reason !== frame.authoritative.reason) mismatches.add("reason");
    } catch { mismatches.add("invalid-frame"); }
  }
  return { matches: mismatches.size === 0, compared: frames.length, mismatches: [...mismatches] };
}
