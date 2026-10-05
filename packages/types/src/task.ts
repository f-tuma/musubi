import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "needs-action",
  "in-process",
  "completed",
  "cancelled",
]);

export const TaskCapabilitiesSchema = z.object({
  edit: z.boolean(),
  delete: z.boolean(),
  link: z.boolean(),
  fork: z.boolean(),
  unlinkCalendarIDs: z.array(z.string()),
});

export const TaskSchema = z.object({
  id: z.string(),
  providerReadRetiredGeneration: z.number().int().positive().nullish().transform((value): number | null | undefined => value ?? undefined).optional(),
  creatorID: z.string(),
  calendarID: z.string(),
  originCalendarID: z.string().nullable().optional(),
  calendarIDs: z.array(z.string()).optional(),
  revision: z.number().int().positive().optional(),
  capabilities: TaskCapabilitiesSchema.optional(),
  title: z.string(),
  description: z.string().nullish(),
  status: TaskStatusSchema.default("needs-action"),
  start: z.coerce.date().nullish(),
  due: z.coerce.date().nullish(),
  isAllDay: z.boolean().default(false),
  completedAt: z.coerce.date().nullish(),
  percentComplete: z.number().int().min(0).max(100).default(0),
  priority: z.number().int().min(0).max(9).default(0),
  recurrence: z.string().nullish(),
  relatedTo: z.string().nullish(),
  sequence: z.number().int().nonnegative().default(0),
  url: z.string().nullish(),
});

export const TaskListResponseSchema = z.object({ tasks: z.array(TaskSchema) });

// A distinct URL is the compatibility boundary: it does not exist on an older
// API, and must never fall back to legacy writes after a failed request.
export const TASK_MUTATION_PATH = "/api/v1/task-mutations";
export const TASK_FORK_NOT_COMMITTED_CODE = "task-fork-not-committed" as const;
export const TaskClientUpgradeRequiredSchema = z.object({
  error: z.string(),
  code: z.literal("task-client-upgrade-required"),
  message: z.string(),
  localCommitted: z.literal(false),
  taskMutationPath: z.literal(TASK_MUTATION_PATH),
  requestId: z.string().optional(),
});

export const TaskCreateSchema = TaskSchema.omit({
  providerReadRetiredGeneration: true,
  creatorID: true,
  sequence: true,
  originCalendarID: true,
  calendarIDs: true,
  revision: true,
  capabilities: true,
});
export const TaskUpdateSchema = TaskCreateSchema.omit({ id: true }).extend({
  expectedRevision: z.number().int().positive().optional(),
  expectedProviderReadRetiredGeneration: z.number().int().nonnegative().optional(),
});

export const TaskReplaceRequestSchema = TaskUpdateSchema.extend({
  expectedRevision: z.number().int().positive(),
});

// Explicit patch fields must not apply creation defaults to omitted values.
export const TaskContentPatchSchema = z.object({
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  status: TaskStatusSchema.optional(),
  start: z.coerce.date().nullable().optional(),
  due: z.coerce.date().nullable().optional(),
  isAllDay: z.boolean().optional(),
  completedAt: z.coerce.date().nullable().optional(),
  percentComplete: z.number().int().min(0).max(100).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  recurrence: z.string().nullable().optional(),
  relatedTo: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
}).strict();

export const TaskPatchRequestSchema = z.object({
  patch: TaskContentPatchSchema,
  expectedRevision: z.number().int().positive(),
  expectedProviderReadRetiredGeneration: z.number().int().nonnegative().optional(),
}).strict();

export const TaskLinkRequestSchema = z.object({
  calendarID: z.uuid(),
  expectedRevision: z.number().int().positive(),
  expectedProviderReadRetiredGeneration: z.number().int().nonnegative().optional(),
}).strict();
export const TaskForkRequestSchema = TaskLinkRequestSchema;
export const TaskDeleteRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  unlinkCalendarID: z.uuid().optional(),
  expectedProviderReadRetiredGeneration: z.number().int().nonnegative().optional(),
}).strict();

export const TaskDeliveryTargetSchema = z.object({
  operationId: z.uuid(),
  calendarId: z.string(),
  calendarName: z.string().nullable(),
  provider: z.string(),
  action: z.enum(["create", "update", "delete"]),
  status: z.enum(["pending", "attempting", "completed", "not-needed", "conflict", "not-written", "unconfirmed", "retry", "blocked", "cancelled"]),
  revision: z.number().int().positive(),
  owned: z.boolean(),
  issue: z.enum(["reconnect-required", "write-denied", "write-unsupported", "permission-unknown", "conflict", "unconfirmed", "destination-unavailable", "recovery-unavailable", "delivery-failed"]).nullable(),
  updatedAt: z.coerce.date(),
});
export const TaskDeliverySchema = z.object({
  taskId: z.string(),
  localRevision: z.number().int().positive().nullable(),
  targets: z.array(TaskDeliveryTargetSchema),
});
export const TaskDeliveryInboxSchema = z.object({
  items: z.array(z.object({ taskId: z.string(), savedTitle: z.string() })),
  nextCursor: z.string().nullable(),
});
const CommittedTaskSchema = TaskSchema.extend({ revision: z.number().int().positive() });
export const TaskMutationResponseSchema = z.object({
  task: CommittedTaskSchema.nullable(),
  localCommitted: z.literal(true),
  delivery: TaskDeliverySchema.optional(),
});
export const TaskDeleteResponseSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  removed: z.boolean(),
  task: CommittedTaskSchema.nullable(),
  localCommitted: z.literal(true),
  delivery: TaskDeliverySchema.optional(),
});

export function requireTaskRevision(task: Pick<Task, "revision">): number {
  if (!Number.isSafeInteger(task.revision) || task.revision! < 1)
    throw new Error("Refresh the task before saving; its revision is unavailable.");
  return task.revision!;
}

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;
export type TaskContentPatch = z.infer<typeof TaskContentPatchSchema>;
export type TaskPatchRequest = z.infer<typeof TaskPatchRequestSchema>;
export type TaskMutationResponse = z.infer<typeof TaskMutationResponseSchema>;
export type TaskDeleteResponse = z.infer<typeof TaskDeleteResponseSchema>;
export type TaskDelivery = z.infer<typeof TaskDeliverySchema>;
export type TaskDeliveryTarget = z.infer<typeof TaskDeliveryTargetSchema>;
export type TaskDeliveryInbox = z.infer<typeof TaskDeliveryInboxSchema>;
