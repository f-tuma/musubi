import assert from "node:assert/strict";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION } from "@musubi/types";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { inArray } from "drizzle-orm";
import {
  account, db, getExternalSyncUserIDs, getUserExternalCalendars,
  memberTokens, user,
} from "@musubi/db";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { handlerSyncConnections } from "../handlers/connections";
import { handlerGetGoogleCalendars } from "../handlers/google";
import { syncUser } from "./engine";

// Real auth middleware, handler, orchestration, adapters and disposable DB.
// Redirect provider HTTP to a local fixture; unexpected destinations fail closed.
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const ids = [0, 1, 2, 3].map(() => `bootstrap-${randomUUID()}`);
  const [owner, other, scheduled, ineligible] = ids;
  const token = issueMemberToken();
  const requests: { path: string; authorization?: string }[] = [];
  const fixture = createServer((req, res) => {
    const path = req.url!;
    requests.push({ path, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    const json = (body: unknown) => res.end(JSON.stringify(body));
    if (path === "/v1.0/me") return json({ mail: "fixture@example.test" });
    if (path.startsWith("/v1.0/me/calendars?"))
      return json({ value: [{ id: "calendar", name: "Work", canEdit: true }] });
    if (path.includes("/calendarView/delta"))
      return json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/calendar/calendarView/delta?$deltatoken=done" });
    if (path.startsWith("/v1.0/me/todo/lists")) return json({ value: [] });
    res.statusCode = 500;
    return json({ error: { message: `Unexpected fixture request ${path}` } });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express();
  app.use(express.json());
  app.post("/api/v1/users/connections/sync", requireAuth, handlerSyncConnections);
  app.get("/api/v1/calendars/google", requireAuth, handlerGetGoogleCalendars);
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.origin === apiOrigin) return realFetch(input, init);
    assert.equal(url.origin, "https://graph.microsoft.com", "No real provider calls");
    return realFetch(`${fixtureOrigin}${url.pathname}${url.search}`, init);
  };
  const post = (body: unknown, authenticated = true) => fetch(`${apiOrigin}/api/v1/users/connections/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, ...(authenticated ? { authorization: `Bearer ${token.raw}` } : {}) },
    body: JSON.stringify(body),
  });
  const calendars = (userID: string, accountID: string) => getUserExternalCalendars("microsoft", userID, accountID);
  await db.insert(user).values(ids.map((id) => ({ id, name: id, email: `${id}@example.test`, isExternal: true })));
  try {
    await db.insert(memberTokens).values({ userID: owner, tokenHash: token.tokenHash });
    await db.insert(account).values([
      { userId: owner, accountId: "target" },
      // Missing scope would clear this token if scoped discovery inspected siblings.
      { userId: owner, accountId: "sibling", scope: "User.Read" },
      { userId: other, accountId: "foreign" },
      { userId: scheduled, accountId: "scheduled" },
      { userId: ineligible, accountId: "ineligible", scope: "User.Read" },
    ].map((row) => ({
      id: randomUUID(), providerId: "microsoft", scope: "Calendars.ReadWrite Tasks.ReadWrite",
      refreshToken: `${row.accountId}-refresh`, accessToken: `${row.accountId}-access`,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000), ...row,
    })));
    assert.deepEqual(await calendars(owner, "target"), []);
    const work = await getExternalSyncUserIDs();
    assert.ok(work.includes(owner) && work.includes(scheduled));
    assert.ok(!work.includes(ineligible), "Identity-only accounts remain ineligible");
    assert.equal((await post({ provider: "microsoft" }, false)).status, 401);
    for (const body of [{ provider: "bogus" }, { accountId: "target" }, { provider: 1 }, { accountId: "" }, { userID: other }, []]) {
      assert.equal((await post(body)).status, 400);
    }
    for (const accountId of ["foreign", "unknown"]) {
      assert.equal((await post({ provider: "microsoft", accountId })).status, 400);
    }
    assert.equal(requests.length, 0, "Unauthorized/invalid scopes never reach providers");
    const before = await db.select().from(account).where(inArray(account.userId, [owner, other]));
    assert.equal((await post({ provider: "microsoft", accountId: "target" })).status, 200);
    assert.equal((await calendars(owner, "target")).length, 1, "Microsoft-only initial import");
    assert.deepEqual(await calendars(owner, "sibling"), []);
    assert.deepEqual(await calendars(other, "foreign"), []);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.authorization === "Bearer target-access"), "Profile/token/calendar reads are account-scoped");
    assert.deepEqual(await db.select().from(account).where(inArray(account.userId, [owner, other])), before);

    requests.length = 0;
    assert.equal((await fetch(`${apiOrigin}/api/v1/calendars/google`, { headers: { authorization: `Bearer ${token.raw}`, [CLIENT_VERSION_HEADER]: PRODUCT_VERSION } })).status, 200);
    assert.equal(requests.length, 0, "Legacy route is still Google-only");

    // Exact same work-list/orchestration boundary used by the scheduler.
    assert.deepEqual(await calendars(scheduled, "scheduled"), []);
    for (const userID of await getExternalSyncUserIDs()) {
      if (userID === scheduled) await syncUser(userID);
    }
    assert.equal((await calendars(scheduled, "scheduled")).length, 1);

    // Provider-only callback discovers all eligible accounts of that provider.
    await db.insert(account).values({
      id: randomUUID(), userId: owner, providerId: "microsoft", accountId: "newly-linked",
      scope: "Calendars.ReadWrite Tasks.ReadWrite", refreshToken: "linked-refresh",
      accessToken: "linked-access", accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    await db.update(account).set({ scope: "Calendars.ReadWrite Tasks.ReadWrite" }).where(inArray(account.accountId, ["sibling"]));
    assert.equal((await post({ provider: "microsoft" })).status, 200);
    assert.equal((await calendars(owner, "newly-linked")).length, 1);
    assert.equal((await calendars(owner, "sibling")).length, 1);
    assert.equal((await post({})).status, 200);
    assert.deepEqual(await calendars(other, "foreign"), []);
    console.log("K02 bootstrap: authenticated HTTP, scoped reads, Microsoft zero-mirror import, scheduler and legacy route OK");
  } finally {
    globalThis.fetch = realFetch;
    await db.delete(user).where(inArray(user.id, ids));
    await Promise.all([new Promise<void>((resolve) => api.close(() => resolve())), new Promise<void>((resolve) => fixture.close(() => resolve()))]);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
