import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { mock } from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { TaskSchema, SyncOperationEnvelopeSchema, type Task } from "@musubi/types";
import type { CalendarAdapter } from "./adapter";
import type { DeliveryAttemptOptions } from "./delivery_policy";
import type { TaskOutboxIntent, TaskOutboxRow } from "@musubi/db";

/** Opt-in PG/native parity, never part of the pure fixture driver. Both sides
 * execute production orchestration and the same real API native adapters.
 * The old executor is read from an immutable revision, not reimplemented here.
 * No assertion in this file establishes portable To Do CAS or provider support.
 */
const OLD_REVISION = "a143002c45bf8e5a5eaf2fc3817fac430eba9c6b";
type Provider = "google" | "microsoft" | "caldav";
type Action = "create" | "update" | "delete";
type Mode = "success" | "partial-fresh" | "partial-recovery" | "missing-id" | "readback-rejection" |
  "native-delete-absence" | "source-before-dispatch" | "source-before-ack" | "privacy-before-ack" |
  "mapping-before-ack" | "ack-cancellation" | "ack-lease-expiry";
type Case = { name: string; provider: Provider; action: Action; legacy?: boolean; secondary?: boolean;
  recurring?: boolean; predecessor?: "present" | "absent"; mode?: Mode; recovery?: "known" | "unknown"; oversize?: boolean; historicalUid?: boolean };
type Wire = { method: string; path: string; body: string; ifMatch: string | null; ifNoneMatch: string | null;
  contentType: string | null; cacheControl: string | null; depth: string | null; authorization: string | null; redirect: RequestRedirect | undefined };
type Executor = (id: string, adapterFor: (provider: string) => CalendarAdapter | null, options?: DeliveryAttemptOptions) => Promise<TaskOutboxRow | undefined>;
const cases: readonly Case[] = [
  { name: "google-predecessor-present", provider: "google", action: "create", predecessor: "present" },
  { name: "google-predecessor-absent", provider: "google", action: "create", predecessor: "absent" },
  { name: "google-fresh-partial-mask", provider: "google", action: "create", predecessor: "absent", mode: "partial-fresh" },
  { name: "google-recovery-full-target", provider: "google", action: "create", predecessor: "absent", mode: "partial-recovery" },
  { name: "google-unknown-response-address", provider: "google", action: "create", predecessor: "absent", mode: "missing-id" },
  { name: "google-known-response-address", provider: "google", action: "create", predecessor: "absent", recovery: "known" },
  { name: "todo-home-create", provider: "microsoft", action: "create" },
  { name: "todo-secondary-create-refused", provider: "microsoft", action: "create", secondary: true },
  { name: "todo-home-weak-update", provider: "microsoft", action: "update" },
  { name: "todo-home-weak-delete", provider: "microsoft", action: "delete" },
  { name: "todo-known-response-address", provider: "microsoft", action: "create", recovery: "known" },
  { name: "todo-unknown-response-address", provider: "microsoft", action: "create", recovery: "unknown" },
  { name: "todo-secondary-update-refused", provider: "microsoft", action: "update", secondary: true },
  { name: "todo-secondary-delete-refused", provider: "microsoft", action: "delete", secondary: true },
  { name: "vtodo-full-resource-create", provider: "caldav", action: "create" },
  { name: "vtodo-full-resource-update", provider: "caldav", action: "update" },
  { name: "vtodo-retained-delete", provider: "caldav", action: "delete" },
  { name: "vtodo-task-uuid-recovery", provider: "caldav", action: "create", recovery: "unknown" },
  { name: "vtodo-v0-native-uid", provider: "caldav", action: "update", legacy: true, historicalUid: true },
  { name: "google-v0-home-recurrence", provider: "google", action: "update", recurring: true },
  { name: "todo-v0-home-recurrence", provider: "microsoft", action: "update", recurring: true },
  { name: "google-v0-secondary-recurrence-refused", provider: "google", action: "update", recurring: true, secondary: true },
  { name: "todo-v0-secondary-recurrence-refused", provider: "microsoft", action: "update", recurring: true, secondary: true },
  { name: "google-v0-oversize-native-address", provider: "google", action: "update", legacy: true, oversize: true },
  { name: "google-v0-delete-native-404-without-dispatch", provider: "google", action: "delete", legacy: true, mode: "native-delete-absence" },
  { name: "google-fulfilled-writer-readback-rejection", provider: "google", action: "update", legacy: true, mode: "readback-rejection" },
  { name: "todo-fulfilled-writer-readback-rejection", provider: "microsoft", action: "update", mode: "readback-rejection" },
  { name: "google-source-before-dispatch", provider: "google", action: "create", predecessor: "absent", mode: "source-before-dispatch" },
  { name: "todo-source-before-ack", provider: "microsoft", action: "create", mode: "source-before-ack" },
  { name: "vtodo-privacy-before-ack", provider: "caldav", action: "update", mode: "privacy-before-ack" },
  { name: "google-competing-mapping-at-ack", provider: "google", action: "create", predecessor: "absent", mode: "mapping-before-ack" },
  { name: "todo-ack-cancellation-rolls-back", provider: "microsoft", action: "update", mode: "ack-cancellation" },
  { name: "vtodo-ack-lease-expiry-rolls-back", provider: "caldav", action: "update", mode: "ack-lease-expiry" },
];
type ExpectedCase = { status: TaskOutboxRow["status"]; first?: TaskOutboxRow["status"]; mutations: number;
  mapping: "absent" | "baseline" | "written" | "competing"; methods: string[] };
