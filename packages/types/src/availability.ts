import { z } from "zod";
import { WireOffsetDateTimeSchema } from "./wire_primitives";
export const GOOGLE_AVAILABILITY_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy";
export const AVAILABILITY_SOURCE_LIMIT = 20;
const instant = WireOffsetDateTimeSchema;
export const AvailabilityIntervalSchema = z.object({ start: instant, end: instant }).strict().refine(v => Date.parse(v.start) < Date.parse(v.end));
export const AvailabilityRequestSchema = z.object({
  start: instant, end: instant, sourceIds: z.array(z.uuid()).min(1).max(AVAILABILITY_SOURCE_LIMIT).refine(v => new Set(v).size === v.length),
}).strict().refine(v => Date.parse(v.end) > Date.parse(v.start) && Date.parse(v.end) - Date.parse(v.start) <= 42 * 86400000, "Choose a range of at most 42 days.");
export const AvailabilitySourceSchema = z.object({
  id: z.uuid(), generation: z.number().int().nonnegative(), label: z.string(), accountLabel: z.string(),
  enabled: z.boolean(), reconnectRequired: z.boolean(),
}).strict();
export const AvailabilitySourcesSchema = z.object({ sources: z.array(AvailabilitySourceSchema) }).strict();
export const AvailabilitySelectionSchema = z.object({ enabled: z.boolean(), expectedGeneration: z.number().int().nonnegative() }).strict();
export const AvailabilityResultSchema = z.discriminatedUnion("status", [
  z.object({ sourceId: z.uuid(), generation: z.number().int().nonnegative(), status: z.literal("available"), intervals: z.array(AvailabilityIntervalSchema) }).strict(),
  z.object({ sourceId: z.uuid(), generation: z.number().int().nonnegative(), status: z.enum(["unavailable", "reconnect-required"]) }).strict(),
]);
export const AvailabilityResponseSchema = z.object({ start: instant, end: instant, observedAt: instant, sources: z.array(AvailabilityResultSchema) }).strict();
export type AvailabilityRequest = z.infer<typeof AvailabilityRequestSchema>;
export type AvailabilitySource = z.infer<typeof AvailabilitySourceSchema>;
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;
