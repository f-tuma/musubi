import { SyncCodecError, type NativeWritePlanV1, type SyncCodecJsonObject, type CaldavPropertyPlanV1 } from "@musubi/sync-codec";

/** Select only admitted native values. Late task baselines may choose fields,
 * but neither a mapper nor a current canonical object can supply their values.
 */
export function pinnedJsonBodyV1(plan: NativeWritePlanV1, keys?: readonly string[]): SyncCodecJsonObject {
  if (plan.planKind !== "json-body" || plan.body === null) throw new SyncCodecError("invalid-native-plan");
  if (!keys) return plan.body;
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(plan.body, key))) throw new SyncCodecError("invalid-native-plan");
  return Object.fromEntries(keys.map(key => [key, plan.body![key]]));
}

export function pinnedCaldavPlanV1(plan: NativeWritePlanV1, component: "VEVENT" | "VTODO", uid?: string): CaldavPropertyPlanV1 {
  if (plan.planKind !== "caldav-properties" || plan.component !== component || uid !== undefined && plan.uid !== uid)
    throw new SyncCodecError("invalid-native-plan");
  return plan;
}
