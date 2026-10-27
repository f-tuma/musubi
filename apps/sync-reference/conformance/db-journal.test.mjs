import assert from "node:assert/strict";
import test from "node:test";
import { parseAllocationJournal, ownedDatabaseName } from "./db-journal.mjs";
const namespace = `reference_c10_${"a".repeat(16)}_`, name = `${namespace}${"b".repeat(32)}`;
const text = events => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const start = { schemaVersion: 1, event: "start", namespace };
test("allocation journal preserves a durable pending CREATE intent without inventing success", () => {
  const parsed = parseAllocationJournal(text([start, { event: "create-intent", name }]), namespace);
  assert.equal(parsed.valid, true); assert.deepEqual([...parsed.states], [[name, "intent"]]);
});
test("allocation journal resolves success refusal and plain zero-session cleanup explicitly", () => {
  const parsed = parseAllocationJournal(text([start, { event: "create-intent", name }, { event: "created", name }, { event: "drop-intent", name },
    { event: "dropped", name, sessionsBeforeDrop: 0, absent: true }]), namespace);
  assert.equal(parsed.valid, true); assert.equal(parsed.states.get(name), "dropped");
  assert.equal(parseAllocationJournal(text([start, { event: "create-intent", name }, { event: "create-refused", name }]), namespace).states.get(name), "refused");
});
test("allocation journal rejects truncation missing intent foreign namespace and false cleanup", () => {
  for (const source of ["", text([start]).trimEnd(), text([{ event: "created", name }]), text([start, { event: "created", name }]),
    text([start, { event: "create-intent", name: `reference_foreign_${"c".repeat(32)}` }]),
    text([start, { event: "create-intent", name }, { event: "created", name }, { event: "drop-intent", name }, { event: "dropped", name, sessionsBeforeDrop: 1, absent: true }])])
    assert.equal(parseAllocationJournal(source, namespace).valid, false);
});
test("owned database names fit63 characters and never authorize outside the parent's exact nonce", () => {
  assert.equal(name.length, 63); assert.equal(ownedDatabaseName(name, namespace), true);
  for (const foreign of [`${name}x`, name.toUpperCase(), `reference_other_${"b".repeat(32)}`, name.replace("b", "z")]) assert.equal(ownedDatabaseName(foreign, namespace), false);
});
