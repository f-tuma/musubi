/** Native JSON evidence has the provider's parser floor, not admission-plan
 * size/depth limits. Iterate without a new recursive stack bound and read own
 * data descriptors only. Shared references are safe; cycles are not JSON. */
export function copyNativeTaskEvidence<T>(input: T): T {
  type Frame = { source: object; target: object; keys: readonly string[]; index: number };
  const copies = new WeakMap<object, object>(), active = new WeakSet<object>(), frames: Frame[] = [];
  function allocate(value: unknown): unknown {
    // JSON.parse accepts overflowing exponent literals as Infinity. The legacy
    // native reader ignores such metadata; strict-reference rejects it earlier.
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    if (!value || typeof value !== "object") throw new Error("Invalid native task JSON.");
    const known = copies.get(value);
    if (known) { if (active.has(value)) throw new Error("Cyclic native task JSON."); return known; }
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Invalid native task JSON prototype.");
    const keys = array ? Array.from({ length: value.length }, (_, i) => String(i)) : ownKeys;
    if (array && ownKeys.length !== value.length + 1 || keys.some(key => typeof key !== "string")) throw new Error("Invalid native task JSON properties.");
    const target = array ? new Array(value.length) : Object.create(prototype) as object;
    copies.set(value, target); active.add(value); frames.push({ source: value, target, keys: keys as string[], index: 0 }); return target;
  }
  const output = allocate(input);
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    if (frame.index === frame.keys.length) { Object.freeze(frame.target); active.delete(frame.source); frames.pop(); continue; }
    const key = frame.keys[frame.index++]!, descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid native task JSON descriptor.");
    const value = allocate(descriptor.value);
    Object.defineProperty(frame.target, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return output as T;
}
