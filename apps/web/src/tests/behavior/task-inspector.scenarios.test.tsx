import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSchema, type Task } from "@musubi/types";
import { updateTask, removeTask } from "~/api/resources";
import { fixtureCalendars } from "~/calendar/fixtures";
import { CalendarTaskContext, TaskDetails } from "~/calendar/components/CalendarTaskDetails";
import data from "./task-inspector.json";
import { TaskInspectorSuiteSchema, exchangeReply, taskForScenario, type InspectorScenario, type InspectorStep } from "./task-inspector";

const suite = TaskInspectorSuiteSchema.parse(data);
const settings = SettingsSchema.parse({ notificationsOnByDefault: true, defaultCalendarView: "month", weekStartsOn: "monday", dateFormat: "dmy", timeFormat: "24h" });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ initial }: { initial: Task }) {
  const [tasks, setTasks] = useState([initial]);
  const [open, setOpen] = useState(true);
  return <CalendarTaskContext.Provider value={{ tasks, calendars: fixtureCalendars, settings, offline: false,
    update: async (id, patch) => {
      const saved = await updateTask(id, patch);
      if (saved) setTasks([saved]);
      return saved;
    },
    remove: async task => { await removeTask(task); setTasks([]); },
  }}><TaskDetails taskId={initial.id} open={open} onOpenChange={setOpen} /></CalendarTaskContext.Provider>;
}

async function runStep(step: InspectorStep, user: ReturnType<typeof userEvent.setup>) {
  if (step.action === "fill") {
    const input = screen.getByRole("textbox", { name: step.name });
    await user.clear(input); if (step.value) await user.type(input, step.value);
  } else if (step.action === "expect-value") {
    await waitFor(() => expect(screen.getByRole("textbox", { name: step.name })).toHaveProperty("value", step.value));
  } else if (step.action === "click") {
    await user.click(screen.getByRole(step.role, { name: step.name }));
  } else {
    await waitFor(() => {
      const element = screen.queryByRole(step.role, { name: step.name });
      if (step.state === "absent") expect(element).toBeNull();
      else {
        expect(element).not.toBeNull();
        if (step.state === "disabled" || step.state === "enabled")
          expect(element).toHaveProperty("disabled", step.state === "disabled");
      }
    });
  }
}

async function runScenario(scenario: InspectorScenario) {
  const task = taskForScenario(suite, scenario);
  const requests: { method: string; body: unknown }[] = [];
  const violations: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const index = requests.length;
    const method = init?.method ?? "GET";
    let body: unknown;
    try { body = JSON.parse(String(init?.body ?? "null")); }
    catch { violations.push(`Invalid JSON at exchange ${index + 1}`); }
    requests.push({ method, body });
    const exchange = scenario.exchanges[index];
    // Components handle HTTP errors. Record transport violations outside that
    // catch boundary so unexpected requests can never become passing UI tests.
    if (String(input) !== `/api/v1/task-mutations/${task.id}` || !exchange || method !== exchange.method) {
      violations.push(`Unexpected request at exchange ${index + 1}`);
      throw new Error("Unexpected fixture request");
    }
    const reply = exchangeReply(task, exchange);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  });
  render(<Harness initial={task} />);
  const user = userEvent.setup();
  for (const [index, step] of scenario.steps.entries()) {
    try { await runStep(step, user); }
    catch (error) { throw new Error(`${scenario.id}, step ${index + 1} (${step.action})`, { cause: error }); }
  }
  expect(violations).toEqual([]);
  expect(requests).toHaveLength(scenario.exchanges.length);
  for (const [index, exchange] of scenario.exchanges.entries())
    expect(requests[index]).toMatchObject({ method: exchange.method, body: exchange.body });
}

const filter = process.env.MUSUBI_SCENARIO;
const selected = suite.scenarios.filter(scenario => !filter || scenario.id === filter);
if (!selected.length) throw new Error(`Unknown task-inspector scenario: ${filter}`);
for (const scenario of selected) it(`${scenario.id}: ${scenario.title}`, () => runScenario(scenario));

it("rejects invalid scenario contracts instead of silently dropping assertions", () => {
  expect(() => TaskInspectorSuiteSchema.parse({ ...data, schemaVersion: 2 })).toThrow();
  expect(() => TaskInspectorSuiteSchema.parse({ ...data, unknown: true })).toThrow();
  expect(() => TaskInspectorSuiteSchema.parse({ ...data, scenarios: [data.scenarios[0], data.scenarios[0]] })).toThrow();
  expect(() => TaskInspectorSuiteSchema.parse({ ...data, scenarios: [{ ...data.scenarios[0], steps: [{ action: "eval", source: "true" }] }] })).toThrow();
  expect(() => TaskInspectorSuiteSchema.parse({ ...data, scenarios: [{ ...data.scenarios[0], steps: [{ action: "click", role: "button", name: "Edit" }] }] })).toThrow();
});

it("fails when an expected write was not exercised", async () => {
  await expect(runScenario({ ...suite.scenarios[0]!, steps: [{ action: "expect", role: "dialog", name: suite.seed.title, state: "visible" }] })).rejects.toThrow();
});

it("fails when an HTTP error is handled by the component after an unplanned write", async () => {
  await expect(runScenario({ ...suite.scenarios[1]!, exchanges: [] })).rejects.toThrow();
});
