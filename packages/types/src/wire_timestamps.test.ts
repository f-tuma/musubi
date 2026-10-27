import assert from "node:assert/strict";
import { loadWireTimestampSuite, runWireTimestampScenario } from "./behavior/wire-timestamps";

const suite = loadWireTimestampSuite();
for (const scenario of suite.scenarios) runWireTimestampScenario(scenario);
assert.ok(suite.scenarios.some(scenario => scenario.id === "availability-minute-utc"));
console.log(`wire timestamp JSON scenarios: ${suite.scenarios.length} passed`);
