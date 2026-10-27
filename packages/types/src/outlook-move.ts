import { z } from "zod";
import { EventTimeZoneSchema } from "./event_time";
import { WireInstantSchema } from "./wire_primitives";

export const OUTLOOK_MOVE_LIMIT = 20;
const stamp = WireInstantSchema;
const occurrence = z.object({ eventID: z.uuid(), start: stamp, end: stamp }).strict();
export const OutlookMoveRequestSchema = z.object({
  operationID: z.uuid(), eventID: z.uuid(), calendarID: z.uuid(),
  expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
  eventIDs: z.array(z.uuid()).min(1).max(OUTLOOK_MOVE_LIMIT),
  offsetMinutes: z.number().int().min(-720).max(720).refine(n => n !== 0),
}).strict().refine(v => new Set(v.eventIDs).size === v.eventIDs.length, "Choose each occurrence once");
export type OutlookMoveRequest = z.infer<typeof OutlookMoveRequestSchema>;
export const OutlookMoveOptionsSchema = z.object({
  eventID: z.uuid(), calendarID: z.uuid(), version: z.string(), title: z.string(),
  meeting: z.boolean(), timeZone: EventTimeZoneSchema,
  preserved: z.object({ edited: z.number().int(), cancelled: z.number().int(), unavailable: z.number().int() }).strict(),
  occurrences: z.array(occurrence),
}).strict();
export type OutlookMoveOptions = z.infer<typeof OutlookMoveOptionsSchema>;
export const OutlookMoveResultSchema = z.object({
  operationID: z.uuid(), eventID: z.uuid(), title: z.string(), meeting: z.boolean(),
  timeZone: EventTimeZoneSchema, status: z.enum(["preview", "running", "completed", "stopped"]),
  expiresAt: stamp, offsetMinutes: z.number().int(),
  items: z.array(occurrence.extend({
    newStart: stamp, newEnd: stamp,
    status: z.enum(["pending", "queued", "completed", "failed", "unconfirmed", "not-started"]),
  }).strict()).min(1).max(OUTLOOK_MOVE_LIMIT),
}).strict();
export type OutlookMoveResult = z.infer<typeof OutlookMoveResultSchema>;