// Explicit expectations make the default CI gate independent of any Git
// history. Historical mode additionally compares the complete old/new ledger.
const googleUpdate = ["GET", "GET", "GET", "PATCH", "GET"];
const davUpdate = ["GET", "PROPFIND", "GET", "PROPFIND", "GET", "PROPFIND", "PROPFIND", "REPORT", "PUT", "GET"];
const expectedCases: Record<string, ExpectedCase> = {
  "google-predecessor-present": { status: "completed", mutations: 1, mapping: "written", methods: ["GET", "GET", "POST", "GET"] },
  "google-predecessor-absent": { status: "completed", mutations: 1, mapping: "written", methods: ["GET", "POST", "GET"] },
  "google-fresh-partial-mask": { status: "completed", mutations: 1, mapping: "written", methods: ["GET", "POST", "GET"] },
  "google-recovery-full-target": { status: "completed", first: "unconfirmed", mutations: 1, mapping: "written", methods: ["GET", "POST", "GET", "GET", "GET"] },
  "google-unknown-response-address": { status: "unconfirmed", mutations: 1, mapping: "absent", methods: ["GET", "POST"] },
  "google-known-response-address": { status: "completed", mutations: 0, mapping: "written", methods: ["GET"] },
  "todo-home-create": { status: "completed", mutations: 1, mapping: "written", methods: ["GET", "POST", "GET"] },
  "todo-secondary-create-refused": { status: "blocked", mutations: 0, mapping: "absent", methods: ["GET"] },
  "todo-home-weak-update": { status: "completed", mutations: 1, mapping: "written", methods: googleUpdate },
  "todo-home-weak-delete": { status: "completed", mutations: 1, mapping: "absent", methods: ["GET", "GET", "GET", "DELETE"] },
  "todo-known-response-address": { status: "completed", mutations: 0, mapping: "written", methods: ["GET"] },
  "todo-unknown-response-address": { status: "unconfirmed", mutations: 0, mapping: "absent", methods: [] },
  "todo-secondary-update-refused": { status: "blocked", mutations: 0, mapping: "baseline", methods: ["GET", "GET"] },
  "todo-secondary-delete-refused": { status: "blocked", mutations: 0, mapping: "baseline", methods: ["GET", "GET"] },
  "vtodo-full-resource-create": { status: "completed", mutations: 1, mapping: "written", methods: ["PROPFIND", "PROPFIND", "GET", "PROPFIND", "PROPFIND", "PUT", "GET"] },
  "vtodo-full-resource-update": { status: "completed", mutations: 1, mapping: "written", methods: davUpdate },
  "vtodo-retained-delete": { status: "completed", mutations: 1, mapping: "absent", methods: ["GET", "PROPFIND", "GET", "PROPFIND", "GET", "PROPFIND", "PROPFIND", "DELETE"] },
  "vtodo-task-uuid-recovery": { status: "completed", mutations: 0, mapping: "written", methods: ["GET"] },
  "vtodo-v0-native-uid": { status: "completed", mutations: 1, mapping: "written", methods: davUpdate },
  "google-v0-home-recurrence": { status: "completed", mutations: 1, mapping: "written", methods: googleUpdate },
  "todo-v0-home-recurrence": { status: "completed", mutations: 1, mapping: "written", methods: googleUpdate },
  "google-v0-secondary-recurrence-refused": { status: "blocked", mutations: 0, mapping: "baseline", methods: [] },
  "todo-v0-secondary-recurrence-refused": { status: "blocked", mutations: 0, mapping: "baseline", methods: [] },
  "google-v0-oversize-native-address": { status: "completed", mutations: 1, mapping: "written", methods: googleUpdate },
  "google-v0-delete-native-404-without-dispatch": { status: "completed", mutations: 0, mapping: "absent", methods: ["GET", "GET", "GET"] },
  "google-fulfilled-writer-readback-rejection": { status: "completed", first: "unconfirmed", mutations: 1, mapping: "written", methods: [...googleUpdate, "GET"] },
  "todo-fulfilled-writer-readback-rejection": { status: "completed", first: "unconfirmed", mutations: 1, mapping: "written", methods: [...googleUpdate, "GET"] },
  "google-source-before-dispatch": { status: "blocked", mutations: 0, mapping: "absent", methods: ["GET"] },
  "todo-source-before-ack": { status: "blocked", mutations: 1, mapping: "absent", methods: ["GET", "POST", "GET"] },
  "vtodo-privacy-before-ack": { status: "blocked", mutations: 1, mapping: "baseline", methods: davUpdate },
  "google-competing-mapping-at-ack": { status: "conflict", mutations: 1, mapping: "competing", methods: ["GET", "POST", "GET"] },
  "todo-ack-cancellation-rolls-back": { status: "completed", first: "unconfirmed", mutations: 1, mapping: "written", methods: [...googleUpdate, "GET"] },
  "vtodo-ack-lease-expiry-rolls-back": { status: "completed", first: "attempting", mutations: 1, mapping: "written", methods: [...davUpdate, "GET"] },
};
type CrashPhase = "raw-native-response" | "writer-fulfilled" | "readback-observed" | "ack-committed";
const crashPhases: readonly CrashPhase[] = ["raw-native-response", "writer-fulfilled", "readback-observed", "ack-committed"];

/** Separate process, actual executor/adapters, existing dependency seams only.
 * A checkpoint never fabricates persistence: the parent inspects the real DB
 * after SIGKILL, expires that dead lease, then starts another actual worker.
 */
