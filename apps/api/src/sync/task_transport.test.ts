import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const [{ TaskSchema }, google, microsoft, taskWrites, { config }, caldav] = await Promise.all([
    import("@musubi/types"), import("./adapters/google"), import("./adapters/microsoft"),
    import("./task_write"), import("@musubi/config"), import("./caldav_client"),
  ]);
  const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: "home", title: "Delivery" });
  const controller = new AbortController(), signal = controller.signal;
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    assert.equal(init.signal, signal, "every preflight and mutation receives the delivery signal");
    const method = init.method ?? "GET";
    methods.push(method);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: "remote", title: task.title, status: "needsAction", etag: '"accepted"', "@odata.etag": 'W/"accepted"' }), { status: method === "POST" ? 201 : 200 });
  };
  const options = { fetchImpl, signal };
  await google.readGoogleTask("access", "list", "remote", options);
  await google.createGoogleTask("access", "list", task, options);
  await google.updateGoogleTask("access", "list", "remote", task, '"accepted"', options);
  await google.deleteGoogleTask("access", "list", "remote", '"accepted"', options);
  await microsoft.createMicrosoftTask("access", "list", task, options);
  await microsoft.updateMicrosoftTask("access", "list", "remote", task, 'W/"accepted"', options);
  await microsoft.deleteMicrosoftTask("access", "list", "remote", 'W/"accepted"', options);
  assert.deepEqual(methods, ["GET", "POST", "GET", "PATCH", "GET", "DELETE", "POST", "PATCH", "DELETE"]);

  const abortReason = new Error("delivery deadline");
  controller.abort(abortReason);
  let admission = 0;
  const abortedOptions = { ...options, beforeMutation: async () => { admission++; } };
  for (const write of [
    () => google.createGoogleTask("access", "list", task, abortedOptions),
    () => google.updateGoogleTask("access", "list", "remote", task, '"accepted"', abortedOptions),
    () => google.deleteGoogleTask("access", "list", "remote", '"accepted"', abortedOptions),
    () => microsoft.createMicrosoftTask("access", "list", task, abortedOptions),
    () => microsoft.updateMicrosoftTask("access", "list", "remote", task, 'W/"accepted"', abortedOptions),
    () => microsoft.deleteMicrosoftTask("access", "list", "remote", 'W/"accepted"', abortedOptions),
  ]) await assert.rejects(write, error => error === abortReason);
  assert.equal(admission, 0, "an expired delivery never reaches mutation admission");
  assert.equal(methods.length, 9, "an expired delivery never reaches task transport");

  const interrupted = new AbortController();
  let beforeMutation = 0, dispatches = 0;
  const hangingRead: typeof fetch = async (_input, init) => {
    assert.equal(init?.signal, interrupted.signal);
    dispatches++;
    interrupted.abort(abortReason);
    throw init!.signal!.reason;
  };
  await assert.rejects(() => google.updateGoogleTask("access", "list", "remote", task, '"accepted"', {
    signal: interrupted.signal, fetchImpl: hangingRead, beforeMutation: async () => { beforeMutation++; },
  }), error => error === abortReason);
  assert.equal(dispatches, 1); assert.equal(beforeMutation, 0, "aborted preflight cannot dispatch PATCH");

  for (const [status, outcome] of [[429, "not-written"], [503, "unconfirmed"], [412, "not-written"]] as const) {
    assert.throws(() => taskWrites.assertTaskMutationResponse(new Response(null, { status, headers: { "retry-after": "17" } })), error =>
      error instanceof taskWrites.ProviderTaskWriteError && error.providerStatus === status && error.outcome === outcome && error.retryAfterMs === 17_000);
  }
  for (const read of [
    () => google.readGoogleTask("access", "list", "remote", { fetchImpl: async () => new Response(null, { status: 503, headers: { "retry-after": "31" } }) }),
  ]) await assert.rejects(read, error => error instanceof taskWrites.ProviderTaskWriteError && error.outcome === "not-written" && error.retryAfterMs === 31_000);
  const retryDate = new Date(Date.now() + 60_000).toUTCString();
  assert.throws(() => taskWrites.assertTaskReadResponse(new Response(null, { status: 429, headers: { "retry-after": retryDate } })), error =>
    error instanceof taskWrites.ProviderTaskWriteError && error.retryAfterMs! > 58_000 && error.retryAfterMs! <= 60_000);

  // The CalDAV guard checks expiry again after its asynchronous DNS boundary.
  const dnsAbort = new AbortController();
  let caldavDispatches = 0;
  const guarded = caldav.createGuardedCaldavFetch({
    allowPrivate: true,
    lookupImpl: async () => { dnsAbort.abort(abortReason); return [{ address: "127.0.0.1", family: 4 }]; },
    fetchPinnedImpl: async () => { caldavDispatches++; return new Response(null, { status: 204 }); },
  });
  await assert.rejects(() => guarded("http://fixture.test/calendar/task.ics", { signal: dnsAbort.signal, method: "PUT" }), error => error === abortReason);
  assert.equal(caldavDispatches, 0);

  // tsdav's discovery and later object methods share the same scoped signal.
  // Its fallback discovery must not dispatch more requests after an abort.
  const originalFetch = globalThis.fetch, allowPrivate = config.security.federationAllowPrivateHosts;
  config.security.federationAllowPrivateHosts = true;
  const clientAbort = new AbortController();
  let started!: () => void;
  const reachedTransport = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, clientAbort.signal);
    caldavDispatches++;
    started();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  };
  try {
    const pending = caldav.createCaldavClient("http://127.0.0.1:1", "fixture", "fixture", clientAbort.signal);
    await reachedTransport;
    clientAbort.abort(abortReason);
    await assert.rejects(pending, error => error === abortReason);
    assert.equal(caldavDispatches, 1);

    const [{ db }, { caldavAdapter }, { encryptSecret }, { ProviderEventWriteError }] = await Promise.all([
      import("@musubi/db"), import("./adapters/caldav"), import("./crypto"), import("./event_write"),
    ]);
    const row = (href: string, properties: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const xml = (body: string) => new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
    const origin = "http://127.0.0.1:1";
    for (const status of [429, 503]) {
      globalThis.fetch = async (input, init) => String(init?.body).includes("current-user-principal")
        ? new Response(null, { status, headers: { "retry-after": "23" } })
        : xml(row(String(input), "<d:resourcetype><d:collection/></d:resourcetype>"));
      await assert.rejects(() => caldav.createCaldavClient(origin, "fixture", "fixture"), error =>
        error instanceof ProviderEventWriteError && error.providerStatus === status && error.retryAfterMs === 23_000 && error.outcome === "not-written");
    }
    const reportController = new AbortController();
    globalThis.fetch = async (input, init) => {
      assert.equal(init?.signal, reportController.signal);
      const body = String(init?.body);
      if (body.includes("calendar-multiget")) return new Response(null, { status: 503, headers: { "retry-after": "29" } });
      if (body.includes("current-user-principal")) return xml(row(String(input), "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>"));
      if (body.includes("calendar-home-set")) return xml(row(String(input), "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>"));
      return xml(row(String(input), "<d:resourcetype><d:collection/></d:resourcetype>"));
    };
    const reportClient = await caldav.createCaldavClient(origin, "fixture", "fixture", reportController.signal);
    await assert.rejects(() => reportClient.fetchCalendarObjects({ calendar: { url: `${origin}/home/calendar/` } as Parameters<typeof reportClient.fetchCalendarObjects>[0]["calendar"], objectUrls: [`${origin}/home/calendar/task.ics`] }), error =>
      error instanceof ProviderEventWriteError && error.providerStatus === 503 && error.retryAfterMs === 29_000 && error.outcome === "not-written");

    const query = db.$client.query, encryptionKey = config.security.caldavEncKey;
    config.security.caldavEncKey = "11".repeat(32);
    const password = encryptSecret("fixture");
    db.$client.query = (async (configuration: { text?: string }) => {
      assert.match(configuration.text ?? "", /^select /i);
      assert.match(configuration.text ?? "", /from "caldav_accounts"/);
      return { command: "SELECT", rowCount: 1, oid: 0, fields: [], rows: [configuration.text!.includes('select "id"')
        ? ["account", "http://127.0.0.1:1", "fixture"]
        : ["http://127.0.0.1:1", "fixture", password]] };
    }) as typeof db.$client.query;
    try {
      const preflight = new AbortController();
      for (const status of [429, 408, 503]) {
        globalThis.fetch = async (_input, init) => {
          assert.equal(init?.method, "PROPFIND"); assert.equal(init.signal, preflight.signal);
          return new Response(null, { status, headers: { "retry-after": "19" } });
        };
        await assert.rejects(() => caldavAdapter.assertTaskWrite!("owner", "account", "http://127.0.0.1:1/calendar/", { action: "create", task, signal: preflight.signal }), error =>
          error instanceof ProviderEventWriteError && error.providerStatus === status && error.outcome === "not-written" && error.retryAfterMs === 19_000);
      }
      globalThis.fetch = async () => new Response(null, { status: 403 });
      await assert.rejects(() => caldavAdapter.assertTaskWrite!("owner", "account", "http://127.0.0.1:1/calendar/", { action: "create", task }), error =>
        error instanceof taskWrites.ProviderTaskWriteError && error.code === "task-source-read-only");
    } finally {
      db.$client.query = query; config.security.caldavEncKey = encryptionKey;
    }
  } finally {
    globalThis.fetch = originalFetch; config.security.federationAllowPrivateHosts = allowPrivate;
  }
  console.log("Task provider transports: delivery abort reaches reads/mutations/CalDAV discovery; expired admission and Retry-After preserved OK");
}

void main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
