import assert from "node:assert/strict";
import { test } from "node:test";
import { createFairWorkCoordinator, type WorkCandidate, type WorkFailureContext } from "./fair-work";

const candidate: WorkCandidate<string> = {
  key: "private-work", family: "task-delivery", accountFairnessKey: "private-account",
  laneKey: "private-lane", dueAtMs: 0, orderKey: "1", collisionKeys: ["private-collection"], hostRef: "private-host-ref",
};

test("execution failure retains its original error and bounded phase/family context", async () => {
  const error = new Error("private-provider-detail");
  const failures: { error: unknown; context: WorkFailureContext }[] = [];
  const coordinator = createFairWorkCoordinator({ capacity: 1, host: {
    async execute() { throw error; },
    onFailure(error, context) { failures.push({ error, context }); },
  } });
  try {
    await assert.rejects(coordinator.submit(candidate), caught => caught === error);
    assert.equal(failures.length, 1); assert.equal(failures[0]!.error, error);
    assert.deepEqual(failures[0]!.context, { phase: "execute", family: "task-delivery" });
    assert(!JSON.stringify(failures[0]!.context).includes("private-"));
  } finally { coordinator.close(); }
});

test("candidate lookup failure is reported without candidate/account identity", async () => {
  const error = new Error("private-database-query");
  let reported!: () => void;
  const observed = new Promise<void>(resolve => { reported = resolve; });
  const failures: { error: unknown; context: WorkFailureContext }[] = [];
  const coordinator = createFairWorkCoordinator({ capacity: 1, host: {
    async candidates() { throw error; },
    async execute() { assert.fail("A failed lookup must not execute work"); },
    onFailure(error, context) { failures.push({ error, context }); reported(); },
  } });
  try {
    coordinator.kick(); await observed;
    assert.equal(failures.length, 1); assert.equal(failures[0]!.error, error);
    assert.deepEqual(failures[0]!.context, { phase: "candidates" });
  } finally { coordinator.close(); }
});

test("a failing diagnostic sink cannot replace the original execution failure", async () => {
  const original = new Error("original");
  const coordinator = createFairWorkCoordinator({ capacity: 1, host: {
    async execute() { throw original; },
    onFailure() { throw new Error("diagnostic-sink"); },
  } });
  try { await assert.rejects(coordinator.submit(candidate), caught => caught === original); }
  finally { coordinator.close(); }
});
