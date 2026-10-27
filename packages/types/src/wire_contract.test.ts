import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareWireContract } from "./wire_contract";
import { wireSnapshot, type WireDirection, type WireSnapshot } from "./wire";

const document = (schema: unknown, direction: WireDirection): WireSnapshot => ({
  documents: { Doc: { direction, schema } },
  version: "0.0.0",
});
const compare = (was: unknown, now: unknown, direction: WireDirection) =>
  compareWireContract(document(was, direction), document(now, direction));

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const compactNullableString = { type: ["null", "string"] };

for (const direction of ["read", "write"] as const) {
  assert.deepEqual(
    compare(nullableString, compactNullableString, direction), [],
    `${direction}: the two JSON Schema encodings of nullability are equivalent`,
  );
  assert.deepEqual(
    compare(compactNullableString, nullableString, direction), [],
    `${direction}: equivalence is independent of which encoder made the baseline`,
  );
  assert.deepEqual(
    compare({ type: ["string", "null"] }, compactNullableString, direction), [],
    `${direction}: a type union is an unordered set`,
  );
  assert.ok(
    compare(nullableString, { type: "string" }, direction).length > 0,
    `${direction}: removing null still breaks the promised shape`,
  );
  assert.ok(
    compare(nullableString, { type: ["number", "null"] }, direction).length > 0,
    `${direction}: changing a nullable field's non-null type is still caught`,
  );
  assert.ok(
    compare(nullableString, {
      anyOf: [{ type: "string", maxLength: 80 }, { type: "null" }],
    }, direction).length > 0,
    `${direction}: a branch's constraints must survive normalization`,
  );
  assert.ok(
    compare(nullableString, { ...compactNullableString, maxLength: 80 }, direction).length > 0,
    `${direction}: a newly tightened bound beside a compact type union is caught`,
  );
  assert.ok(
    compare({ ...nullableString, type: "boolean" }, compactNullableString, direction).length > 0,
    `${direction}: a sibling type intersects anyOf and cannot be discarded`,
  );
  for (const keyword of ["enum", "const", "default"]) {
    assert.ok(
      compare({ [keyword]: [nullableString] }, { [keyword]: [compactNullableString] }, direction).length > 0,
      `${direction}: schema-looking object literals in ${keyword} are not normalized`,
    );
  }
}

// Exercise recursive normalization inside a union, whose alternatives are
// compared as complete schemas rather than walked as response properties.
const nested = (field: unknown) => ({
  anyOf: [
    { type: "object", properties: { field }, required: ["field"] },
    { type: "null" },
  ],
});
assert.deepEqual(compare(nested(nullableString), nested(compactNullableString), "read"), []);
assert.ok(compare(nested(nullableString), nested({ type: "string" }), "read").length > 0);
assert.ok(compare(nested(nullableString), {
  anyOf: [
    { type: "object", properties: {}, required: [] },
    { type: "null" },
  ],
}, "read").length > 0, "a removed field inside a normalized union is caught");

// Use the accepted release baseline and today's production schema emitter for
// both affected primitive kinds, rather than only handwritten representations.
const promised = JSON.parse(
  readFileSync(new URL("../contracts/wire.json", import.meta.url), "utf8"),
) as WireSnapshot;
const current = wireSnapshot();
function field(snapshot: WireSnapshot, name: string, ...path: string[]): unknown {
  let schema = snapshot.documents[name]?.schema;
  for (const part of path) {
    assert.ok(schema && typeof schema === "object" && !Array.isArray(schema));
    schema = (schema as Record<string, unknown>)[part];
  }
  assert.ok(schema, `${name}.${path.join(".")} exists in the wire schema`);
  return schema;
}
for (const [name, path] of [
  ["EventPatchRequest", ["properties", "patch", "properties", "description"]],
  ["Calendar", ["properties", "isDefault"]],
] as const) {
  const direction = promised.documents[name]!.direction;
  const was = field(promised, name, ...path);
  const now = field(current, name, ...path);
  const before = JSON.stringify({ was, now });
  assert.deepEqual(compare(was, now, direction), [], `${name}: emitted nullability honors the baseline`);
  assert.equal(JSON.stringify({ was, now }), before, "comparison does not mutate either schema");
}

console.log("wire schema representation compatibility ok");
