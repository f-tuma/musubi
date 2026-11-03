import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  createFairWorkCoordinator,
  ProviderDispatchDeferred,
} from "@musubi/sync-runtime";
import { awaitCollectionReads } from "../collection_reads";
import { SyncWorkDeferred } from "../sync_outcome";

const scenario = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    title: z.string().min(1),
    outcomes: z
      .array(
        z.enum(["success", "queued", "capacity", "failure", "counterfeit"]),
      )
      .min(1),
    expected: z
      .object({
        visited: z.number().int(),
        maximumActive: z.number().int(),
        changed: z.number().int(),
        errorIndex: z.number().int().nullable(),
      })
      .strict(),
  })
  .strict();
const suite = z
  .object({
    schemaVersion: z.literal(1),
    suite: z.literal("collection-reads"),
    scenarios: z.array(scenario).min(1),
  })
  .strict();
export async function loadCollectionReadsSuite() {
  const result = suite.parse(
    JSON.parse(
      await readFile(
        new URL("./collection-reads.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(
    new Set(result.scenarios.map((x) => x.id)).size,
    result.scenarios.length,
  );
  return result;
}
export async function runCollectionReadsScenario(
  value: z.infer<typeof scenario>,
) {
  let active = 0,
    maximumActive = 0,
    visited = 0;
  const errors = value.outcomes.map((kind) =>
    kind === "queued"
      ? new SyncWorkDeferred(9000)
      : kind === "capacity"
        ? new ProviderDispatchDeferred({
            reason: "work-capacity",
            retryAtMs: 1234,
            blockedDimensions: [],
          })
        : kind === "counterfeit"
          ? Object.assign(new Error("native failure"), {
              name: "SyncWorkDeferred",
              retryAtMs: 1,
            })
          : new Error("native fixture failure"),
  );
  const coordinator = createFairWorkCoordinator<number>({
    capacity: 4,
    host: {
      async execute(candidate) {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        return {
          kind: "settled",
          changedCalendarIDs: [String(candidate.hostRef)],
        };
      },
    },
  });
  let changed: string[] = [],
    caught: unknown;
  try {
    changed = await awaitCollectionReads(
      value.outcomes.map((_, index) => index),
      async (index) => {
        visited++;
        const result = await coordinator.submit({
          key: String(index),
          family: "pull",
          accountFairnessKey: "owned-account",
          laneKey: String(index),
          dueAtMs: 0,
          orderKey: String(index),
          collisionKeys: [String(index)],
          hostRef: index,
        });
        if (value.outcomes[index] !== "success") throw errors[index];
        assert.equal(result.kind, "settled");
        return {
          changedCalendarIDs:
            result.kind === "settled" ? result.changedCalendarIDs : [],
        };
      },
    );
  } catch (error) {
    caught = error;
  } finally {
    coordinator.close();
  }
  const summary = {
    visited,
    maximumActive,
    changed: changed.length,
    errorIndex: caught === undefined ? null : errors.indexOf(caught as Error),
  };
  assert.deepEqual(summary, value.expected);
  return summary;
}
