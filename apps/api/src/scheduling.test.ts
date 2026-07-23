import assert from "node:assert/strict";
import { nonOverlapping } from "./scheduling";

async function main() {
  let releaseFirst!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  let skips = 0;

  const run = nonOverlapping(
    async () => {
      calls += 1;
      if (calls === 1) await firstRun;
    },
    () => {
      skips += 1;
    },
  );

  const active = run();
  assert.equal(calls, 1);
  assert.equal(await run(), "skipped");
  assert.equal(calls, 1);
  assert.equal(skips, 1);

  releaseFirst();
  assert.equal(await active, "completed");
  assert.equal(await run(), "completed");
  assert.equal(calls, 2);

  let shouldFail = true;
  const runAfterFailure = nonOverlapping(
    async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("expected");
      }
    },
    () => assert.fail("a completed failure must release the guard"),
  );

  await assert.rejects(runAfterFailure(), /expected/);
  assert.equal(await runAfterFailure(), "completed");

  console.log("scheduling self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
