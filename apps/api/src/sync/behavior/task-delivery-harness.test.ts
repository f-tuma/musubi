import assert from "node:assert/strict";
import { loadTaskDeliverySuite, parseTaskDeliverySuite, runTaskDeliveryScenario, TaskDeliveryScenarioFailure } from "./task-delivery-driver";
import { runTaskDeliveryCli } from "./task-delivery-cli";

const suite = await loadTaskDeliverySuite();
for (const scenario of suite.scenarios) await runTaskDeliveryScenario(scenario);
let negativeChecks = 0;
function invalid(value: unknown) {
  assert.throws(() => parseTaskDeliverySuite(value), error => error instanceof TaskDeliveryScenarioFailure && error.code === "invalid-suite"); negativeChecks++;
}
invalid({ ...suite, executable: true });
invalid({ ...suite, scenarios: [suite.scenarios[0], suite.scenarios[0]] });
const getter = structuredClone(suite); let evaluated = false;
Object.defineProperty(getter.scenarios[0]!.row, "reconciling", { enumerable: true, get() { evaluated = true; return false; } });
invalid(getter); assert.equal(evaluated, false, "fixture validation must never execute getters");
const badIdentity = structuredClone(suite); const firstRead = badIdentity.scenarios[0]!.adapter[0]!;
if (firstRead.method === "readTask" && firstRead.result) (firstRead.result.ref as { externalTaskId: string }).externalTaskId = "other-task";
invalid(badIdentity);

const wrongExpected = structuredClone(suite.scenarios[0]!); wrongExpected.expected.ackCalls = 0;
await assert.rejects(() => runTaskDeliveryScenario(wrongExpected), error => error instanceof TaskDeliveryScenarioFailure && error.code === "expectation-mismatch"); negativeChecks++;
const missingReceipt = structuredClone(suite.scenarios[0]!); missingReceipt.adapter.splice(1, 1);
await assert.rejects(() => runTaskDeliveryScenario(missingReceipt), error => error instanceof TaskDeliveryScenarioFailure && error.code === "unexpected-port"); negativeChecks++;
const extraReceipt = structuredClone(suite.scenarios[0]!); extraReceipt.adapter.push({ method: "assertTaskWrite" });
await assert.rejects(() => runTaskDeliveryScenario(extraReceipt), error => error instanceof TaskDeliveryScenarioFailure && error.code === "unconsumed-port"); negativeChecks++;
const concurrent = await Promise.allSettled([runTaskDeliveryScenario(suite.scenarios[0]!), runTaskDeliveryScenario(suite.scenarios[0]!)]);
assert.equal(concurrent[0]!.status, "fulfilled");
assert.equal(concurrent[1]!.status, "rejected");
if (concurrent[1]!.status === "rejected") assert.equal(concurrent[1]!.reason.code, "concurrent-run");
negativeChecks++;
for (const args of [["--unknown", "--json"], ["--scenario", "missing", "--json"], ["--list", "--scenario", "saved-title-update", "--json"]]) {
  const output: string[] = []; assert.equal(await runTaskDeliveryCli(args, line => output.push(line)), 1);
  assert.equal(output.length, 1); const report = JSON.parse(output[0]!);
  assert.equal(report.suite, "task-delivery"); assert.ok(["invalid-arguments", "unknown-scenario"].includes(report.error.code)); negativeChecks++;
}
const listed: string[] = []; assert.equal(await runTaskDeliveryCli(["--list", "--json"], line => listed.push(line)), 0);
assert.deepEqual(JSON.parse(listed[0]!).scenarios.map((item: { id: string }) => item.id), suite.scenarios.map(item => item.id));
console.log(`Task delivery behavior: ${suite.scenarios.length} actual-executor scenarios + ${negativeChecks} fail-closed harness checks passed (fixture DB/adapter ports; no native HTTP or DB atomicity claim).`);
