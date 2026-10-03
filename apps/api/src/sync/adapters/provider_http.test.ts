import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

function activeGoogleEvent(id: string) {
  return {
    id,
    status: "confirmed",
    summary: id,
    start: { dateTime: "2026-07-23T09:00:00.000Z" },
    end: { dateTime: "2026-07-23T10:00:00.000Z" },
  };
}

function graphEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: id,
    isAllDay: false,
    start: { dateTime: "2026-07-23T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-07-23T10:00:00.0000000", timeZone: "UTC" },
    ...extra,
  };
}

function graphTask(id: string, extra: Record<string, unknown> = {}) {
  return {
    "@odata.etag": `"${id}-etag"`,
    body: { content: `${id} notes`, contentType: "text" },
    id,
    importance: "normal",
    status: "notStarted",
    title: id,
    ...extra,
  };
}

async function main() {
  const requests: {
    url: URL;
    authorization?: string;
    ifMatch?: string;
    method?: string;
    prefer?: string;
  }[] = [];
  let googleRetryAttempts = 0;
  let googleTaskWritten = false;
  let graphMasterRequests = 0;
  let origin = "";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    requests.push({
      url,
      authorization: req.headers.authorization,
      ifMatch:
        typeof req.headers["if-match"] === "string"
          ? req.headers["if-match"]
          : undefined,
      method: req.method,
      prefer:
        typeof req.headers.prefer === "string" ? req.headers.prefer : undefined,
    });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.includes("/google/calendars/retry/")) {
      googleRetryAttempts++;
      if (googleRetryAttempts === 1) return json(503, { error: "temporary" });
      return json(200, { items: [], nextSyncToken: "retry-fresh" });
    }
    if (url.pathname === "/google-tasks/lists/task-list/tasks") {
      if (req.method === "POST") {
        return json(200, { etag: '"task-created-etag"', id: "task-created" });
      }
      if (!url.searchParams.get("pageToken")) {
        return json(200, {
          items: [
            {
              due: "2026-07-25T00:00:00.000Z",
              etag: '"task-etag-1"',
              id: "task-1",
              notes: "Bring the checklist",
              status: "needsAction",
              title: "Prepare release",
            },
            {
              deleted: true,
              etag: '"task-etag-deleted"',
              id: "task-deleted",
              status: "needsAction",
            },
          ],
          nextPageToken: "tasks-page-2",
        });
      }
      return json(200, {
        items: [
          {
            completed: "2026-07-24T12:30:00.000Z",
            etag: '"task-etag-2"',
            id: "task-2",
            status: "completed",
            title: "Ship release",
          },
        ],
      });
    }
    if (
      url.pathname === "/google-tasks/lists/task-list/tasks/task-created" &&
      req.method === "GET"
    ) {
      return json(200, { id: "task-created", etag: googleTaskWritten ? '"task-updated-etag"' : '"task-created-etag"', title: "Provider write", notes: "Write test", due: "2026-07-26T00:00:00.000Z", status: googleTaskWritten ? "completed" : "needsAction" });
    }
    if (
      url.pathname === "/google-tasks/lists/task-list/tasks/task-created" &&
      req.method === "PATCH"
    ) {
      googleTaskWritten = true;
      return json(200, { etag: '"task-updated-etag"', id: "task-created" });
    }
    if (
      url.pathname === "/google-tasks/lists/task-list/tasks/task-created" &&
      req.method === "DELETE"
    ) {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.includes("/google/calendars/calendar-1/")) {
      const syncToken = url.searchParams.get("syncToken");
      const pageToken = url.searchParams.get("pageToken");
      if (syncToken === "stale" && !pageToken) {
        return json(200, {
          items: [activeGoogleEvent("discard-before-410")],
          nextPageToken: "stale-page-2",
        });
      }
      if (syncToken === "stale" && pageToken === "stale-page-2") {
        return json(410, { error: "sync token expired" });
      }
      if (!syncToken && !pageToken) {
        return json(200, {
          items: [activeGoogleEvent("fresh-event")],
          nextPageToken: "full-page-2",
        });
      }
      if (!syncToken && pageToken === "full-page-2") {
        return json(200, {
          items: [{ id: "deleted-event", status: "cancelled" }],
          nextSyncToken: "fresh-cursor",
        });
      }
    }

    if (url.pathname === "/graph-task-expired") {
      return json(200, {
        value: [graphTask("discard-task-before-410")],
        "@odata.nextLink": `${origin}/graph-task-expired-page-2`,
      });
    }
    if (url.pathname === "/graph-task-expired-page-2") {
      return json(410, { error: { message: "delta expired" } });
    }
    if (
      url.pathname === "/graph/me/todo/lists/task-list/tasks/delta" &&
      req.method === "GET"
    ) {
      return json(200, {
        value: [
          graphTask("todo-1", {
            dueDateTime: {
              dateTime: "2026-07-27T15:00:00.0000000",
              timeZone: "UTC",
            },
            importance: "high",
          }),
          { "@removed": { reason: "deleted" }, id: "todo-deleted" },
        ],
        "@odata.nextLink": `${origin}/graph-task-page-2`,
      });
    }
    if (url.pathname === "/graph-task-page-2") {
      return json(200, {
        value: [
          graphTask("todo-2", {
            completedDateTime: {
              dateTime: "2026-07-26T12:00:00.0000000",
              timeZone: "UTC",
            },
            status: "completed",
          }),
        ],
        "@odata.deltaLink": `${origin}/graph-task-delta-fresh`,
      });
    }
    if (
      url.pathname === "/graph/me/todo/lists/task-list/tasks" &&
      req.method === "POST"
    ) {
      return json(201, graphTask("todo-created"));
    }
    if (
      url.pathname === "/graph/me/todo/lists/task-list/tasks/todo-created" &&
      req.method === "PATCH"
    ) {
      return json(
        200,
        graphTask("todo-created", { "@odata.etag": '"todo-updated-etag"' }),
      );
    }
    if (
      url.pathname === "/graph/me/todo/lists/task-list/tasks/todo-created" &&
      req.method === "DELETE"
    ) {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/graph-expired") {
      return json(200, {
        value: [
          {
            id: "discard-before-410",
            type: "occurrence",
            seriesMasterId: "master-1",
            start: { dateTime: "2026-07-20T09:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-07-20T10:00:00.0000000", timeZone: "UTC" },
          },
        ],
        "@odata.nextLink": `${origin}/graph-expired-page-2`,
      });
    }
    if (url.pathname === "/graph-expired-page-2") {
      return json(410, { error: { message: "delta expired" } });
    }
    if (
      url.pathname.includes(
        "/graph/me/calendars/calendar-graph/calendarView/delta",
      )
    ) {
      return json(200, {
        value: [
          graphEvent("master-definition", { type: "seriesMaster" }),
          {
            id: "occurrence-1",
            type: "occurrence",
            seriesMasterId: "master-1",
            start: { dateTime: "2026-07-24T09:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-07-24T10:00:00.0000000", timeZone: "UTC" },
          },
        ],
        "@odata.nextLink": `${origin}/graph-page-2`,
      });
    }
    if (url.pathname === "/graph/me/calendars/calendar-graph/events/master-1") {
      graphMasterRequests++;
      return json(
        200,
        graphEvent("master-1", {
          subject:
            graphMasterRequests === 1 ? "Stale title" : "Inherited title",
        }),
      );
    }
    if (url.pathname === "/graph-page-2") {
      return json(200, {
        value: [
          {
            id: "occurrence-2",
            type: "occurrence",
            seriesMasterId: "master-1",
            start: { dateTime: "2026-07-25T09:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-07-25T10:00:00.0000000", timeZone: "UTC" },
          },
        ],
        "@odata.deltaLink": `${origin}/graph-delta-fresh`,
      });
    }

    return json(500, { error: `Unhandled fake-provider request: ${url}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake provider did not bind a TCP port.");
  origin = `http://127.0.0.1:${address.port}`;

  try {
    const { hasProviderSyncScopes } = await import("@musubi/db");
    assert.equal(
      hasProviderSyncScopes(
        "google",
        "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks",
      ),
      true,
    );
    // Better Auth persists OAuth scopes as a comma-separated string.
    assert.equal(
      hasProviderSyncScopes(
        "google",
        "openid,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/tasks",
      ),
      true,
    );
    assert.equal(
      hasProviderSyncScopes(
        "google",
        "openid https://www.googleapis.com/auth/calendar.events",
      ),
      true,
    );
    assert.equal(
      hasProviderSyncScopes(
        "microsoft",
        "openid Calendars.ReadWrite Tasks.ReadWrite offline_access",
      ),
      true,
    );
    assert.equal(
      hasProviderSyncScopes(
        "microsoft",
        "openid,Calendars.ReadWrite,Tasks.ReadWrite,offline_access",
      ),
      true,
    );
    assert.equal(
      hasProviderSyncScopes("microsoft", "Calendars.ReadWrite"),
      true,
    );

    const {
      createGoogleTask,
      deleteGoogleTask,
      fetchGoogleChanges,
      fetchGoogleTaskChanges,
      toExternalGoogleTaskList,
      toGoogleTask,
      updateGoogleTask,
    } = await import("./google");
    const google = await fetchGoogleChanges(
      "google-access",
      "calendar-1",
      "stale",
      { baseUrl: `${origin}/google` },
    );
    assert.equal(google.reset, true);
    assert.equal(google.nextCursor, "fresh-cursor");
    assert.deepEqual(
      google.changes.filter(change => change.kind !== "event-resource").map(({ data: { externalId, status } }) => ({
        externalId,
        status,
      })),
      [
        { externalId: "fresh-event", status: "active" },
        { externalId: "deleted-event", status: "cancelled" },
      ],
    );
    assert.equal(
      google.changes.filter(change => change.kind !== "event-resource").some(
        ({ data }) => data.externalId === "discard-before-410",
      ),
      false,
    );

    await assert.rejects(
      fetchGoogleChanges("google-access", "retry", null, {
        baseUrl: `${origin}/google`,
      }),
      /Google 503/,
    );
    const retried = await fetchGoogleChanges("google-access", "retry", null, {
      baseUrl: `${origin}/google`,
    });
    assert.equal(retried.nextCursor, "retry-fresh");
    assert.equal(googleRetryAttempts, 2);

    assert.deepEqual(
      toExternalGoogleTaskList({ id: "list-1", title: "Work" }),
      {
        color: "#B3A48A",
        externalId: "musubi-google-task-list:list-1",
        name: "Work",
        supportsEvents: false,
        supportsTasks: true,
      },
    );

    const googleTasks = await fetchGoogleTaskChanges(
      "google-access",
      "task-list",
      { baseUrl: `${origin}/google-tasks` },
    );
    assert.equal(googleTasks.reset, true);
    assert.equal(googleTasks.nextCursor, null);
    assert.deepEqual(
      googleTasks.changes.filter(change => change.kind !== "event-resource").map(({ data }) => ({
        completed: data.status === "completed",
        deleted: "deleted" in data && data.deleted === true,
        due: "due" in data ? data.due?.toISOString() : undefined,
        externalId: data.externalId,
      })),
      [
        {
          completed: false,
          deleted: false,
          due: "2026-07-25T00:00:00.000Z",
          externalId: "task-1",
        },
        {
          completed: false,
          deleted: true,
          due: undefined,
          externalId: "task-deleted",
        },
        {
          completed: true,
          deleted: false,
          due: undefined,
          externalId: "task-2",
        },
      ],
    );

    const localTask = {
      calendarID: "local-calendar",
      completedAt: null,
      creatorID: "user-1",
      description: "Write test",
      due: new Date("2026-07-26T00:00:00.000Z"),
      id: "local-task",
      isAllDay: true,
      percentComplete: 0,
      priority: 0,
      recurrence: null,
      relatedTo: null,
      sequence: 0,
      start: null,
      status: "needs-action" as const,
      title: "Provider write",
      url: null,
    };
    assert.deepEqual(
      toGoogleTask({ ...localTask, description: null, due: null }),
      {
        due: null,
        notes: null,
        status: "needsAction",
        title: "Provider write",
      },
    );
    const createdTask = await createGoogleTask(
      "google-access",
      "task-list",
      localTask,
      { baseUrl: `${origin}/google-tasks` },
    );
    assert.deepEqual(createdTask, {
      etag: '"task-created-etag"',
      externalTaskId: "task-created",
      icalUid: null,
    });
    await assert.rejects(
      updateGoogleTask(
        "google-access",
        "task-list",
        "task-created",
        localTask,
        null,
        { baseUrl: `${origin}/google-tasks` },
      ),
      /task-version-unavailable/,
    );
    const updatedTask = await updateGoogleTask(
      "google-access",
      "task-list",
      "task-created",
      { ...localTask, status: "completed" },
      createdTask.etag,
      { baseUrl: `${origin}/google-tasks` },
    );
    assert.equal(updatedTask.etag, '"task-updated-etag"');
    await assert.rejects(updateGoogleTask("google-access", "task-list", "task-created", localTask, createdTask.etag, { baseUrl: `${origin}/google-tasks` }), /task-provider-conflict/, "A successful read cannot adopt a newer task validator");
    await deleteGoogleTask(
      "google-access",
      "task-list",
      "task-created",
      updatedTask.etag,
      { baseUrl: `${origin}/google-tasks` },
    );
    assert.deepEqual(
      requests
        .filter((request) => request.url.pathname.endsWith("/task-created") && request.method !== "GET")
        .map(({ ifMatch, method }) => ({ ifMatch, method })),
      [
        { ifMatch: '"task-created-etag"', method: "PATCH" },
        { ifMatch: '"task-updated-etag"', method: "DELETE" },
      ],
    );

    const {
      createMicrosoftTask,
      deleteMicrosoftTask,
      fetchMicrosoftChanges,
      fetchMicrosoftTaskChanges,
      parseCursor,
      toExternalMicrosoftTaskList,
      updateMicrosoftTask,
    } = await import("./microsoft");
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const microsoft = await fetchMicrosoftChanges(
      "graph-access",
      "calendar-graph",
      JSON.stringify({
        link: `${origin}/graph-expired`,
        windowEnd: now + 365 * 86_400_000,
      }),
      {
        graphBase: `${origin}/graph`,
        now,
      },
    );
    assert.equal(microsoft.reset, true);
    assert.deepEqual(
      microsoft.changes.filter(change => change.kind !== "event-resource").map(({ data: { externalId, title } }) => ({
        externalId,
        title,
      })),
      [
        { externalId: "occurrence-1", title: "Inherited title" },
        { externalId: "occurrence-2", title: "Inherited title" },
      ],
    );
    assert.equal(
      microsoft.changes.filter(change => change.kind !== "event-resource").some(
        ({ data }) => data.externalId === "discard-before-410",
      ),
      false,
    );
    // Once during the discarded incremental page, once after reset; occurrence
    // 2 then reuses the fresh full-sync cache.
    assert.equal(graphMasterRequests, 2);
    assert.equal(
      parseCursor(microsoft.nextCursor)?.link,
      `${origin}/graph-delta-fresh`,
    );

    assert.deepEqual(
      toExternalMicrosoftTaskList({
        displayName: "Shared",
        id: "list-1",
        isOwner: false,
      }),
      {
        color: "#B3A48A",
        externalId: "musubi-microsoft-task-list:list-1",
        name: "Shared",
        readOnly: true,
        supportsEvents: false,
        supportsTasks: true,
      },
    );

    const microsoftTasks = await fetchMicrosoftTaskChanges(
      "graph-access",
      "task-list",
      `${origin}/graph-task-expired`,
      { graphBase: `${origin}/graph` },
    );
    assert.equal(microsoftTasks.reset, true);
    assert.equal(microsoftTasks.nextCursor, `${origin}/graph-task-delta-fresh`);
    assert.equal(
      microsoftTasks.changes.filter(change => change.kind !== "event-resource").some(
        ({ data }) => data.externalId === "discard-task-before-410",
      ),
      false,
    );
    assert.deepEqual(
      microsoftTasks.changes.filter(change => change.kind !== "event-resource").map(({ data }) => ({
        deleted: "deleted" in data && data.deleted === true,
        externalId: data.externalId,
        priority: "priority" in data ? data.priority : undefined,
        status: data.status,
      })),
      [
        {
          deleted: false,
          externalId: "todo-1",
          priority: 1,
          status: "needs-action",
        },
        {
          deleted: true,
          externalId: "todo-deleted",
          priority: 0,
          status: "needs-action",
        },
        {
          deleted: false,
          externalId: "todo-2",
          priority: 0,
          status: "completed",
        },
      ],
    );
    const createdMicrosoftTask = await createMicrosoftTask(
      "graph-access",
      "task-list",
      localTask,
      { graphBase: `${origin}/graph` },
    );
    assert.equal(createdMicrosoftTask.externalTaskId, "todo-created");
    await assert.rejects(
      updateMicrosoftTask(
        "graph-access",
        "task-list",
        "todo-created",
        localTask,
        null,
        { graphBase: `${origin}/graph` },
      ),
      /requires an ETag/,
    );
    const updatedMicrosoftTask = await updateMicrosoftTask(
      "graph-access",
      "task-list",
      "todo-created",
      localTask,
      createdMicrosoftTask.etag,
      { graphBase: `${origin}/graph` },
    );
    assert.equal(updatedMicrosoftTask.etag, '"todo-updated-etag"');
    await deleteMicrosoftTask(
      "graph-access",
      "task-list",
      "todo-created",
      updatedMicrosoftTask.etag,
      { graphBase: `${origin}/graph` },
    );
    assert.deepEqual(
      requests
        .filter((request) => request.url.pathname.endsWith("/todo-created"))
        .map(({ ifMatch, method }) => ({ ifMatch, method })),
      [
        { ifMatch: '"todo-created-etag"', method: "PATCH" },
        { ifMatch: '"todo-updated-etag"', method: "DELETE" },
      ],
    );

    assert.ok(
      requests.every(
        (request) =>
          request.authorization ===
          (request.url.pathname.startsWith("/google")
            ? "Bearer google-access"
            : "Bearer graph-access"),
      ),
    );
    const graphRequests = requests.filter((request) =>
      request.url.pathname.startsWith("/graph"),
    );
    assert.ok(
      graphRequests
        .filter((request) => request.method === "GET")
        .every((request) => request.prefer?.includes('outlook.timezone="UTC"')),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  console.log("provider HTTP boundary self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
