import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderBudgetLimits, parseProviderBudgetNamespace, MIN_PROVIDER_BUDGET_REFILL_PER_SECOND } from "./provider-budget";
test("provider budget defaults and explicit operator overrides are independent of credentials", () => {
  const defaults = parseProviderBudgetLimits(undefined);
  assert.deepEqual(defaults.google.account, { capacity: 4, refillPerSecond: 2 });
  const override = parseProviderBudgetLimits('{"google":{"account":{"capacity":1,"refillPerSecond":100}}}');
  assert.deepEqual(override.google.account, { capacity: 1, refillPerSecond: 100 });
  assert.deepEqual(override.microsoft, defaults.microsoft); assert.deepEqual(override.google.application, defaults.google.application);
});
test("API local refill cannot outlast its single-wait continuation retention policy", () => {
  assert.throws(() => parseProviderBudgetLimits('{"google":{"account":{"capacity":1,"refillPerSecond":0.001}}}'), /one token per 15 seconds/);
  assert.equal(parseProviderBudgetLimits(JSON.stringify({ google: { account: { capacity: 1, refillPerSecond: MIN_PROVIDER_BUDGET_REFILL_PER_SECOND } } })).google.account.refillPerSecond,
    MIN_PROVIDER_BUDGET_REFILL_PER_SECOND);
});
test("invalid operator configuration fails rather than disabling admission or inventing a tenant", () => {
  for (const value of ["", "null", "[]", '{"other":{}}', '{"google":{"tenant":{}}}', '{"google":null}',
    '{"google":{"account":{"capacity":0,"refillPerSecond":1}}}', '{"google":{"account":{"capacity":1,"refillPerSecond":0}}}',
    '{"google":{"account":{"capacity":1.1,"refillPerSecond":1}}}', '{"google":{"account":{"capacity":1,"refillPerSecond":"1"}}}',
    '{"google":{"account":{"capacity":1,"refillPerSecond":1,"extra":true}}}']) assert.throws(() => parseProviderBudgetLimits(value));
  assert.equal(parseProviderBudgetNamespace(undefined), "musubi-sync-v1");
  for (const value of ["", "with space", "x".repeat(65)]) assert.throws(() => parseProviderBudgetNamespace(value));
});