async function childWorker() {
  assert.equal(process.env.ENVIRONMENT, "test"); assert.equal(process.env.MUSUBI_TASK_COMPATIBILITY_QA, "1");
  const [label, id, providerValue, phaseValue] = process.argv.slice(3), provider = providerValue as Provider, phase = phaseValue as CrashPhase | "recover";
  assert(label === "old" || label === "new"); assert(id); assert(["google", "microsoft", "caldav"].includes(provider));
  assert([...crashPhases, "recover"].includes(phase));
  const origin = process.env.MUSUBI_TASK_COMPATIBILITY_ORIGIN; assert(origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const stop = async (at: CrashPhase): Promise<void> => {
    if (at !== phase) return;
    process.send!({ kind: "checkpoint", phase: at });
    setInterval(() => {}, 1_000);
    await new Promise<never>(() => {});
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const logical = new URL(input instanceof Request ? input.url : String(input));
    assert([origin, "https://tasks.googleapis.com", "https://graph.microsoft.com"].includes(logical.origin), "Child has no live network fallback");
    const response = await originalFetch(logical.origin === origin ? input : `${origin}${logical.pathname}${logical.search}`, init);
    Object.defineProperty(response, "url", { value: logical.href });
    if (["POST", "PATCH", "PUT", "DELETE"].includes(init?.method?.toUpperCase() ?? "") && response.ok) await stop("raw-native-response");
    return response;
  };
  const { db } = await import("@musubi/db");
  const { googleAdapter } = await import("./adapters/google"), { microsoftAdapter } = await import("./adapters/microsoft"), { caldavAdapter } = await import("./adapters/caldav");
  const base = provider === "google" ? googleAdapter : provider === "microsoft" ? microsoftAdapter : caldavAdapter;
  let writerFulfilled = false;
  const adapter: CalendarAdapter = { ...base, googleTaskCreateV1: undefined, googleTaskUpdateV1: undefined, googleTaskDeleteV1: undefined,
    async pushTaskCreate(...args) { const result = await base.pushTaskCreate!(...args); writerFulfilled = true; return result; },
    async pushTaskUpdate(...args) { const result = await base.pushTaskUpdate!(...args); writerFulfilled = true; return result; },
    async pushTaskDelete(...args) { await base.pushTaskDelete!(...args); writerFulfilled = true; },
    async readTask(...args) {
      if (writerFulfilled) await stop("writer-fulfilled");
      const evidence = await base.readTask!(...args);
      if (writerFulfilled) await stop("readback-observed");
      return evidence;
    },
  };
  const committing = new WeakSet<Client>(), originalQuery = Client.prototype.query;
  const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
    if (typeof text === "string" && /^update "task_outbox"/i.test(text) && Array.isArray(values) && values.includes("completed")) committing.add(this);
    const result = Reflect.apply(originalQuery, this, args);
    if (typeof text === "string" && text.trim().toLowerCase() === "commit" && committing.has(this)) {
      committing.delete(this); return Promise.resolve(result).then(async value => { await stop("ack-committed"); return value; });
    }
    return result;
  });
  try {
    const oldPath = process.env.MUSUBI_TASK_COMPATIBILITY_OLD_PATH; if (label === "old") assert(oldPath);
    const module = await import(label === "old" ? pathToFileURL(oldPath!).href : "./task_delivery") as { deliverTaskOutbox: Executor };
    const result = await module.deliverTaskOutbox(id, () => adapter);
    process.send!({ kind: "result", result: result ?? null });
  } finally { query.mock.restore(); await db.$client.end(); globalThis.fetch = originalFetch; }
}

