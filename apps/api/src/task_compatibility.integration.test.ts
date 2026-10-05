import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { inArray } from "drizzle-orm";
import { db, user, createCalendar, replaceMemberToken, getTaskSnapshot } from "@musubi/db";
import {
  CLIENT_VERSION_HEADER, MIN_CLIENT_VERSION, PRODUCT_VERSION, TASK_MUTATION_PATH,
  TaskSchema, TaskCreateSchema, TaskMutationResponseSchema, TaskClientUpgradeRequiredSchema, EventMutationError,
} from "@musubi/types";
import { issueMemberToken } from "./federation_tokens";
import { requireAuth } from "./middleware/require_auth";
import { middlewareErrorHandler } from "./middleware/error_handler";
import { registerTaskRoutes } from "./task_routes";

// The released DTO has none of the additive shared-task fields. It can still
// parse both read routes, but cannot parse a mutation receipt as a Task.
const ReleasedTaskSchema = TaskSchema.omit({
  originCalendarID: true, calendarIDs: true, revision: true, capabilities: true,
});

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable PostgreSQL database.");
  const users = [0, 1].map(() => `task-compat-${randomUUID()}`);
  const tokens = users.map(() => issueMemberToken());
  for (let i = 0; i < users.length; i++) {
    await db.insert(user).values({ id: users[i], name: users[i], email: `${users[i]}@example.test`, isExternal: true });
    await replaceMemberToken(users[i], tokens[i].tokenHash);
  }
  const home = await createCalendar({ creatorID: users[0], name: "Task compatibility", color: "#112233" });
  const app = express(); app.use(express.json()); registerTaskRoutes(app); app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (method: string, path: string, body?: unknown, version = PRODUCT_VERSION, actor = 0) => {
    const response = await fetch(origin + path, { method, headers: {
      authorization: `Bearer ${tokens[actor].raw}`, [CLIENT_VERSION_HEADER]: version,
      "content-type": "application/json",
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  let legacyCommits = 0;
  const legacyApp = express(); legacyApp.use(express.json());
  // A released API knows the legacy create URL only and returns a bare Task.
  // This models the version boundary without running obsolete DB writers.
  legacyApp.post("/api/v1/tasks", requireAuth, (req, res) => {
    legacyCommits++;
    res.status(201).json(ReleasedTaskSchema.parse({ ...req.body, creatorID: req.user!.id, sequence: 0 }));
  });
  legacyApp.use(middlewareErrorHandler);
  const legacyServer = legacyApp.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => legacyServer.once("listening", resolve));
  const legacyOrigin = `http://127.0.0.1:${(legacyServer.address() as { port: number }).port}`;
  try {
    // Keep the released 0.2.1 build in the mixed-rollout matrix after the product bump.
    for (const version of new Set([MIN_CLIENT_VERSION, "0.2.1", PRODUCT_VERSION])) {
      const rejectedID = randomUUID();
      const draft = TaskCreateSchema.parse({ id: rejectedID, calendarID: home.id, title: "Retained old draft" });
      for (let attempt = 0; attempt < 2; attempt++) {
        const legacyCreate = await request("POST", "/api/v1/tasks", draft, version);
        assert.equal(legacyCreate.status, 426);
        assert.equal(TaskClientUpgradeRequiredSchema.parse(legacyCreate.body).localCommitted, false);
        assert.match(EventMutationError.from(legacyCreate.body).message, /Update Musubi/,
          "released native/web error parsers preserve update guidance instead of throwing a schema error");
        assert.equal(await getTaskSnapshot(rejectedID), null, "legacy create and retry cannot commit");
      }
      // Header/product version does not select a response shape or bypass CAS.
      const id = randomUUID();
      const created = await request("POST", TASK_MUTATION_PATH, { ...draft, id }, version);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const receipt = TaskMutationResponseSchema.parse(created.body);
      assert.equal(receipt.localCommitted, true); assert.equal(receipt.task?.revision, 1);
      assert.equal(ReleasedTaskSchema.safeParse(created.body).success, false, "why legacy writes must be gated");
      const list = await request("GET", "/api/v1/tasks", undefined, version);
      assert.equal(list.status, 200); assert.ok(ReleasedTaskSchema.array().parse(list.body.tasks).some(task => task.id === id));
      const read = await request("GET", `/api/v1/tasks/${id}`, undefined, version);
      assert.equal(read.status, 200); assert.equal(ReleasedTaskSchema.parse(read.body).id, id);
      const baseline = await getTaskSnapshot(id);
      for (const [method, suffix, body] of [
        ["PATCH", "", { patch: { title: "Must not commit" }, expectedRevision: 1 }],
        ["PUT", "", { ...draft, title: "Must not commit", expectedRevision: 1 }],
        ["DELETE", "", { expectedRevision: 1 }],
        ["POST", "/link", { calendarID: home.id, expectedRevision: 1 }],
        ["POST", "/fork", { calendarID: home.id, expectedRevision: 1 }],
      ] as const) {
        const rejected = await request(method, `/api/v1/tasks/${id}${suffix}`, body, version);
        assert.equal(rejected.status, 426);
        assert.equal(TaskClientUpgradeRequiredSchema.parse(rejected.body).taskMutationPath, TASK_MUTATION_PATH);
        assert.deepEqual(await getTaskSnapshot(id), baseline, `${method} legacy path never writes`);
      }
      const missingCAS = await request("PATCH", `${TASK_MUTATION_PATH}/${id}`, { patch: { title: "Bypass" } }, version);
      assert.equal(missingCAS.status, 400);
      const staleCAS = await request("PATCH", `${TASK_MUTATION_PATH}/${id}`, { expectedRevision: 2, patch: { title: "Bypass" } }, version);
      assert.equal(staleCAS.status, 409); assert.equal(staleCAS.body.localCommitted, false);
      const stalePrivacy = await request("PATCH", `${TASK_MUTATION_PATH}/${id}`, { expectedRevision: 1, expectedProviderReadRetiredGeneration: 1, patch: { title: "Bypass" } }, version);
      assert.equal(stalePrivacy.status, 409); assert.equal(stalePrivacy.body.localCommitted, false);
      const unreadable = await request("PATCH", `${TASK_MUTATION_PATH}/${id}`, { expectedRevision: 1, patch: { title: "Bypass" } }, version, 1);
      assert.equal(unreadable.status, 404, "new namespace does not grant task access");
      assert.deepEqual(await getTaskSnapshot(id), baseline);
      const updated = await request("PATCH", `${TASK_MUTATION_PATH}/${id}`, { expectedRevision: 1, expectedProviderReadRetiredGeneration: 0, patch: { title: "Committed with CAS" } }, version);
      assert.equal(updated.status, 200); assert.equal(TaskMutationResponseSchema.parse(updated.body).task?.revision, 2);
      for (const [method, suffix] of [["POST", ""], ["PATCH", `/${id}`], ["PUT", `/${id}`], ["DELETE", `/${id}`], ["POST", `/${id}/link`], ["POST", `/${id}/fork`]]) {
        const oldAPI = await fetch(legacyOrigin + TASK_MUTATION_PATH + suffix, { method, headers: {
          authorization: `Bearer ${tokens[0].raw}`, [CLIENT_VERSION_HEADER]: version, "content-type": "application/json",
        }, body: JSON.stringify(draft) });
        assert.equal(oldAPI.status, 404, "new client on old API cannot commit through a legacy URL");
      }
      assert.equal(legacyCommits, 0);
    }
    const positiveControl = await fetch(legacyOrigin + "/api/v1/tasks", { method: "POST", headers: {
      authorization: `Bearer ${tokens[0].raw}`, [CLIENT_VERSION_HEADER]: MIN_CLIENT_VERSION, "content-type": "application/json",
    }, body: JSON.stringify({ id: randomUUID(), calendarID: home.id, title: "Released contract" }) });
    assert.equal(positiveControl.status, 201); ReleasedTaskSchema.parse(await positiveControl.json());
    assert.equal(legacyCommits, 1, "released fixture would commit if a client fell back to legacy create");
    assert.equal((await fetch(origin + TASK_MUTATION_PATH, { method: "POST", headers: { [CLIENT_VERSION_HEADER]: PRODUCT_VERSION } })).status, 401);
    console.log("Task compatibility: old/new clients and APIs, read DTOs, pre-write upgrade gate, no fallback, CAS/privacy/auth OK");
  } finally {
    for (const instance of [server, legacyServer]) {
      instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve()));
    }
    await db.delete(user).where(inArray(user.id, users));
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
