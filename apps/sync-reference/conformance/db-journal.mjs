import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool } from "pg";
const allocation = new AsyncLocalStorage();
export const validNamespace = value => typeof value === "string" && /^reference_c10_[a-f0-9]{16}_$/.test(value);
export const ownedDatabaseName = (name, namespace) => validNamespace(namespace) && typeof name === "string" && name.startsWith(namespace) && /^[a-f0-9]{32}$/.test(name.slice(namespace.length)) && name.length <= 63;
export function parseAllocationJournal(text, namespace) {
  const states = new Map(); let valid = validNamespace(namespace), started = false;
  if (typeof text !== "string" || !text.endsWith("\n")) return { valid: false, states };
  for (const line of text.trimEnd().split("\n")) {
    let event; try { event = JSON.parse(line); } catch { valid = false; continue; }
    if (event.event === "start") { if (started || event.schemaVersion !== 1 || event.namespace !== namespace) valid = false; started = true; continue; }
    if (!started || !ownedDatabaseName(event.name, namespace)) { valid = false; continue; }
    const previous = states.get(event.name);
    if (event.event === "create-intent") { if (previous) valid = false; else states.set(event.name, "intent"); }
    else if (event.event === "created") { if (previous !== "intent") valid = false; else states.set(event.name, "created"); }
    else if (event.event === "create-refused") { if (previous !== "intent") valid = false; else states.set(event.name, "refused"); }
    else if (event.event === "drop-intent") { if (previous !== "created") valid = false; else states.set(event.name, "dropping"); }
    else if (event.event === "dropped") { if (previous !== "dropping" || event.sessionsBeforeDrop !== 0 || event.absent !== true) valid = false; else states.set(event.name, "dropped"); }
    else valid = false;
  }
  return { valid: valid && started, states };
}
// Only the current manifest's parent Pool allocation port is supported. Direct
// checked-out Client allocation is refused; ordinary real SQL is untouched.
export function installDatabaseJournal(path, { afterCreate } = {}) {
  const namespace = process.env.SYNC_CONFORMANCE_DATABASE_NAMESPACE;
  if (!validNamespace(namespace)) throw new Error("A parent-owned allocation namespace is required");
  const fd = openSync(path, "wx", 0o600), owned = new Set(), original = Pool.prototype.query, clientQuery = Client.prototype.query;
  const record = event => { const bytes = Buffer.from(`${JSON.stringify(event)}\n`); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); };
  record({ schemaVersion: 1, event: "start", namespace }); process.once("exit", () => closeSync(fd));
  const sql = args => typeof args[0] === "string" ? args[0] : args[0]?.text;
  const isAllocation = text => typeof text === "string" && /\b(?:CREATE|DROP)\s+DATABASE\b|pg_terminate_backend/i.test(text);
  Client.prototype.query = function(...args) { if (isAllocation(sql(args)) && allocation.getStore() !== true) throw new Error("Conformance allocation requires its observed parent Pool port"); return clientQuery.apply(this, args); };
  Pool.prototype.query = async function(...args) {
    const text = sql(args); if (typeof text !== "string" || typeof args.at(-1) === "function") throw new Error("Unsupported conformance query port");
    if (/pg_terminate_backend|DROP\s+DATABASE[\s\S]*FORCE/i.test(text)) throw new Error("Forced database cleanup is forbidden in conformance");
    const create = /^\s*CREATE DATABASE "([a-z][a-z0-9_]{0,62})"\s*;?\s*$/i.exec(text), drop = /^\s*DROP DATABASE "([a-z][a-z0-9_]{0,62})"\s*;?\s*$/i.exec(text);
    if (isAllocation(text) && !create && !drop) throw new Error("Unrecognized conformance database mutation");
    if (create) {
      if (!ownedDatabaseName(create[1], namespace) || owned.has(create[1])) throw new Error("Database allocation escapes its parent-owned namespace");
      record({ event: "create-intent", name: create[1] }); // fsync completes BEFORE SQL can create anything.
      let result; try { result = await allocation.run(true, () => original.apply(this, args)); }
      catch (error) { record({ event: "create-refused", name: create[1] }); throw error; }
      owned.add(create[1]); await afterCreate?.(create[1]); // Actual crash-window fixture port; never used by selected profile modules.
      record({ event: "created", name: create[1] }); return result;
    }
    if (drop) {
      if (!owned.has(drop[1])) throw new Error("Only this observed allocation can be dropped");
      const count = await original.call(this, "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [drop[1]]);
      if (count.rows[0].count !== 0) throw new Error("Test-owned database still has clients"); record({ event: "drop-intent", name: drop[1] });
      const result = await allocation.run(true, () => original.apply(this, args)), absent = await original.call(this, "SELECT 1 FROM pg_database WHERE datname=$1", [drop[1]]);
      record({ event: "dropped", name: drop[1], sessionsBeforeDrop: 0, absent: absent.rowCount === 0 }); owned.delete(drop[1]); return result;
    }
    return original.apply(this, args);
  };
}
