/** Snapshot host preparation without admission size/depth limits or JSON's
 * loss of canonical Dates/undefined fields. Never evaluate accessors or retain
 * callbacks. Shared data is safe; cycles cannot come from a persisted claim. */
export function copyTaskCompatibilityData<T>(input: T, freeze = true): T {
  type Frame = { source: object; target: object; keys: readonly string[]; index: number };
  const copies = new WeakMap<object, object>(), active = new WeakSet<object>(), frames: Frame[] = [];
  function allocate(value: unknown): unknown {
    if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    if (!value || typeof value !== "object") throw new Error("Invalid task preparation data.");
    const known = copies.get(value);
    if (known) { if (active.has(value)) throw new Error("Cyclic task preparation data."); return known; }
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value);
    if (prototype === Date.prototype) {
      if (ownKeys.length) throw new Error("Invalid task preparation Date.");
      const date = new Date(Date.prototype.getTime.call(value));
      if (freeze) Object.freeze(date);
      copies.set(value, date); return date;
    }
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Invalid task preparation prototype.");
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : ownKeys;
    if (array && ownKeys.length !== value.length + 1 || keys.some(key => typeof key !== "string")) throw new Error("Invalid task preparation properties.");
    const target = array ? new Array(value.length) : Object.create(prototype) as object;
    copies.set(value, target); active.add(value); frames.push({ source: value, target, keys: keys as string[], index: 0 }); return target;
  }
  const output = allocate(input);
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    if (frame.index === frame.keys.length) { if (freeze) Object.freeze(frame.target); active.delete(frame.source); frames.pop(); continue; }
    const key = frame.keys[frame.index++]!, descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid task preparation descriptor.");
    const value = allocate(descriptor.value);
    Object.defineProperty(frame.target, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return output as T;
}
