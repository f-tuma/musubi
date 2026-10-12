import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const [{ db }, { getOAuthAccessToken }] = await Promise.all([import("@musubi/db"), import("./oauth")]);
  const query = db.$client.query, originalFetch = globalThis.fetch;
  let reads = 0, saved = 0, requests = 0;
  let reached!: () => void, release!: (response: Response) => void;
  const refreshSignals: AbortSignal[] = [];
  let validCredentials = false, activeAccessToken = "expired.fixture-access";
  db.$client.query = (async (configuration: { text?: string; rowMode?: string }) => {
    const select = /^select /i.test(configuration.text ?? "");
    if (select) reads++; else { assert.match(configuration.text ?? "", /^update "account" set /i); saved++; }
    return { command: select ? "SELECT" : "UPDATE", rowCount: 1, oid: 0, fields: [], rows: select ? [[
      "fixture-account-row", "Tasks.ReadWrite,https://www.googleapis.com/auth/tasks", activeAccessToken, "fixture.refresh-token", validCredentials ? new Date(Date.now() + 3_600_000).toISOString().replace("T", " ").replace(/Z$/, "") : "2020-01-01 00:00:00", "active", null, null,
    ]] : [["fixture-account-row"]] };
  }) as typeof db.$client.query;
  globalThis.fetch = async (_input, init) => {
    requests++;
    assert.ok(init?.signal, "shared OAuth HTTP has its own deadline");
    refreshSignals.push(init.signal);
    reached();
    return new Promise<Response>((resolve, reject) => {
      release = resolve;
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  };
  const endpoint = { tokenEndpoint: "https://fixture.test/token", clientId: "fixture", clientSecret: "fixture" };
  const abortReason = new Error("delivery deadline");
  try {
    const expired = new AbortController(); expired.abort(abortReason);
    await assert.rejects(() => getOAuthAccessToken("microsoft", "owner", "account", endpoint, { signal: expired.signal }), error => error === abortReason);
    assert.equal(reads, 0); assert.equal(requests, 0, "expired caller cannot initiate refresh");

    for (const abortInitiator of [true, false]) {
      const initiator = new AbortController(), sibling = new AbortController();
      const transportStarted = new Promise<void>(resolve => { reached = resolve; });
      const first = getOAuthAccessToken("microsoft", "owner", "account", endpoint, { signal: initiator.signal });
      await transportStarted;
      const second = getOAuthAccessToken("microsoft", "owner", "account", endpoint, { signal: sibling.signal });
      const aborted = abortInitiator ? first : second, survivor = abortInitiator ? second : first;
      (abortInitiator ? initiator : sibling).abort(abortReason);
      await assert.rejects(aborted, error => error === abortReason);
      assert.equal(refreshSignals[refreshSignals.length - 1]!.aborted, false, "one expired waiter cannot cancel its sibling's shared refresh");
      release(new Response(JSON.stringify({ access_token: "fresh.fixture-access", expires_in: 3600 }), { status: 200 }));
      assert.equal(await survivor, "fresh.fixture-access");
    }
    assert.equal(requests, 2, "each grant refresh is coalesced, then removed after completion");
    assert.equal(saved, 2, "successful shared refreshes preserve credential CAS persistence");

    const [{ googleAdapter, googleTaskListExternalId }, { TaskSchema }, { withProviderCallMetrics, providerHttpMetricsRegistry }] = await Promise.all([import("./adapters/google"), import("@musubi/types"), import("./provider_http_metrics")]);
    const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: "home", title: "Delivery" });
    validCredentials = true;
    for (const kind of ["read", "create-preflight"] as const) {
      activeAccessToken = "rejected.fixture-access";
      const controller = new AbortController();
      const calls: string[] = [];
      let getCount = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)), method = init?.method ?? "GET";
        calls.push(method);
        if (url.origin === "https://oauth2.googleapis.com") {
          assert.equal(method, "POST"); assert.notEqual(init?.signal, controller.signal);
          activeAccessToken = "recovered.fixture-access";
          return new Response(JSON.stringify({ access_token: activeAccessToken, expires_in: 3600 }), { status: 200 });
        }
        assert.equal(url.origin, "https://tasks.googleapis.com"); assert.equal(method, "GET", "authentication recovery never replays a task mutation");
        assert.equal(init?.signal, controller.signal);
        getCount++;
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${getCount === 1 ? "rejected.fixture-access" : "recovered.fixture-access"}`);
        return getCount === 1 ? new Response(null, { status: 401 }) : new Response(JSON.stringify(kind === "read" ? { id: "remote", title: "Remote", status: "needsAction", etag: '"accepted"' } : { id: "list" }), { status: 200 });
      };
      const calendar = googleTaskListExternalId("list");
      providerHttpMetricsRegistry.resetMetrics();
      await withProviderCallMetrics("google", "task", async () => {
        if (kind === "read") assert.equal((await googleAdapter.readTask!("owner", "account", calendar, { externalTaskId: "remote" }, controller.signal))?.ref.externalTaskId, "remote");
        else await googleAdapter.assertTaskWrite!("owner", "account", calendar, { action: "create", task, signal: controller.signal });
      });
      assert.deepEqual(calls, ["GET", "POST", "GET"], "only the concrete rejected GET is retried once after refresh");
      const counters = (await providerHttpMetricsRegistry.getMetricsAsJSON()).find(metric => metric.name === "musubi_provider_http_requests_total")!.values;
      assert.equal(counters.reduce((sum, row) => sum + row.value, 0), calls.length, "composed read/recovery helpers count each actual HTTP dispatch exactly once");
      assert.deepEqual(counters.map(row => [row.labels.method, row.labels.status, row.value]).sort(), [["GET", "200", 1], ["GET", "401", 1], ["POST", "200", 1]]);
    }
    console.log("OAuth delivery abort: initiator/sibling deadlines stop only their waiter; shared refresh remains bounded and coalesced OK");
  } finally {
    globalThis.fetch = originalFetch; db.$client.query = query;
  }
}

void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
