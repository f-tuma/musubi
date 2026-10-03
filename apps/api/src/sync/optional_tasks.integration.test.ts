import assert from "node:assert/strict";
import { auth } from "@musubi/auth";
import { google, microsoft } from "better-auth/social-providers";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import {
  account, CALENDAR_SCOPE, TASK_SCOPE, db, events, externalTasks, tasks,
  getOAuthAccountIDs, getOAuthCredentials, getExternalSyncUserIDs,
  getUserExternalCalendars, oauthConnectionCheck, user,
} from "@musubi/db";
import { googleAdapter } from "./adapters/google";
import { microsoftAdapter } from "./adapters/microsoft";
import { syncProvider } from "./engine";
import { isOptionalTaskError, ProviderAuthError, TaskScopeMissingError } from "./errors";

// Real adapters, token endpoint HTTP, engine and DB. All external destinations
// are redirected to this disposable fixture; unexpected requests fail closed.
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const oauthProviders = [
    google({ ...auth.options.socialProviders.google, clientId: "fixture-client", clientSecret: "fixture-secret" }),
    microsoft({ ...auth.options.socialProviders.microsoft, clientId: "fixture-client", clientSecret: "fixture-secret" }),
  ];
  for (const adapter of [googleAdapter, microsoftAdapter]) {
    const provider = adapter.provider;
    const google = provider === "google";
    const oauthProvider = oauthProviders.find((item) => item.id === provider)!;
    for (const includeTasks of [false, true]) {
      const url = await oauthProvider.createAuthorizationURL({ state: "fixture-state", codeVerifier: "fixture-verifier", redirectURI: "http://localhost:7531/api/auth/callback/fixture", scopes: [CALENDAR_SCOPE[provider], ...(includeTasks ? [TASK_SCOPE[provider]] : [])] });
      assert.equal(url.searchParams.get("scope")?.split(" ").includes(TASK_SCOPE[provider]), includeTasks, "Better Auth/provider defaults must not add Tasks to calendar-only requests");
      if (google) assert.equal(url.searchParams.get("include_granted_scopes"), "true", "Google incremental consent retains already granted capabilities");
    }
    const userID = `optional-tasks-${randomUUID()}`;
    const rowID = randomUUID();
    let mode = "complete";
    let revision = 0;
    let revoked = false;
    let returnedScope: string | undefined;
    let taskCalls = 0;
    let recoveredResource401 = false;
    const refreshBodies: URLSearchParams[] = [];
    const graph = "https://graph.microsoft.com/v1.0";
    const fixture = createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture.test");
      const path = url.pathname;
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path.endsWith("/token")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          refreshBodies.push(new URLSearchParams(body));
          json(revoked ? { error: "invalid_grant" } : { access_token: "fixture-access", expires_in: 3600, ...(returnedScope === undefined ? {} : { scope: returnedScope }) }, revoked ? 400 : 200);
        });
        return;
      }
      if (req.headers.authorization === "Bearer stale-fixture-access") return json({}, 401);
      assert.equal(req.headers.authorization, "Bearer fixture-access");
      if (path.includes("/todo/") || path.startsWith("/tasks/")) {
        taskCalls++;
        const items = path.includes("/lists/list/");
        if (mode === "mutation401") return json({}, 401);
        if (google && !recoveredResource401 && ((mode === "taskstale401" && !items) || (mode === "tasks-page401" && url.searchParams.has("pageToken")) || (mode === "itemsstale401" && items))) {
          recoveredResource401 = true;
          return json({}, 401);
        }
        if (mode === "discovery403" && !items) return json({}, 403);
        if (mode === "discovery503" && !items) return json({}, 503);
        if (mode === "discovery401" && !items) return json({}, 401);
        if (mode === "fetch403" && items) return json({}, 403);
        if (mode === "fetch503" && items) return json({}, 503);
        if (mode === "fetch401" && items) return json({}, 401);
        const incomplete = mode === (items ? "items-page2" : "lists-page2");
        if (url.searchParams.has("pageToken")) return mode === "tasks-page401" ? json({ items: [] }) : json({}, 503);
        const data = items
          ? (google ? { id: "task", title: "Remote task", status: "needsAction", etag: "task-v1" }
            : { id: "task", title: "Remote task", status: "notStarted", "@odata.etag": "task-v1" })
          : (google ? { id: "list", title: "Tasks" } : { id: "list", displayName: "Tasks" });
        const values = mode === "empty" ? [] : [data];
        return json(google
          ? { items: values, ...(incomplete || mode === "tasks-page401" && !items ? { nextPageToken: "second" } : {}) }
          : { value: values, ...(incomplete ? { "@odata.nextLink": `${graph}${items ? "/me/todo/lists/list/tasks/delta" : "/me/todo/lists"}?pageToken=second` }
            : items ? { "@odata.deltaLink": `${graph}/me/todo/lists/list/tasks/delta` } : {}) });
      }
      if (path.endsWith("/calendarList")) return json({ items: [{ id: "calendar", summary: "Events", backgroundColor: "#7A8BA3", accessRole: "owner" }] });
      if (path === "/v1.0/me/calendars") return json({ value: [{ id: "calendar", name: "Events", canEdit: true }] });
      if (path.endsWith("/events")) return json({ items: [{ id: "event", summary: `Event ${revision}`, start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } }], nextSyncToken: `cursor-${revision}` });
      if (path.includes("/calendarView/delta")) return json({ value: [{ id: "event", subject: `Event ${revision}`, type: "singleInstance", start: { dateTime: "2026-09-01T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-09-01T10:00:00", timeZone: "UTC" } }], "@odata.deltaLink": `${graph}/me/calendars/calendar/calendarView/delta?revision=${revision}` });
      return json({ error: { message: `Unexpected fixture request: ${path}` } }, 500);
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      assert.ok(["www.googleapis.com", "tasks.googleapis.com", "oauth2.googleapis.com", "graph.microsoft.com", "login.microsoftonline.com"].includes(url.hostname), "No live provider requests");
      return realFetch(`${origin}${url.pathname}${url.search}`, init);
    };
    await db.insert(user).values({ id: userID, name: "Optional tasks", email: `${userID}@example.test` });
    const update = (values: Partial<typeof account.$inferInsert>) => db.update(account).set(values).where(eq(account.id, rowID));
    const links = () => getUserExternalCalendars(provider, userID, "account");
    const run = () => syncProvider(adapter, userID, { id: "account", label: "Fixture" });
    try {
      await db.insert(account).values({ id: rowID, userId: userID, providerId: provider, accountId: "account", scope: CALENDAR_SCOPE[provider], refreshToken: "fixture-refresh" });
      assert.deepEqual(await getOAuthAccountIDs(userID, provider), ["account"]);
      assert.ok((await getExternalSyncUserIDs()).includes(userID));
      assert.equal((await oauthConnectionCheck(userID, provider)).calendarConnected, true);
      await run();
      assert.equal(taskCalls, 0, "Calendar-only never calls Tasks");
      assert.equal((await links()).length, 1);
      assert.equal(refreshBodies.length, 1);
      assert.equal(refreshBodies[0].get("scope"), null, "Refresh must not escalate or narrow the original grant");

      await update({ scope: `${CALENDAR_SCOPE[provider]},${TASK_SCOPE[provider]}`, accessTokenExpiresAt: new Date(0) });
      await run();
      assert.equal(refreshBodies.length, 2);
      assert.equal(refreshBodies[1].get("scope"), null, "Refresh also retains already granted Tasks");
      const taskLink = (await links()).find((link) => link.supportsTasks)!;
      assert.ok(taskLink);
      const beforeTasks = await db.select().from(tasks).where(eq(tasks.creatorID, userID));
      assert.equal(beforeTasks.length, 1, "Full consent imports Tasks alongside events");
      const beforeMappings = await db.select().from(externalTasks).where(eq(externalTasks.calendarID, taskLink.calendarID));
      assert.equal(beforeMappings.length, 1);
      if (google) {
        // The stored expiry can still look valid after the provider rejects the
        // token. Refresh the concrete Calendar GET, retaining the same sync.
        await update({ accessToken: "stale-fixture-access", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
        const refreshCount = refreshBodies.length;
        await run();
        assert.equal(refreshBodies.length, refreshCount + 1);
        for (const readFailure of ["taskstale401", "tasks-page401", "itemsstale401"]) {
          mode = readFailure;
          recoveredResource401 = false;
          const refreshCount: number = refreshBodies.length;
          await run();
          assert.ok(recoveredResource401, `${readFailure}: exercised resource 401`);
          assert.equal(refreshBodies.length, refreshCount + 1, `${readFailure}: one refresh`);
          assert.deepEqual(await db.select().from(tasks).where(eq(tasks.creatorID, userID)), beforeTasks);
          assert.deepEqual(await db.select().from(externalTasks).where(eq(externalTasks.calendarID, taskLink.calendarID)), beforeMappings);
        }

        // A force refresh may narrow Tasks consent. Check the new grant before
        // replaying the rejected Tasks GET, while still importing Calendar data.
        mode = "taskstale401";
        recoveredResource401 = false;
        returnedScope = CALENDAR_SCOPE[provider];
        const beforeCalls = taskCalls;
        await run();
        assert.equal(taskCalls, beforeCalls + 1, "No retried Tasks GET after refresh narrows consent");
        assert.deepEqual(await db.select().from(tasks).where(eq(tasks.creatorID, userID)), beforeTasks);
        assert.deepEqual(await db.select().from(externalTasks).where(eq(externalTasks.calendarID, taskLink.calendarID)), beforeMappings);
        returnedScope = undefined;
        await update({ scope: `${CALENDAR_SCOPE[provider]},${TASK_SCOPE[provider]}` });
        mode = "mutation401";
        const mutationCalls: number = taskCalls;
        const mutationRefreshes: number = refreshBodies.length;
        await assert.rejects(adapter.pushTaskCreate!(userID, "account", taskLink.externalCalendarID, beforeTasks[0] as never));
        assert.equal(taskCalls, mutationCalls + 1, "A rejected POST must never be replayed");
        assert.equal(refreshBodies.length, mutationRefreshes, "Mutation 401 does not force a refresh or hide its outcome");
      }
      for (const failure of ["missing", "narrowed", "discovery403", "discovery503", "lists-page2", "fetch403", "fetch503", "items-page2"]) {
        mode = failure;
        revision++;
        returnedScope = failure === "narrowed" ? CALENDAR_SCOPE[provider] : undefined;
        await update({ scope: failure === "missing" ? CALENDAR_SCOPE[provider] : `${CALENDAR_SCOPE[provider]},${TASK_SCOPE[provider]}`, ...(failure === "narrowed" ? { accessTokenExpiresAt: new Date(0) } : {}) });
        const beforeCalls: number = taskCalls;
        await run();
        if (failure === "missing" || failure === "narrowed") {
          assert.equal(taskCalls, beforeCalls);
          // Direct reads and task/list writes must also be gated, not merely the scheduler.
          await assert.rejects(adapter.fetchChanges(userID, "account", taskLink.externalCalendarID, null), TaskScopeMissingError);
          await assert.rejects(adapter.pushTaskCreate!(userID, "account", taskLink.externalCalendarID, beforeTasks[0] as never), TaskScopeMissingError);
          await assert.rejects(adapter.pushTaskUpdate!(userID, "account", taskLink.externalCalendarID, "task", beforeTasks[0] as never), TaskScopeMissingError);
          await assert.rejects(adapter.pushTaskDelete!(userID, "account", taskLink.externalCalendarID, "task"), TaskScopeMissingError);
          await assert.rejects(adapter.updateCalendar(userID, "account", taskLink.externalCalendarID, { name: "Changed", color: "#7A8BA3" }), TaskScopeMissingError);
          await assert.rejects(adapter.deleteCalendar(userID, "account", taskLink.externalCalendarID), TaskScopeMissingError);
          assert.equal(taskCalls, beforeCalls);
        }
        assert.deepEqual(await db.select().from(tasks).where(eq(tasks.creatorID, userID)), beforeTasks, failure);
        assert.deepEqual(await db.select().from(externalTasks).where(eq(externalTasks.calendarID, taskLink.calendarID)), beforeMappings, failure);
        assert.deepEqual((await links()).find((link) => link.calendarID === taskLink.calendarID), taskLink, `${failure}: task mirror/cursor unchanged`);
        const [event] = await db.select().from(events).where(eq(events.creatorID, userID));
        assert.equal(event.title, `Event ${revision}`, `${failure}: events still import`);
        const eventLink = (await links()).find((link) => link.supportsEvents)!;
        assert.ok(eventLink.cursor?.includes(google ? `cursor-${revision}` : `revision=${revision}`), `${failure}: event cursor advances`);
        assert.equal((await getOAuthCredentials(userID, provider, "account"))?.refreshToken, "fixture-refresh");
        assert.equal((await oauthConnectionCheck(userID, provider)).calendarConnected, true);
      }
      for (const failure of ["discovery401", "fetch401"]) {
        mode = failure;
        const beforeCalls = taskCalls;
        await assert.rejects(run(), /401/, "Resource authentication failure must not be swallowed as optional Tasks");
        const rejectedCalls: number = taskCalls - beforeCalls - (failure === "fetch401" ? 1 : 0);
        assert.equal(rejectedCalls, google ? 2 : 1, "Google retries the rejected GET only once");
        assert.equal((await getOAuthCredentials(userID, provider, "account"))?.syncStatus, "active", "A resource 401 alone must not delete refresh credentials");
      }
      // Revocation between discovery and the task fetch must escape the
      // optional collection fault boundary. Only inject expiry timing; the
      // adapter/token HTTP and all preservation checks remain real.
      mode = "complete";
      await assert.rejects(syncProvider({
        ...adapter,
        fetchChanges: async (...args) => {
          if (args[2] === taskLink.externalCalendarID) {
            revoked = true;
            await update({ accessTokenExpiresAt: new Date(0) });
          }
          return adapter.fetchChanges(...args);
        },
      }, userID, { id: "account", label: "Fixture" }), (error: unknown) => error instanceof ProviderAuthError && error.reconnectRequired && error.code === "invalid_grant");
      assert.equal((await getOAuthCredentials(userID, provider, "account"))?.syncStatus, "reconnect_required");
      assert.deepEqual(await db.select().from(tasks).where(eq(tasks.creatorID, userID)), beforeTasks);
      assert.deepEqual(await db.select().from(externalTasks).where(eq(externalTasks.calendarID, taskLink.calendarID)), beforeMappings);
      revoked = false;
      await update({ refreshToken: "fixture-refresh", syncStatus: "active", syncErrorCode: null });

      // A refresh-time scope loss must also stop direct task mutations.
      returnedScope = CALENDAR_SCOPE[provider];
      const callsBeforeNarrowedWrites: number = taskCalls;
      for (const write of [
        () => adapter.pushTaskCreate!(userID, "account", taskLink.externalCalendarID, beforeTasks[0] as never),
        () => adapter.pushTaskUpdate!(userID, "account", taskLink.externalCalendarID, "task", beforeTasks[0] as never),
        () => adapter.pushTaskDelete!(userID, "account", taskLink.externalCalendarID, "task"),
      ]) {
        await update({ scope: `${CALENDAR_SCOPE[provider]},${TASK_SCOPE[provider]}`, accessTokenExpiresAt: new Date(0) });
        await assert.rejects(write(), TaskScopeMissingError);
        assert.equal((await getOAuthCredentials(userID, provider, "account"))?.scope, CALENDAR_SCOPE[provider]);
      }
      assert.equal(taskCalls, callsBeforeNarrowedWrites);
      // Exercise Better Auth's own configured refresh HTTP, not just our adapter.
      await oauthProvider.refreshAccessToken!("fixture-refresh");
      assert.equal(refreshBodies[refreshBodies.length - 1].get("scope"), null, "Better Auth refresh must neither narrow nor escalate the stored grant");
      returnedScope = undefined;
      await update({ scope: `${CALENDAR_SCOPE[provider]},${TASK_SCOPE[provider]}` });
      mode = "empty";
      await run();
      assert.ok(!(await links()).some((link) => link.calendarID === taskLink.calendarID), "Authoritative empty Tasks discovery still removes deleted lists");

      // Exercise the actual Better Auth relink hook with a fresh calendar-only
      // grant, not a copied eligibility predicate.
      await update({ scope: CALENDAR_SCOPE[provider], syncStatus: "reconnect_required", syncErrorCode: "invalid_grant" });
      const [relinked] = await db.select().from(account).where(eq(account.id, rowID));
      await auth.options.databaseHooks!.account!.update!.after!(relinked);
      assert.equal((await getOAuthCredentials(userID, provider, "account"))?.syncStatus, "active");

      // Historical insufficient-scope status can heal only if the refresh token
      // actually exists. No guess/backfill can restore the token erased by 0056.
      await update({ scope: CALENDAR_SCOPE[provider], syncStatus: "reconnect_required", syncErrorCode: "insufficient_scope" });
      assert.deepEqual(await getOAuthAccountIDs(userID, provider), ["account"]);
      await update({ refreshToken: null, syncStatus: "reconnect_required", syncErrorCode: "insufficient_scope" });
      assert.deepEqual(await getOAuthAccountIDs(userID, provider), []);
      assert.equal((await oauthConnectionCheck(userID, provider)).calendarConnected, false);
      await update({ refreshToken: "fixture-refresh", syncStatus: "active", syncErrorCode: null, accessTokenExpiresAt: new Date(0) });
      revoked = true;
      await assert.rejects(run(), (error: unknown) => error instanceof ProviderAuthError && error.code === "invalid_grant" && error.reconnectRequired && !isOptionalTaskError(error));
      const credentials = await getOAuthCredentials(userID, provider, "account");
      assert.equal(credentials?.refreshToken, null);
      assert.equal(credentials?.syncStatus, "reconnect_required");
      assert.equal((await oauthConnectionCheck(userID, provider)).calendarConnected, false);
      assert.deepEqual(await getOAuthAccountIDs(userID, provider), []);
      console.log(`K03 ${provider}: calendar-only, optional consent, Tasks 403/503/incomplete lists/items, preservation, refresh and revoked-token HTTP/DB checks OK`);
    } finally {
      globalThis.fetch = realFetch;
      await db.delete(user).where(eq(user.id, userID));
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
