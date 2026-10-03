import assert from "node:assert/strict";

// Credential DB reads and Graph transport are test doubles; the actual adapter,
// OAuth scope admission and To Do write methods run without a live provider/DB.
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { db } = await import("@musubi/db");
  const { TaskSchema } = await import("@musubi/types");
  const { microsoftAdapter, microsoftTaskListExternalId } = await import("./microsoft");
  const { ProviderTaskWriteError } = await import("../task_write");
  const { TaskScopeMissingError } = await import("../errors");
  const realFetch = globalThis.fetch, query = db.$client.query;
  const owner = "task-write-owner", accountID = "task-write-account", listID = "list/id";
  const externalCalendarID = microsoftTaskListExternalId(listID);
  const taskID = "task #1", etag = 'W/"accepted-task-version"';
  const task = TaskSchema.parse({ id: "independent-copy", creatorID: owner, calendarID: "new-home", title: "Independent copy", revision: 1 });
  const calls: Array<{ path: string; method: string; options: RequestInit }> = [];
  let credentialsRead = 0, mutationChecks = 0;
  let scope = "Tasks.ReadWrite", nativeList: Record<string, unknown> = { id: listID, isOwner: true };
  let nativeTask: Record<string, unknown> = { id: taskID, title: "Remote task", "@odata.etag": etag };
  let taskStatus = 200, writeStatus = 200;
  db.$client.query = (async (configuration: { text?: string; rowMode?: string }, values: unknown[]) => {
    assert.match(configuration.text ?? "", /^select /i, "adapter checks must never write credential data");
    assert.match(configuration.text ?? "", /from "account"/);
    assert.equal(configuration.rowMode, "array");
    assert.deepEqual(values, [owner, "microsoft", accountID], "credential lookup stays scoped to actor/account");
    credentialsRead++;
    return { command: "SELECT", rowCount: 1, oid: 0, fields: [], rows: [[
      "fixture-account-row", scope, "fixture.oauth-token", null, new Date(Date.now() + 3_600_000).toISOString().replace("T", " ").replace(/Z$/, ""), "active", null, null,
    ]] };
  }) as typeof db.$client.query;
  globalThis.fetch = (async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com", "unexpected token refresh/provider request");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer fixture.oauth-token");
    const path = url.pathname.replace("/v1.0", ""), method = options.method ?? "GET";
    calls.push({ path, method, options });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (path === "/me/todo/lists/list%2Fid" && method === "GET") return json(nativeList);
    if (path === "/me/todo/lists/list%2Fid/tasks/task%20%231" && method === "GET") return json(nativeTask, taskStatus);
    assert.ok(mutationChecks > 0, "writes must follow beforeMutation admission");
    if (path === "/me/todo/lists/list%2Fid/tasks" && method === "POST") {
      assert.equal(JSON.parse(String(options.body)).title, task.title);
      return json({ id: "new-home-provider-task", "@odata.etag": 'W/"new-home-version"' }, 201);
    }
    assert.equal(path, "/me/todo/lists/list%2Fid/tasks/task%20%231");
    assert.equal(new Headers(options.headers).get("If-Match"), etag, "existing-home update/delete preserve native validator");
    if (method === "PATCH") return json({ id: taskID, "@odata.etag": 'W/"next-task-version"' }, writeStatus);
    assert.equal(method, "DELETE");
    return new Response(null, { status: writeStatus === 200 ? 204 : writeStatus });
  }) as typeof fetch;
  const beforeMutation = async () => { mutationChecks++; };
  const writes = () => calls.filter(call => call.method !== "GET");
  const reset = () => { calls.length = 0; mutationChecks = 0; credentialsRead = 0; };
  const errorCode = (code: string) => (error: unknown) => {
    if (!(error instanceof ProviderTaskWriteError)) throw error;
    return error.code === code && error.outcome === "not-written";
  };
  const guardedWrite = async (action: "create" | "update" | "delete", secondary: boolean, expectedEtag: string | null = etag) => {
    const external = { externalTaskId: taskID, etag: expectedEtag };
    await microsoftAdapter.assertTaskWrite!(owner, accountID, externalCalendarID, { action, task, secondary, external });
    if (action === "create") return microsoftAdapter.pushTaskCreate!(owner, accountID, externalCalendarID, task, beforeMutation);
    if (action === "update") return microsoftAdapter.pushTaskUpdate!(owner, accountID, externalCalendarID, taskID, task, { ...external, beforeMutation }, { title: task.title });
    return microsoftAdapter.pushTaskDelete!(owner, accountID, externalCalendarID, taskID, { ...external, beforeMutation });
  };
  try {
    for (const action of ["create", "update", "delete"] as const) {
      reset();
      await assert.rejects(guardedWrite(action, true), errorCode("task-conditional-write-unsupported"), `${action} secondary projection is unsupported even on an owned To Do list`);
      assert.equal(writes().length, 0); assert.equal(mutationChecks, 0);
      assert.deepEqual(calls.map(call => call.path), ["/me/todo/lists/list%2Fid"], "a preflight read is never treated as conditional-write proof");
    }
    for (const isOwner of [false, undefined]) {
      nativeList = { id: listID, isOwner }; reset();
      await assert.rejects(guardedWrite("create", true), errorCode("task-source-read-only"));
      assert.equal(writes().length, 0); assert.equal(mutationChecks, 0);
    }
    nativeList = { id: "wrong-list", isOwner: true }; reset();
    await assert.rejects(guardedWrite("create", false), errorCode("task-projection-unavailable"));
    assert.equal(writes().length, 0);
    nativeList = { id: listID, isOwner: true }; scope = "Calendars.ReadWrite"; reset();
    await assert.rejects(guardedWrite("create", false), error => error instanceof TaskScopeMissingError);
    assert.equal(calls.length, 0, "calendar-only grant does not reach To Do");
    scope = "Tasks.ReadWrite"; reset();
    await assert.rejects(() => microsoftAdapter.assertTaskWrite!(owner, accountID, "outlook-event-calendar", { action: "create", task, secondary: false }), errorCode("task-source-read-only"));
    assert.equal(calls.length, 0); assert.equal(credentialsRead, 0);

    reset();
    const copied = await guardedWrite("create", false);
    assert.equal((copied as { externalTaskId: string }).externalTaskId, "new-home-provider-task");
    assert.deepEqual(writes().map(call => call.method), ["POST"]);
    assert.equal(mutationChecks, 1, "independent home copy stays supported after source admission");

    for (const action of ["update", "delete"] as const) {
      reset();
      await assert.rejects(guardedWrite(action, false, null), errorCode("task-version-unavailable"));
      assert.equal(writes().length, 0); assert.equal(mutationChecks, 0);
      nativeTask = { ...nativeTask, "@odata.etag": 'W/"changed-task-version"' }; reset();
      await assert.rejects(guardedWrite(action, false), errorCode("task-provider-conflict"));
      assert.equal(writes().length, 0); assert.equal(mutationChecks, 0);
      nativeTask = { ...nativeTask, "@odata.etag": etag }; reset();
      await guardedWrite(action, false);
      assert.deepEqual(writes().map(call => call.method), [action === "update" ? "PATCH" : "DELETE"]);
      assert.equal(mutationChecks, 1);
      writeStatus = 412; reset();
      await assert.rejects(guardedWrite(action, false), errorCode("task-provider-conflict"));
      assert.equal(writes().length, 1, "a home conflict is never retried without its validator");
      writeStatus = 200;
    }
    taskStatus = 404; reset();
    await microsoftAdapter.assertTaskWrite!(owner, accountID, externalCalendarID, { action: "delete", task, secondary: false, external: { externalTaskId: taskID, etag } });
    assert.equal(writes().length, 0, "an already missing home task is an idempotent delete preflight");
    console.log("Microsoft task adapter: all secondary fanout rejected without write; home copy, scope/list/version admission and existing conditional update/delete preserved OK");
  } finally {
    globalThis.fetch = realFetch; db.$client.query = query;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
