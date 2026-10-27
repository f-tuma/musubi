import { OccurrenceStartSchema, type EventTimeModel } from "./event_time";
import { z } from "zod";
import { ProviderEventStateSchema, type ProviderEventState } from "./provider-event-state";
import { WireInstantSchema } from "./wire_primitives";
const ProviderRsvpCommonSchema = z.object({
  operationID: z.uuid().transform(value => value.toLowerCase()),
  expectedRevision: z.number().int().positive(),
  expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
  response: z.enum(["accepted", "tentative", "declined"]),
});
export const ProviderRsvpEditSchema = z.discriminatedUnion("provider", [
  ProviderRsvpCommonSchema.extend({ provider: z.literal("google"), sendUpdates: z.literal("all") }).strict(),
  ProviderRsvpCommonSchema.extend({ provider: z.literal("microsoft"), notificationPolicy: z.literal("send-response"), scope: z.enum(["occurrence", "series"]).optional(), expectedSeriesVersion: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict().refine(value => (value.scope === "series") === !!value.expectedSeriesVersion, "A series response requires its exact preview version"),
  ProviderRsvpCommonSchema.extend({ provider: z.literal("caldav"), notificationPolicy: z.literal("server-reply") }).strict(),
]);
export type ProviderRsvpEdit = z.infer<typeof ProviderRsvpEditSchema>;
/** Private accepted parent/slot binding for an already materialized instance. */
export const ProviderRsvpInstanceSchema = z.object({
  seriesID: z.uuid(), parentRevision: z.number().int().positive(), parentMappingID: z.uuid(),
  externalSeriesID: z.string().min(1),
  originalStart: OccurrenceStartSchema.refine(value => value.kind !== "floating"),
}).strict();
export type ProviderRsvpInstance = z.infer<typeof ProviderRsvpInstanceSchema>;
/** Graph calendarView materializes attendee copies without a local master. */
export const GraphRsvpOccurrenceSchema = z.object({
  externalSeriesID: z.string().min(1),
  originalStart: OccurrenceStartSchema.refine(value => value.kind === "instant"),
}).strict();
export type GraphRsvpOccurrence = z.infer<typeof GraphRsvpOccurrenceSchema>;
/** Private outbox payload. Native raw evidence never belongs in a public DTO. */
export type ProviderRsvpIntent = {
  request: ProviderRsvpEdit;
  baseline: Record<string, unknown>;
  nativeTime?: EventTimeModel;
  instance?: ProviderRsvpInstance;
  graphOccurrence?: GraphRsvpOccurrence;
  baselineState: ProviderEventState;
  desiredState: ProviderEventState;
  mappingID: string;
  googleDelivery?: z.infer<typeof GoogleRsvpDeliverySchema>;
  caldavDelivery?: z.infer<typeof CaldavRsvpDeliverySchema>;
  graphDispatch?: { kind: "graph-rsvp-dispatch"; version: 1; startedAt: string; acceptedAt?: string };
};
export function providerRsvpDesiredState(input: ProviderEventState, copyEmail: string, response: ProviderRsvpEdit["response"]): ProviderEventState {
  const state = ProviderEventStateSchema.parse(input);
  const self = state.attendees.filter(item => item.self === true);
  if (state.provider !== "google" || !state.attendeesComplete || self.length !== 1 || !self[0]!.address || self[0]!.address.toLowerCase() !== copyEmail.toLowerCase() || state.isOrganizer === true || !state.organizer?.address || state.organizer.address.toLowerCase() === copyEmail.toLowerCase())
    throw new Error("Unsupported provider RSVP identity");
  self[0]!.response = response; state.ownResponse = response;
  return state;
}

/** CalDAV keeps provider-native PARTSTAT spellings and imported state. The
 * principal/self identity is proven separately by fresh scheduling preflight. */
export function caldavRsvpDesiredState(input: ProviderEventState, selfAddress: string, response: ProviderRsvpEdit["response"]): ProviderEventState {
  const state = ProviderEventStateSchema.parse(input);
  const own = selfAddress.toLowerCase();
  const matches = state.attendees.filter(item => item.address?.toLowerCase() === own);
  if (state.provider !== "caldav" || !state.attendeesComplete || matches.length !== 1 || !own.startsWith("mailto:") || !state.organizer?.address || state.organizer.address.toLowerCase() === own || state.isOrganizer === true) throw new Error("Unsupported CalDAV RSVP identity");
  if (matches[0]!.response?.toUpperCase() !== response.toUpperCase()) matches[0]!.response = response.toUpperCase();
  return state;
}
export type CaldavRsvpConfirmation = { resourceHash: string; selfAddress: string } & (
  { mode?: "strict"; scheduleTag: string } |
  { mode: "icloud-oneoff-attendee"; scheduleTag: null }
);

/** Destination eligibility only; never permission to write or proof of identity. */
export function isIcloudRsvpDestination(accountServerURL: string, calendarURL: string, resourceURL: string): boolean {
  try {
    const urls = [accountServerURL, calendarURL, resourceURL].map(value => new URL(value));
    if (!urls.every(url => url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^(?:caldav|p[0-9]+-caldav)\.icloud\.com$/.test(url.hostname)
      && url.pathname.split("/").every(part => {
        const decoded = decodeURIComponent(part);
        return decoded !== "." && decoded !== ".." && !/[\\/%\u0000-\u0020\u007f]/.test(decoded);
      }))) return false;
    const [, calendar, resource] = urls;
    return calendar!.origin === resource!.origin && calendar!.pathname.endsWith("/")
      && resource!.pathname.startsWith(calendar!.pathname) && resource!.pathname.length > calendar!.pathname.length;
  } catch { return false; }
}

/** Acceptance of a private intent; notification delivery remains unknowable. */
export const ProviderRsvpReceiptSchema = z.object({
  operationID: z.uuid(),
  replayed: z.boolean(),
  status: z.enum(["pending", "attempting", "completed", "not-needed", "not-written", "conflict", "unconfirmed", "retry", "blocked", "cancelled"]),
  localCommitted: z.literal(true),
  notificationDelivery: z.literal("unknown"),
}).strict();
export type ProviderRsvpReceiptResponse = z.infer<typeof ProviderRsvpReceiptSchema>;

export function microsoftRsvpDesiredState(input: ProviderEventState, selfAddress: string, response: ProviderRsvpEdit["response"]): ProviderEventState {
  const state = ProviderEventStateSchema.parse(input);
  const own = selfAddress.toLowerCase(), self = state.attendees.filter(item => item.address?.toLowerCase() === own);
  if (state.provider !== "microsoft" || !state.attendeesComplete || state.isOrganizer !== false || !["singleInstance", "occurrence", "exception"].includes(state.eventType ?? "") || state.status !== "active" || self.length !== 1 || self[0]!.role === "resource" || !state.organizer?.address || state.organizer.address.toLowerCase() === own) throw new Error("Unsupported Graph RSVP identity");
  const native = response === "tentative" ? "tentativelyAccepted" : response;
  self[0]!.response = native; state.ownResponse = native;
  return state;
}
/** Whole-series responses preserve existing exception replies. A selected
 * exception is still the source anchor, not the master response being edited. */
export function microsoftRsvpTargetDesiredState(input: ProviderEventState, selfAddress: string, response: ProviderRsvpEdit["response"], series = false): ProviderEventState {
  const desired = microsoftRsvpDesiredState(input, selfAddress, response);
  return series && input.eventType === "exception" ? ProviderEventStateSchema.parse(input) : desired;
}
export function matchesMicrosoftRsvpTargetState(baseline: ProviderEventState, actual: unknown, selfAddress: string, response: ProviderRsvpEdit["response"], series = false): boolean {
  if (series && baseline.eventType === "exception") {
    const observed = ProviderEventStateSchema.safeParse(actual);
    return observed.success && JSON.stringify(observed.data) === JSON.stringify(ProviderEventStateSchema.parse(baseline));
  }
  return matchesMicrosoftRsvpObservedState(baseline, actual, selfAddress, response);
}
/** Graph's own response is authoritative. Live Accept/Tentative readback can
 * leave the self attendee unchanged and apply the evidenced availability pair. */
export function matchesMicrosoftRsvpObservedState(baseline: ProviderEventState, actual: unknown, selfAddress: string, response: ProviderRsvpEdit["response"]): boolean {
  try {
    const expected = microsoftRsvpDesiredState(baseline, selfAddress, response);
    const observed = ProviderEventStateSchema.parse(actual);
    const own = selfAddress.toLowerCase();
    const before = baseline.attendees.find(item => item.address?.toLowerCase() === own)!;
    const self = observed.attendees.filter(item => item.address?.toLowerCase() === own);
    if (self.length !== 1 || ![before.response, expected.ownResponse].includes(self[0]!.response)) return false;
    self[0]!.response = expected.ownResponse;
    if (response === "accepted" && baseline.availability === "tentative" && observed.availability === "busy") observed.availability = "tentative";
    if (response === "tentative" && baseline.availability === "busy" && observed.availability === "tentative") observed.availability = "busy";
    if (baseline.eventType === "occurrence" && observed.eventType === "exception") observed.eventType = "occurrence";
    return JSON.stringify(observed) === JSON.stringify(expected);
  } catch { return false; }
}
export const GraphRsvpDispatchSchema = z.object({ kind: z.literal("graph-rsvp-dispatch"), version: z.literal(1), startedAt: WireInstantSchema, acceptedAt: WireInstantSchema.optional() }).strict();
export type MicrosoftRsvpConfirmation = { baselineHash: string; observedResponse: string; seriesResponse?: string };

/** Durable permission for at most one CalDAV scheduling PUT. Missing legacy
 * policy and a started policy permit read-only recovery, never another PUT. */
export const CaldavRsvpDeliverySchema = z.object({ kind: z.literal("caldav-rsvp-at-most-once"), version: z.literal(1), startedAt: WireInstantSchema.optional() }).strict();

/** Private permission for one Google attendee PATCH. Missing historical policy
 * is always read-only, including old never-attempted queued operations. */
export const GoogleRsvpDeliverySchema = z.object({ kind: z.literal("google-rsvp-at-most-once"), version: z.literal(1), startedAt: WireInstantSchema.optional() }).strict();
export function googleRsvpDeliveryPolicy(intent: unknown): { observeOnly: boolean; delivery?: z.infer<typeof GoogleRsvpDeliverySchema> } {
  if (intent === null || typeof intent !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(intent))) throw new TypeError("Invalid Google RSVP intent");
  const descriptor = Object.getOwnPropertyDescriptor(intent, "googleDelivery");
  if (!descriptor) return { observeOnly: true };
  if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Invalid Google RSVP delivery policy");
  const value: unknown = descriptor.value;
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid Google RSVP delivery policy");
  const data: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !["kind", "version", "startedAt"].includes(key) || !("value" in field) || !field.enumerable || !["string", "number"].includes(typeof field.value)) throw new TypeError("Invalid Google RSVP delivery policy");
    data[key] = field.value;
  }
  const delivery = GoogleRsvpDeliverySchema.parse(data);
  return { observeOnly: delivery.startedAt !== undefined, delivery };
}