function normalizeOwned(value: unknown, owned: { taskID: string; owner: string; home: string; targetCalendar: string; source: { id: string }; accountID: string }) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string"
    ? [[owned.taskID, "<task>"], [owned.owner, "<owner>"], [owned.home, "<home>"], [owned.targetCalendar, "<target>"], [owned.source.id, "<source>"], [owned.accountID, "<account>"]]
      .reduce((result, [id, placeholder]) => result.split(id!).join(placeholder), item).replace(/DTSTAMP:\d{8}T\d{6}Z/g, "DTSTAMP:<native-stamp>") : item));
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use an explicitly disposable PostgreSQL environment");
  const mode = process.env.MUSUBI_TASK_COMPATIBILITY_MODE ?? "new-only";
  assert(["new-only", "differential"].includes(mode), "Select an explicit supported compatibility evidence mode");
  const differential = mode === "differential";
  if (differential) assert.equal(process.env.MUSUBI_TASK_COMPATIBILITY_QA, "1", "Historical/process acceptance requires its explicit resource gate");
  assert.deepEqual(Object.keys(expectedCases).sort(), cases.map(input => input.name).sort(), "Every routine CI case requires independent expectations");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  let oldSource = "", oldCommit = "", oldPath = "";
  if (differential) {
    // Missing historical data is a failure in explicitly requested differential
    // mode. Routine CI never invokes Git or creates a historical source module.
    oldSource = execFileSync("git", ["show", `${OLD_REVISION}:apps/api/src/sync/task_delivery.ts`], { cwd: root, encoding: "utf8" });
    assert(!oldSource.includes("runClaimedTaskCompatibility"), "The differential baseline must predate this extraction");
    oldCommit = execFileSync("git", ["rev-parse", `${OLD_REVISION}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
    oldPath = fileURLToPath(new URL(`./task_compatibility_old_${randomUUID().replace(/-/g, "")}.ts`, import.meta.url));
    await writeFile(oldPath, oldSource, { flag: "wx" });
  }
  const databaseName = `task_compat_${randomUUID().replace(/-/g, "")}`, databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }), pools = new Set<Pool>();
  const originalConnect = Pool.prototype.connect;
  const connect = mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]): any {
    if (this !== admin) pools.add(this); return Reflect.apply(originalConnect, this, args);
  });
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout;
  const deadlineMs = 123_491, deadline: { expire?: () => void } = {};
  const expireAttempt = () => { const expire = deadline.expire; assert(expire); expire(); };
  const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === deadlineMs) { deadline.expire = () => callback(...args); return originalTimer(callback, 30_000, ...args); }
    return originalTimer(callback, delay, ...args);
  });
  let databaseCreated = false, origin = "", active: {
    input: Case; nativeId: string; uid: string; remote: Record<string, unknown> | null; resource: string | null;
    tag: string; taskReads: number; mutations: number; rejectReadback: boolean; wire: Wire[];
    failures: unknown[]; redirects: (RequestRedirect | undefined)[]; afterRead?: (kind: "list" | "task") => Promise<void>;
  } | undefined;
  const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const server = createServer(async (req, res) => {
    try {
      assert(active, "The closed fixture cannot serve an unowned request");
      const f = active, method = req.method!, url = new URL(req.url!, origin);
      let body = ""; for await (const chunk of req) body += chunk;
      f.wire.push({ method, path: url.pathname + url.search, body, ifMatch: String(req.headers["if-match"] ?? "") || null,
        ifNoneMatch: String(req.headers["if-none-match"] ?? "") || null, contentType: String(req.headers["content-type"] ?? "") || null,
        cacheControl: String(req.headers["cache-control"] ?? "") || null, depth: String(req.headers.depth ?? "") || null,
        authorization: String(req.headers.authorization ?? "") || null, redirect: f.redirects.shift() });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const xml = (href: string, properties: string) => {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      };
      if (f.input.provider === "caldav") {
        assert(url.pathname.startsWith("/dav/") || ["/", "/.well-known/caldav"].includes(url.pathname), `Unowned DAV route: ${url.pathname}`);
        assert.equal(req.headers.authorization, `Basic ${Buffer.from("fixture:fixture-secret").toString("base64")}`);
        if (method === "PROPFIND") {
          const properties = body.includes("current-user-principal") ? "<d:current-user-principal><d:href>/dav/principal/</d:href></d:current-user-principal>" :
            body.includes("calendar-home-set") ? "<c:calendar-home-set><d:href>/dav/home/</d:href></c:calendar-home-set>" :
            body.includes("current-user-privilege-set") ? "<d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set>" :
            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Owned task fixture</d:displayname>";
          return xml(url.pathname, properties);
        }
        if (method === "REPORT") {
          const href = /<(?:\w+:)?href[^>]*>([^<]+)<\/(?:\w+:)?href>/.exec(body)?.[1]; assert(href);
          assert.equal(new URL(href, origin).pathname, new URL(f.nativeId).pathname); assert(f.resource);
          return xml(new URL(f.nativeId).pathname, `<d:getetag>${xmlEscape(f.tag)}</d:getetag><c:calendar-data>${xmlEscape(f.resource)}</c:calendar-data>`);
        }
        if (method === "GET" && ["/", "/.well-known/caldav"].includes(url.pathname)) { res.writeHead(404); return res.end(); }
        assert.equal(url.pathname, new URL(f.nativeId).pathname);
        if (method === "GET") {
          f.taskReads++; await f.afterRead?.("task");
          if (!f.resource) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { "content-type": "text/calendar", etag: f.tag }); return res.end(f.resource);
        }
        if (method === "PUT") {
          f.mutations++;
          if (f.input.action === "create") assert.equal(req.headers["if-none-match"], "*");
          else assert.equal(req.headers["if-match"], '"accepted"');
          assert.match(body, /BEGIN:VCALENDAR/); assert.match(body, new RegExp(`UID:${f.uid}`));
          f.resource = body; f.tag = '"written"'; res.writeHead(201, { etag: f.tag }); return res.end();
        }
        assert.equal(method, "DELETE"); assert.equal(req.headers["if-match"], '"accepted"');
        f.mutations++; f.resource = null; res.writeHead(204); return res.end();
      }
      const google = f.input.provider === "google", list = google ? "/tasks/v1/users/@me/lists/native-list" : "/v1.0/me/todo/lists/native-list";
      const collection = google ? "/tasks/v1/lists/native-list/tasks" : "/v1.0/me/todo/lists/native-list/tasks";
      const item = `${collection}/${encodeURIComponent(f.nativeId)}`;
      assert([list, collection, item].includes(url.pathname), "The closed fixture has no ambient provider fallback");
      assert.equal(req.headers.authorization, `Bearer c08.compat.${f.input.provider}`);
      if (method === "GET") {
        const isList = url.pathname === list;
        if (!isList) f.taskReads++;
        await f.afterRead?.(isList ? "list" : "task");
        if (isList) return json({ id: "native-list", isOwner: true });
        if (f.input.mode === "native-delete-absence" && f.taskReads === 3) f.remote = null;
        if (f.mutations && f.rejectReadback) { f.rejectReadback = false; return json({}, 412); }
        if (!f.remote) return json({}, 404);
        return json(f.remote);
      }
      if (method === "DELETE") {
        assert.equal(url.pathname, item); assert.equal(req.headers["if-match"], google ? '"accepted"' : 'W/"accepted"');
        f.mutations++; f.remote = null; res.writeHead(204); return res.end();
      }
      assert(["POST", "PATCH"].includes(method));
      assert.equal(url.pathname, method === "POST" ? collection : item);
      if (method === "PATCH") assert.equal(req.headers["if-match"], google ? '"accepted"' : 'W/"accepted"');
      else assert.equal(req.headers["if-match"], undefined);
      f.mutations++; f.tag = google ? '"written"' : 'W/"written"';
      const updated = { ...(method === "PATCH" ? f.remote : {}), ...JSON.parse(body), id: f.nativeId,
        ...(google ? { etag: f.tag } : { "@odata.etag": f.tag }) };
      if (["partial-fresh", "partial-recovery"].includes(f.input.mode ?? "")) updated.notes = "Provider notes";
      f.remote = updated;
      if (f.input.mode === "missing-id") return json(google ? { etag: f.tag } : { "@odata.etag": f.tag }, 201);
      return json(f.remote, method === "POST" ? 201 : 200);
    } catch (error) { active?.failures.push(error); res.writeHead(500); res.end("Owned compatibility fixture assertion failed"); }
  });
  let restoreConfig: (() => void) | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); databaseCreated = true; process.env.DATABASE_URL = databaseUrl.href;
    const database = await import("@musubi/db");
    const { db, user, account, caldavAccounts, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      appendTaskOutbox, getTaskOutbox } = database;
    pools.add(db.$client); const observer = new Pool({ connectionString: databaseUrl.href, max: 3 }); pools.add(observer);
    const { config } = await import("@musubi/config"), { migrateDatabase } = await import("../../../../packages/db/src/migrate");
    const priorPrivate = config.security.federationAllowPrivateHosts, priorKey = config.security.caldavEncKey;
    config.security.federationAllowPrivateHosts = true;
    config.security.caldavEncKey ||= "c8".repeat(32);
    restoreConfig = () => { config.security.federationAllowPrivateHosts = priorPrivate; config.security.caldavEncKey = priorKey; };
    const { encryptSecret } = await import("./crypto"), { deliverTaskOutbox } = await import("./task_delivery");
    const oldModule = differential ? await import(pathToFileURL(oldPath).href) as { deliverTaskOutbox: Executor } : undefined;
    const { googleAdapter } = await import("./adapters/google"), { microsoftAdapter } = await import("./adapters/microsoft");
    const { caldavAdapter, toVtodo, icalToNormalizedTask } = await import("./adapters/caldav"), { canonicalTaskProjection } = await import("./task_write");
    // This differential gate exercises precisely the retained host path. The
    // unchanged portable Google precedence remains covered by its own gates.
    const googleCompatibility: CalendarAdapter = { ...googleAdapter, googleTaskCreateV1: undefined, googleTaskUpdateV1: undefined, googleTaskDeleteV1: undefined };
    const adapters: Record<Provider, CalendarAdapter> = { google: googleCompatibility, microsoft: microsoftAdapter, caldav: caldavAdapter };
    await migrateDatabase(); assert.equal(config.api.syncOperationV1EncoderEnabled, true);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    globalThis.fetch = async (input, init) => {
      assert(active);
      const logical = new URL(input instanceof Request ? input.url : String(input));
      assert([origin, "https://tasks.googleapis.com", "https://graph.microsoft.com"].includes(logical.origin), "No live OAuth/provider or unknown-host fallback");
      active.redirects.push(init?.redirect);
      const response = await originalFetch(logical.origin === origin ? input : `${origin}${logical.pathname}${logical.search}`, init);
      Object.defineProperty(response, "url", { value: logical.href }); return response;
    };
    const seed = async (input: Case) => {
      const owner = `task-compat:${randomUUID()}`, home = randomUUID(), targetCalendar = input.secondary ? randomUUID() : home;
      const taskID = randomUUID(), id = randomUUID(), accountID = randomUUID(), uid = input.historicalUid ? "historical-native-uid" : taskID;
      await db.insert(user).values({ id: owner, name: "Task compatibility fixture", email: `${randomUUID()}@example.invalid` });
      if (input.provider === "caldav") await db.insert(caldavAccounts).values({ id: accountID, userID: owner, serverUrl: `${origin}/dav/`, username: "fixture", encryptedPassword: encryptSecret("fixture-secret") });
      else await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: input.provider, accountId: accountID,
        scope: input.provider === "google" ? "https://www.googleapis.com/auth/tasks" : "Tasks.ReadWrite", accessToken: `c08.compat.${input.provider}`,
        refreshToken: "owned-fixture-refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      const calendarIDs = [...new Set([home, targetCalendar])];
      await db.insert(calendars).values(calendarIDs.map(calendarID => ({ id: calendarID, creatorID: owner, name: "Task compatibility", color: "#112233" })));
      await db.insert(calendarMembers).values(calendarIDs.map(calendarID => ({ calendarID, userID: owner, role: "owner" as const })));
      const collection = input.provider === "caldav" ? `${origin}/dav/home/tasks/` : `musubi-${input.provider}-task-list:native-list`;
      const [source] = await db.insert(externalCalendars).values({ calendarID: targetCalendar, provider: input.provider, userID: owner,
        accountID, externalCalendarID: collection, supportsEvents: false, supportsTasks: true }).returning(); assert(source);
      const [storedTask] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID: home, originCalendarID: home, revision: 2,
        title: input.oversize ? `Accepted ${"x".repeat(1100)}` : "Accepted title", description: "Keep notes", status: "in-process",
        start: new Date("2026-10-25T10:00:00.456Z"), due: new Date("2026-10-26T14:45:00.123Z"), completedAt: null,
        priority: 2, percentComplete: 37, sequence: 4, relatedTo: "canonical-parent", url: "https://example.invalid/task",
        recurrence: input.recurring ? "RRULE:FREQ=DAILY;COUNT=3" : null }).returning(); assert(storedTask);
      await db.insert(calendarTasks).values(calendarIDs.map(calendarID => ({ taskID, calendarID })));
      const task = TaskSchema.parse({ ...storedTask, calendarIDs }), adapter = adapters[input.provider]; assert(adapter.projectTask);
      const target = adapter.projectTask(task), baseline = { ...target, title: "Before" };
      const nativeId = input.provider === "caldav" ? `${collection}${input.action === "create" ? taskID : "native-task"}.ics` :
        input.oversize ? `native-${"x".repeat(2050)}` : "provider/task+id";
      const tag = input.provider === "microsoft" ? 'W/"accepted"' : '"accepted"';
      // Historical DAV can have no captured/mapped UID while the complete
      // native resource retains one. Preserve that existing parser floor.
      const priorRef = { externalTaskId: nativeId, etag: tag, icalUid: input.provider === "caldav" && !input.historicalUid ? uid : null };
      const partial = ["partial-fresh", "partial-recovery"].includes(input.mode ?? "");
      const intent: TaskOutboxIntent = { id, actorID: owner, mutationID: randomUUID(), position: 0, taskID,
        calendarID: targetCalendar, externalCalendarLinkID: source.id, provider: input.provider, userID: owner, accountID, externalCalendarID: collection,
        externalTaskID: input.action === "create" ? null : nativeId, expectedEtag: input.action === "create" ? null : tag,
        icalUid: input.action === "create" ? null : priorRef.icalUid, providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: input.action,
        payload: { task, projectionBaseline: partial ? { notes: "Keep notes" } : input.action === "create" ? null : baseline } };
      // Seed actual historical v0 storage directly: no v1 admission/encoder is
      // allowed to sanitize or reject an already persisted legacy identity.
      if (input.legacy) await db.insert(taskOutbox).values({ ...intent, revision: task.revision! });
      else await db.transaction(tx => appendTaskOutbox(tx, task, [intent]));
      let row = await getTaskOutbox(id); assert(row);
      if (input.legacy) assert.equal(row.payload.operationEnvelope, undefined);
      if (input.oversize) assert(nativeId.length > 2048, "Cross the pinned identity budget while retaining the native v0 parser floor");
      if (input.recurring && input.provider !== "caldav") assert.equal(row.payload.operationEnvelope, undefined, "Real admission retains non-DAV recurrence as v0");
      if (input.predecessor) {
        const predecessorID = randomUUID(), mutationID = randomUUID(), envelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope);
        await db.insert(taskOutbox).values({ ...row, id: predecessorID, mutationID, predecessorID: null, status: input.predecessor === "present" ? "completed" : "not-needed",
          uncertain: false, resultRef: input.predecessor === "present" ? priorRef : null, remoteSnapshot: input.predecessor === "present" ? baseline : null,
          createdAt: new Date(row.createdAt.getTime() - 1), payload: { ...row.payload, operationEnvelope: { ...envelope, operationId: predecessorID, commandId: mutationID } } });
        await db.update(taskOutbox).set({ predecessorID, payload: { ...row.payload, operationEnvelope: { ...envelope, predecessorOperationId: predecessorID } } }).where(eq(taskOutbox.id, id));
      }
      if (input.action !== "create") await db.insert(externalTasks).values({ taskID, calendarID: targetCalendar, provider: input.provider, externalCalendarID: collection,
        externalTaskID: nativeId, etag: tag, icalUid: priorRef.icalUid, accountID, externalCalendarLinkID: source.id,
        providerAccessRevision: source.providerAccessRevision, projectionBaseline: baseline, acceptedRevision: 1 });
      const resource = (value: Task) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Owned fixture//EN", "X-RETAINED-CALENDAR:exact bytes",
        toVtodo(value, uid).toString().replace("END:VTODO", "X-RETAINED-TASK:exact bytes\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Keep alarm\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VTODO"),
        "BEGIN:VEVENT", "UID:retained-sibling", "DTSTART:20261025T100000Z", "DTEND:20261025T110000Z", "SUMMARY:Retained event", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
      active = { input, nativeId, uid, remote: input.action === "create" && input.predecessor !== "present" ? null : { ...baseline, id: nativeId,
        ...(input.provider === "microsoft" ? { "@odata.etag": tag } : { etag: tag }) }, resource: input.action === "create" ? null : resource({ ...task, title: "Before" }),
        tag, taskReads: 0, mutations: 0, rejectReadback: ["readback-rejection", "partial-recovery"].includes(input.mode ?? ""), wire: [], failures: [], redirects: [] };
      if (input.recovery) {
        active.remote = { ...target, id: nativeId, ...(input.provider === "microsoft" ? { "@odata.etag": tag } : { etag: tag }) };
        active.resource = resource(task);
        await db.update(taskOutbox).set({ status: "unconfirmed", uncertain: true, resultRef: input.recovery === "known" ? priorRef : null, nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id));
      }
      const initial = await getTaskOutbox(id); assert(initial);
      return { owner, home, targetCalendar, taskID, id, accountID, source, task, target, baseline, priorRef, initial,
        due: () => db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id)),
        async canonical() { return (await db.select().from(tasks).where(eq(tasks.id, taskID)))[0]!; },
        async mapped() { return (await db.select().from(externalTasks).where(and(eq(externalTasks.taskID, taskID), eq(externalTasks.calendarID, targetCalendar))))[0]; },
        async cleanup() { await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner)); await db.delete(user).where(eq(user.id, owner)); } };
    };
    let passed = 0;
    const executors: ["old" | "new", Executor][] = [["new", deliverTaskOutbox]];
    if (oldModule) executors.unshift(["old", oldModule.deliverTaskOutbox]);
    for (const input of cases) {
      let previous: unknown;
      for (const [label, execute] of executors) {
        const f = await seed(input), before = await f.canonical(); assert(active); const native = active;
        let lock: PoolClient | undefined, pending: Promise<TaskOutboxRow | undefined> | undefined;
        try {
          const needsAckLock = input.mode === "ack-cancellation" || input.mode === "ack-lease-expiry";
          if (needsAckLock) lock = await observer.connect();
          native.afterRead = async kind => {
            const beforeDispatch = input.mode === "source-before-dispatch" && kind === "list";
            const beforeAck = native.mutations > 0 && kind === "task";
            if (!beforeDispatch && !beforeAck) return;
            native.afterRead = undefined;
            if (beforeDispatch || input.mode === "source-before-ack") await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id));
            if (input.mode === "privacy-before-ack") await db.update(tasks).set({ providerReadRetiredGeneration: 1 }).where(eq(tasks.id, f.taskID));
            if (input.mode === "mapping-before-ack") await db.insert(externalTasks).values({ taskID: f.taskID, calendarID: f.targetCalendar, provider: input.provider,
              externalCalendarID: f.source.externalCalendarID, externalTaskID: "competing-native-task", etag: '"inbound"', accountID: f.accountID,
              externalCalendarLinkID: f.source.id, providerAccessRevision: f.source.providerAccessRevision, projectionBaseline: { ...f.target, title: "Competing mapping" } });
            if (needsAckLock) { assert(lock); await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [f.taskID]); }
          };
          deadline.expire = undefined;
          pending = execute(f.id, () => adapters[input.provider], { timeoutMs: deadlineMs, heartbeatMs: 10_000 });
          if (needsAckLock) {
            let waiting = false;
            for (let tries = 0; tries < 600; tries++) {
              if ((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%tasks%' AND pid<>pg_backend_pid()")).rowCount) { waiting = true; break; }
              await pause(10);
            }
            assert(waiting, "The production ACK must reach its actual task-row lock");
            if (input.mode === "ack-cancellation") expireAttempt();
            else await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, f.id));
            await lock!.query("COMMIT");
          }
          let result = await pending; assert(result); const first = { status: result.status, code: result.errorCode, uncertain: result.uncertain, resultRef: result.resultRef };
          const recoveryWire: Wire[][] = [];
          if (["missing-id", "partial-recovery", "readback-rejection", "ack-cancellation", "ack-lease-expiry"].includes(input.mode ?? "")) {
            const start = native.wire.length;
            await f.due(); result = await execute(f.id, () => adapters[input.provider], { timeoutMs: deadlineMs }); assert(result);
            recoveryWire.push(native.wire.slice(start));
            assert.equal(native.mutations, 1, "Uncertain recovery never replays the native mutation");
            if (input.mode === "missing-id") { assert.equal(result.status, "unconfirmed"); assert.equal(native.wire.length, start); }
            if (input.mode === "partial-recovery") {
              assert.equal(result.status, "unconfirmed"); assert.equal(result.errorCode, "task-create-unconfirmed");
              assert(native.remote); native.remote.notes = "Keep notes"; const second = native.wire.length;
              await f.due(); result = await execute(f.id, () => adapters[input.provider]); assert.equal(result?.status, "completed");
              recoveryWire.push(native.wire.slice(second));
            }
            for (const reads of recoveryWire) assert(reads.every(request => request.method === "GET"), "Recovery uses native scoped reads only");
          }
          assert(result);
          const stored = await getTaskOutbox(f.id), mapping = await f.mapped(), canonical = await f.canonical(); assert(stored);
          const expected = expectedCases[input.name]!;
          assert.equal(first.status, expected.first ?? expected.status, `${input.name}: independent first settlement`);
          assert.equal(stored.status, expected.status, `${input.name}: independent final settlement`);
          assert.equal(native.mutations, expected.mutations, `${input.name}: independent native mutation count`);
          assert.deepEqual(native.wire.map(request => request.method), expected.methods, `${input.name}: independent complete native method sequence`);
          if (expected.mapping === "absent") assert.equal(mapping, undefined, `${input.name}: no provisional or resurrected mapping`);
          else {
            assert(mapping, `${input.name}: expected native mapping`);
            assert.equal(mapping.externalTaskID, expected.mapping === "competing" ? "competing-native-task" : f.priorRef.externalTaskId);
            assert.equal(mapping.etag, expected.mapping === "baseline" ? f.priorRef.etag : expected.mapping === "competing" ? '"inbound"' : native.tag);
            assert.deepEqual(mapping.projectionBaseline, expected.mapping === "baseline" ? f.baseline : expected.mapping === "competing" ? { ...f.target, title: "Competing mapping" } :
              input.mode === "partial-fresh" ? { ...f.target, notes: "Provider notes" } : f.target);
            if (expected.mapping === "written") assert.equal(mapping.acceptedRevision, 2);
          }
          for (const request of native.wire) {
            if (request.method === "POST") assert.deepEqual(JSON.parse(request.body), f.target, `${input.name}: full admitted native CREATE body`);
            if (request.method === "PATCH") assert.deepEqual(JSON.parse(request.body), { title: f.task.title }, `${input.name}: exact title-only native mask`);
            if (request.method === "PUT") {
              const parsed = icalToNormalizedTask({ url: f.priorRef.externalTaskId, etag: native.tag, data: request.body }); assert(parsed);
              assert.deepEqual(canonicalTaskProjection(parsed), f.target, `${input.name}: complete VTODO native precision and content`);
            }
          }
          assert.deepEqual(stored.payload.operationEnvelope, f.initial.payload.operationEnvelope, "Neither implementation rewrites the original envelope or NULL locator");
          assert.equal(canonical.due?.toISOString(), "2026-10-26T14:45:00.123Z"); assert.equal(canonical.start?.toISOString(), "2026-10-25T10:00:00.456Z");
          assert.equal(canonical.status, "in-process"); assert.equal(canonical.priority, 2); assert.equal(canonical.percentComplete, 37);
          assert.equal(canonical.sequence, 4); assert.equal(canonical.relatedTo, "canonical-parent"); assert.equal(canonical.recurrence, before.recurrence);
          assert.equal(canonical.title, before.title); assert.equal(canonical.description, before.description); assert.equal(canonical.deletedAt, null);
          if (input.secondary && (input.recurring || input.provider === "microsoft")) { assert.equal(stored.status, "blocked"); assert.equal(native.mutations, 0); }
          if (input.mode === "native-delete-absence") { assert.equal(native.mutations, 0); assert.equal(native.taskReads, 3); assert.equal(stored.status, "completed"); }
          if (input.mode === "source-before-dispatch") { assert.equal(native.mutations, 0); assert.equal(stored.status, "blocked"); }
          if (["source-before-ack", "privacy-before-ack"].includes(input.mode ?? "")) { assert.equal(stored.status, "blocked"); assert.equal(stored.uncertain, true); }
          if (input.mode === "mapping-before-ack") { assert.equal(mapping?.externalTaskID, "competing-native-task"); assert.equal(stored.status, "conflict"); }
          if (input.mode === "readback-rejection") { assert.equal(first.status, "unconfirmed"); assert(first.resultRef); }
          if (input.mode === "partial-fresh") { assert.equal(stored.status, "completed"); assert.equal(mapping?.projectionBaseline?.notes, "Provider notes"); }
          if (input.recovery === "unknown" && input.provider !== "caldav") { assert.equal(stored.status, "unconfirmed"); assert.equal(native.wire.length, 0); }
          if (input.provider === "caldav" && input.action === "update" && native.mutations) {
            assert(native.resource?.includes("X-RETAINED-CALENDAR:exact bytes")); assert(native.resource?.includes("X-RETAINED-TASK:exact bytes"));
            assert(native.resource?.includes("UID:retained-sibling")); assert(native.resource?.includes("DESCRIPTION:Keep alarm"));
            assert.equal(mapping?.projectionBaseline?.due, "2026-10-26T14:45:00.000Z");
          }
          assert.deepEqual(native.failures, []);
          // Only generated host identities and native DTSTAMP are normalized.
          // Date precision, validators, complete native bytes, headers and ACK
          // evidence are compared without projection or state reinterpretation.
          const evidence = normalizeOwned({ first, wire: native.wire, remote: native.remote, resource: native.resource,
            stored: { status: stored.status, code: stored.errorCode, uncertain: stored.uncertain, attempts: stored.attempts, action: stored.action,
              externalTaskID: stored.externalTaskID, expectedEtag: stored.expectedEtag, icalUid: stored.icalUid, resultRef: stored.resultRef,
              remoteSnapshot: stored.remoteSnapshot, dispatchProjection: stored.payload.dispatchProjection,
              leaseReleased: stored.leaseToken === null && stored.leaseUntil === null },
            mapping: mapping ? { externalTaskID: mapping.externalTaskID, etag: mapping.etag, icalUid: mapping.icalUid, acceptedRevision: mapping.acceptedRevision,
              baseline: mapping.projectionBaseline, accountID: mapping.accountID, externalCalendarLinkID: mapping.externalCalendarLinkID } : null,
            canonical: { ...TaskSchema.parse(canonical), deletedAt: canonical.deletedAt, providerReadRetiredGeneration: canonical.providerReadRetiredGeneration } }, f);
          if (label === "old") previous = evidence;
          else {
            if (differential) assert.deepEqual(evidence, previous, `${input.name}: actual old/new wire and durable state parity`);
            passed++; console.log(`Task compatibility PG/native ${mode}: ${input.name}: PASS`);
          }
        } finally {
          native.afterRead = undefined; await lock?.query("ROLLBACK").catch(() => {}); lock?.release(); await pending?.catch(() => {}); await f.cleanup(); active = undefined;
        }
      }
    }
    const startWorker = (label: "old" | "new", id: string, provider: Provider, phase: CrashPhase | "recover") => {
      const child = fork(fileURLToPath(import.meta.url), ["--child", label, id, provider, phase], {
        execArgv: ["--import", "tsx"], cwd: root, env: { ...process.env, MUSUBI_TASK_COMPATIBILITY_ORIGIN: origin, MUSUBI_TASK_COMPATIBILITY_OLD_PATH: oldPath },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = ""; child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); });
      const receipt = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = originalTimer(() => { child.kill("SIGKILL"); reject(new Error(`Owned task worker checkpoint timed out: ${provider}/${phase}: ${output}`)); }, 15_000);
        child.on("message", message => { if (message && typeof message === "object" && "kind" in message) { clearTimeout(timeout); resolve(message as Record<string, unknown>); } });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", (code, signal) => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`Owned task worker exited before its receipt: ${code}/${signal}: ${output}`)); } });
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      return { child, receipt, exited };
    };
    let crashPassed = 0;
    if (differential) for (const provider of ["google", "microsoft", "caldav"] as const) for (const action of ["create", "update"] as const) for (const phase of crashPhases) {
      const input: Case = { name: `${provider}-${action}-${phase}`, provider, action, ...(provider === "google" && action === "create" ? { predecessor: "absent" as const } : {}) };
      let previous: unknown;
      for (const label of ["old", "new"] as const) {
        const f = await seed(input); assert(active); const native = active;
        let worker: ReturnType<typeof startWorker> | undefined, recovery: ReturnType<typeof startWorker> | undefined;
        try {
          worker = startWorker(label, f.id, provider, phase);
          const checkpoint = await worker.receipt; assert.equal(checkpoint.kind, "checkpoint"); assert.equal(checkpoint.phase, phase);
          const beforeKill = await getTaskOutbox(f.id), mappingBeforeKill = await f.mapped(); assert(beforeKill);
          assert.equal(native.mutations, 1, "The checkpoint follows one actual accepted native mutation");
          if (phase === "ack-committed") {
            assert.equal(beforeKill.status, "completed"); assert(mappingBeforeKill); assert.equal(mappingBeforeKill.etag, native.tag);
          } else {
            assert.equal(beforeKill.status, "attempting"); assert.equal(beforeKill.resultRef, null, "An in-memory response or observation is not a process journal");
            assert.equal(mappingBeforeKill?.etag ?? null, action === "create" ? null : f.priorRef.etag, "A dead attempt cannot provisionally ACK a mapping");
          }
          worker.child.kill("SIGKILL"); const killed = await worker.exited; assert.equal(killed.signal, "SIGKILL");
          const storedAfterKill = await getTaskOutbox(f.id); assert(storedAfterKill);
          assert.equal(storedAfterKill.status, beforeKill.status); assert.deepEqual(storedAfterKill.resultRef, beforeKill.resultRef);
          if (phase !== "ack-committed") await db.update(taskOutbox).set({ leaseUntil: new Date(0), nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, f.id));
          const start = native.wire.length; recovery = startWorker(label, f.id, provider, "recover");
          const receipt = await recovery.receipt; assert.equal(receipt.kind, "result"); const restarted = await recovery.exited; assert.equal(restarted.code, 0);
          const afterRestart = await getTaskOutbox(f.id), mapping = await f.mapped(), canonical = await f.canonical(); assert(afterRestart);
          assert.equal(native.mutations, 1, "A real restarted worker never replays an uncertain mutation");
          assert(native.wire.slice(start).every(request => request.method === "GET"), "Restart recovery only reads scoped native evidence");
          const unaddressedCreate = action === "create" && provider !== "caldav" && phase !== "ack-committed";
          assert.equal(afterRestart.status, unaddressedCreate ? "unconfirmed" : "completed");
          if (unaddressedCreate || phase === "ack-committed") assert.equal(native.wire.length, start, "No unknown-address CREATE query or completed-operation replay");
          if (unaddressedCreate) { assert.equal(afterRestart.resultRef, null); assert.equal(mapping, undefined); }
          else assert.equal(mapping?.etag, native.tag);
          assert.deepEqual(afterRestart.payload.operationEnvelope, f.initial.payload.operationEnvelope);
          assert.equal(canonical.due?.toISOString(), "2026-10-26T14:45:00.123Z"); assert.equal(canonical.start?.toISOString(), "2026-10-25T10:00:00.456Z");
          assert.equal(canonical.status, "in-process"); assert.equal(canonical.priority, 2); assert.equal(canonical.percentComplete, 37); assert.equal(canonical.sequence, 4);
          assert.deepEqual(native.failures, []);
          const evidence = normalizeOwned({ checkpoint: { status: beforeKill.status, resultRef: beforeKill.resultRef, remoteSnapshot: beforeKill.remoteSnapshot,
              saved: beforeKill.payload.dispatchProjection, mapping: mappingBeforeKill ? { externalTaskID: mappingBeforeKill.externalTaskID, etag: mappingBeforeKill.etag, baseline: mappingBeforeKill.projectionBaseline } : null },
            wire: native.wire, remote: native.remote, resource: native.resource, result: receipt.result,
            final: { status: afterRestart.status, code: afterRestart.errorCode, uncertain: afterRestart.uncertain, resultRef: afterRestart.resultRef,
              remoteSnapshot: afterRestart.remoteSnapshot, saved: afterRestart.payload.dispatchProjection },
            mapping: mapping ? { externalTaskID: mapping.externalTaskID, etag: mapping.etag, baseline: mapping.projectionBaseline } : null,
            canonical: TaskSchema.parse(canonical) }, f);
          // A returned DB row contains dynamic attempt/host metadata; compare
          // its meaningful receipt separately through the stored snapshot above.
          delete evidence.result;
          if (label === "old") previous = evidence;
          else { assert.deepEqual(evidence, previous, `${input.name}: actual SIGKILL/restart old/new parity`); crashPassed++; console.log(`Task compatibility process differential: ${input.name}: PASS`); }
        } finally {
          for (const current of [worker, recovery]) if (current && current.child.exitCode === null && current.child.signalCode === null) { current.child.kill("SIGKILL"); await current.exited; }
          await f.cleanup(); active = undefined;
        }
      }
    }
    console.log(JSON.stringify({ schemaVersion: 1, suite: "task-compatibility-pg-native", mode, cases: passed, crashPairedCases: crashPassed,
      crashPhases: differential ? crashPhases : [], ...(differential ? { baseline: { commit: oldCommit, sourceSha256: createHash("sha256").update(oldSource).digest("hex") } } : {}) }));
  } finally {
    globalThis.fetch = originalFetch; timer.mock.restore(); restoreConfig?.();
    await new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve()); server.closeAllConnections();
    try {
      await Promise.all([...pools].map(pool => pool.end()));
      if (databaseCreated) {
        const sessions = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [databaseName]);
        assert.equal(sessions.rows[0].count, 0, "Close all owned database sessions before nonce DB removal");
        await admin.query(`DROP DATABASE "${databaseName}"`);
        console.log(`Task compatibility cleanup: ${pools.size} owned pools closed, zero sessions, nonce DB dropped without FORCE: PASS`);
      }
    } finally { connect.mock.restore(); await admin.end(); if (oldPath) await unlink(oldPath); }
  }
}
if (process.argv[2] === "--child") void childWorker().then(() => { process.disconnect?.(); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
else void main().catch(error => { console.error(error); process.exitCode = 1; });
