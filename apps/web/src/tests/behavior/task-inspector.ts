import { TaskSchema, TaskCapabilitiesSchema } from "@musubi/types";
import { z } from "zod";

const target = {
  role: z.enum(["button", "textbox", "combobox", "menuitem", "dialog", "alert"]),
  name: z.string(),
};
const step = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("click"), ...target }),
  z.strictObject({ action: z.literal("fill"), name: z.string().min(1), value: z.string() }),
  z.strictObject({ action: z.literal("expect"), ...target,
    state: z.enum(["visible", "absent", "disabled", "enabled"]) }),
  z.strictObject({ action: z.literal("expect-value"), name: z.string().min(1), value: z.string() }),
]);
const exchange = z.strictObject({
  method: z.enum(["PATCH", "DELETE"]),
  // Match selected fields recursively; every request and its method are counted.
  body: z.record(z.string(), z.json()),
  response: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("saved"), title: z.string().min(1), revision: z.number().int().positive() }),
    z.strictObject({ kind: z.literal("rejected"), status: z.number().int().min(400).max(599), error: z.string().min(1) }),
    z.strictObject({ kind: z.literal("deleted"), revision: z.number().int().positive() }),
  ]),
});
export const TaskInspectorSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  driver: z.literal("task-inspector"),
  seed: TaskSchema.extend({ capabilities: TaskCapabilitiesSchema.strict().optional() }).strict(),
  scenarios: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/), title: z.string().min(1),
    capabilities: TaskCapabilitiesSchema.strict().optional(),
    steps: z.array(step).min(1), exchanges: z.array(exchange),
  })).min(1),
}).superRefine((suite, context) => {
  if (new Set(suite.scenarios.map(scenario => scenario.id)).size !== suite.scenarios.length)
    context.addIssue({ code: "custom", message: "Scenario ids must be unique.", path: ["scenarios"] });
  for (const [index, scenario] of suite.scenarios.entries()) {
    if (!scenario.steps.some(step => step.action === "expect" || step.action === "expect-value"))
      context.addIssue({ code: "custom", message: "A scenario needs an observable assertion.", path: ["scenarios", index, "steps"] });
  }
});

export type TaskInspectorSuite = z.infer<typeof TaskInspectorSuiteSchema>;
export type InspectorScenario = TaskInspectorSuite["scenarios"][number];
export type InspectorStep = InspectorScenario["steps"][number];
export type InspectorExchange = InspectorScenario["exchanges"][number];

export function taskForScenario(suite: TaskInspectorSuite, scenario: InspectorScenario) {
  return TaskSchema.parse({ ...suite.seed, ...(scenario.capabilities ? { capabilities: scenario.capabilities } : {}) });
}

/** Fixed HTTP receipts, shared by jsdom and the running application's browser test. */
export function exchangeReply(task: TaskInspectorSuite["seed"], exchange: InspectorExchange) {
  const response = exchange.response;
  if (response.kind === "rejected") return { status: response.status, body: { error: response.error } };
  if (response.kind === "deleted") return { status: 200, body: {
    id: task.id, revision: response.revision, task: null, removed: true, localCommitted: true,
  } };
  return { status: 200, body: { task: { ...task, title: response.title, revision: response.revision }, localCommitted: true } };
}
