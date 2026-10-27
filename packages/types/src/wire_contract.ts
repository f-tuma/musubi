import type { WireDirection, WireSnapshot } from "./wire";

/**
 * What changed between a promised wire contract and the one in the code.
 *
 * Only breaking changes are reported. Adding to a response, or adding an
 * optional field to a request, is how the product moves and says nothing here.
 */
export type WireBreak = {
  document: string;
  path: string;
  reason: string;
};

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const JSON_SCHEMA_TYPES = new Set([
  "array", "boolean", "integer", "null", "number", "object", "string",
]);
const SCHEMA_MAPS = new Set([
  "$defs", "definitions", "dependentSchemas", "patternProperties", "properties",
]);
const SCHEMA_LISTS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUES = new Set([
  "additionalItems", "additionalProperties", "contains", "contentSchema", "else",
  "if", "items", "not", "propertyNames", "then", "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * JSON Schema permits the same type union as `type: ["string", "null"]` or
 * `anyOf: [{ type: "string" }, { type: "null" }]`. Zod has emitted both.
 * Fold only branches with no other keywords: moving a branch's constraint
 * outside its union can change which values are accepted.
 *
 * Recurse through schema positions, never literal values in enum/const/default.
 * Sorting schema keys also keeps the representation stable inside union lists,
 * which the comparator otherwise compares as complete values.
 */
function canonicalSchema(value: unknown): unknown {
  if (!isObject(value)) return value;

  let schema = value;
  if (!("type" in schema) && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const types = schema.anyOf.map((branch: unknown) =>
      isObject(branch) && Object.keys(branch).length === 1 &&
      typeof branch.type === "string" && JSON_SCHEMA_TYPES.has(branch.type)
        ? branch.type
        : undefined,
    );
    if (types.every((type) => type !== undefined)) {
      const { anyOf: _, ...rest } = schema;
      schema = { ...rest, type: types };
    }
  }

  return Object.fromEntries(Object.keys(schema).sort().map((keyword) => {
    const entry = schema[keyword];
    if (keyword === "type" && Array.isArray(entry) && entry.length > 0 &&
        entry.every((type) => typeof type === "string" && JSON_SCHEMA_TYPES.has(type))) {
      const types = [...new Set(entry)].sort();
      return [keyword, types.length === 1 ? types[0] : types];
    }
    if (SCHEMA_MAPS.has(keyword) && isObject(entry)) {
      return [keyword, Object.fromEntries(Object.entries(entry).map(
        ([name, child]) => [name, canonicalSchema(child)],
      ))];
    }
    if (SCHEMA_LISTS.has(keyword) && Array.isArray(entry)) {
      return [keyword, entry.map(canonicalSchema)];
    }
    if (SCHEMA_VALUES.has(keyword)) {
      return [keyword, Array.isArray(entry)
        ? entry.map(canonicalSchema)
        : canonicalSchema(entry)];
    }
    return [keyword, entry];
  }));
}

/**
 * JSON Schema keywords that describe rather than restrict.
 *
 * Everything else appearing where it was not before narrows what the schema
 * accepts — `additionalProperties: false` from a `.strict()`, a `maxLength`, a
 * `format`, a `pattern`. Those are the quiet breaks: the field is still there
 * and still the right type, and a payload that worked last month is refused.
 */
const DESCRIPTIVE_KEYWORDS = new Set([
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "properties",
  "required",
  "title",
]);

/**
 * Compare a promised contract against the current one.
 *
 * The rule differs by direction, because "breaking" is not symmetric:
 *
 * - **read** — the server may add to what it sends, and a client ignores what
 *   it does not recognise. It may not drop a field, change one, or start
 *   omitting one it always sent.
 * - **write** — the server may accept more, but only if the new field is
 *   optional. A new required field, or a tightened existing one, refuses every
 *   client built before it, and those are out in the world for months.
 *
 * A document that disappears from the registry is a break too: it means
 * something stopped being described, not that it stopped being sent.
 */
export function compareWireContract(
  promised: WireSnapshot,
  current: WireSnapshot,
): WireBreak[] {
  const breaks: WireBreak[] = [];

  for (const [name, was] of Object.entries(promised.documents)) {
    const now = current.documents[name];
    if (!now) {
      breaks.push({
        document: name,
        path: "",
        reason: "no longer in the wire contract",
      });
      continue;
    }
    if (now.direction !== was.direction) {
      breaks.push({
        document: name,
        path: "",
        reason: `direction changed from ${was.direction} to ${now.direction}`,
      });
      continue;
    }
    walk(
      canonicalSchema(was.schema), canonicalSchema(now.schema),
      was.direction, name, "", breaks,
    );
  }

  return breaks;
}

function walk(
  was: unknown,
  now: unknown,
  direction: WireDirection,
  document: string,
  path: string,
  breaks: WireBreak[],
) {
  const report = (reason: string, at = path) =>
    breaks.push({ document, path: at || "<root>", reason });

  if (!isObject(was) || !isObject(now)) {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      report(`changed from ${JSON.stringify(was)} to ${JSON.stringify(now)}`);
    }
    return;
  }

  for (const [keyword, wasValue] of Object.entries(was)) {
    const nowValue = now[keyword];
    const at = path ? `${path}.${keyword}` : keyword;

    if (keyword === "properties" && isObject(wasValue)) {
      compareProperties(wasValue, nowValue, direction, document, path, breaks);
      continue;
    }
    if (keyword === "required") continue; // handled once, below
    if (nowValue === undefined) {
      report(`${keyword} ${JSON.stringify(wasValue)} was dropped`, at);
      continue;
    }
    walk(wasValue, nowValue, direction, document, at, breaks);
  }

  for (const keyword of Object.keys(now)) {
    if (keyword in was) continue;
    if (DESCRIPTIVE_KEYWORDS.has(keyword)) continue;
    report(
      `${keyword} ${JSON.stringify(now[keyword])} is new, which only narrows what is accepted`,
      path ? `${path}.${keyword}` : keyword,
    );
  }

  compareRequired(was, now, direction, document, path, breaks);
}

function compareProperties(
  was: JsonObject,
  now: unknown,
  direction: WireDirection,
  document: string,
  path: string,
  breaks: WireBreak[],
) {
  if (!isObject(now)) {
    breaks.push({
      document,
      path: path || "<root>",
      reason: "properties disappeared",
    });
    return;
  }
  // Only the promised fields are walked. A field that is new here is the
  // additive change this whole mechanism exists to allow.
  for (const [name, wasProperty] of Object.entries(was)) {
    const at = path ? `${path}.${name}` : name;
    if (!(name in now)) {
      breaks.push({ document, path: at, reason: "field removed" });
      continue;
    }
    walk(wasProperty, now[name], direction, document, at, breaks);
  }
}

function compareRequired(
  was: JsonObject,
  now: JsonObject,
  direction: WireDirection,
  document: string,
  path: string,
  breaks: WireBreak[],
) {
  const asList = (value: unknown) =>
    new Set(Array.isArray(value) ? (value as string[]) : []);
  const wasRequired = asList(was.required);
  const nowRequired = asList(now.required);
  const at = (name: string) => (path ? `${path}.${name}` : name);

  if (direction === "read") {
    for (const name of wasRequired) {
      if (nowRequired.has(name)) continue;
      // The server sent this every time and may now leave it out. A client
      // that requires it fails to parse the whole document, not just the field.
      breaks.push({
        document,
        path: at(name),
        reason: "field is no longer always sent",
      });
    }
    return;
  }

  for (const name of nowRequired) {
    if (wasRequired.has(name)) continue;
    breaks.push({
      document,
      path: at(name),
      reason: "field is now required, so an older client's request is refused",
    });
  }
}
