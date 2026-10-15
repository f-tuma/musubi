import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:7531";

async function main() {
  const { fetchMicrosoftTaskChanges } = await import("./microsoft");
  const { GraphTaskReadResponseError } = await import("./microsoft_task_read_page");
  const { reconcileExternalChanges } = await import("../engine");
  const { isOptionalTaskError, isTransientSyncError } = await import("../errors");
  const { StructuredLogger } = await import("@musubi/config");
  const graphBase = "https://graph.example.invalid/v1.0";
  const collection = `${graphBase}/me/todo/lists/fixture/tasks`;
  const initial = `${collection}/delta?$top=100`;
  const snapshot = `${collection}?$top=100`;
  const saved = `${collection}/delta?$deltatoken=PRIVATE-saved%2B%3d`;
  const next = `${collection}/delta?$skiptoken=PRIVATE-next%2b%3D&repeated=z&repeated=a&empty=`;
  const terminal = `${collection}/delta?$deltatoken=PRIVATE-terminal%2B%3d&encoded=%252F`;
  const token = "PRIVATE-access-token";
  const privateValue = "PRIVATE-provider-body-and-task-content";
  const item = (id = "task-one") => ({ id, title: privateValue, status: "notStarted" });
  const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(
    status === 204 ? null : JSON.stringify(body), { status, headers });
  const complete = (value: unknown[] = []) => json({ value, "@odata.deltaLink": terminal });
  const unsupported = () => json({ error: { message: "Delta query is not supported by this resource" } }, 400);
  const assertRequest = (init: RequestInit | undefined) => {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
  };
  type Read = Awaited<ReturnType<typeof fetchMicrosoftTaskChanges>>;
  const changeIDs = (result: Read) => result.changes.map(change => change.kind === "task" && change.data.externalId);
  let cases = 0;
  const read = (replies: (() => Response)[], cursor: string | null = null) => {
    const requests: string[] = [];
    const result = fetchMicrosoftTaskChanges(token, "fixture", cursor, {
      graphBase,
      fetchImpl: async (input, init) => {
        assertRequest(init);
        requests.push(String(input));
        assert.ok(requests.length <= replies.length, "The reader must not make an unplanned extra request");
        return replies[requests.length - 1]!();
      },
    });
    return { requests, result };
  };
  const rejects = async (name: string, replies: (() => Response)[], cursor: string | null = null,
    expectedKind: "delta" | "snapshot" = "delta", expectedReason?: string) => {
    const { requests, result } = read(replies, cursor);
    let calls = 0;
    const unexpected = async () => { calls++; return false; };
    const sweep = async () => { calls++; return 0; };
    let observed: InstanceType<typeof GraphTaskReadResponseError> | undefined;
    await assert.rejects(async () => {
      const batch = await result;
      await reconcileExternalChanges(batch.changes, batch.reset, {
        deleteEvent: unexpected, deleteTask: unexpected, upsertEvent: unexpected,
        upsertTask: unexpected, sweepEvents: sweep, sweepTasks: sweep,
      });
    }, error => {
      assert.ok(error instanceof GraphTaskReadResponseError, `${name}: the actual reader must reject with bounded evidence`);
      observed = error;
      assert.equal(error.cause.code, "graph-task-read-response-invalid");
      assert.equal(error.cause.readKind, expectedKind);
      if (expectedReason) assert.equal(error.cause.reason, expectedReason, name);
      assert.deepEqual(Object.keys(error.cause).sort(), ["code", "httpStatus", "readKind", "reason"]);
      assert.equal(error.message, "Outlook task read response is incomplete or invalid.");
      assert.equal(isOptionalTaskError(error), false);
      assert.equal(isTransientSyncError(error), false);
      const serialized = JSON.stringify({ message: error.message, stack: error.stack, cause: error.cause });
      for (const value of [graphBase, initial, next, saved, terminal, privateValue, token]) {
        assert.equal(serialized.includes(value), false, `${name}: provider data must not enter error evidence`);
      }
      return true;
    });
    assert.equal(calls, 0, `${name}: no partial batch may reach a writer`);
    assert.equal(requests.length, replies.length, `${name}: request count`);
    cases++;
    return observed!;
  };

  // The original 36-case audit: every unfinished read fails before authority;
  // the ordinary snapshot's empty terminal remains a valid complete full set.
  for (const cursor of [null, saved]) {
    for (const [name, body] of [
      ["missing-value-and-links", {}], ["empty-value-no-links", { value: [] }],
      ["array-root", []], ["string-root", privateValue], ["number-root", 123], ["null-root", null],
      ["null-value-no-links", { value: null }], ["empty-string-value", { value: "" }],
      ["object-value", { value: {} }], ["number-value", { value: 0 }],
      ["null-item", { value: [null] }], ["missing-item-id", { value: [{}] }],
      ["empty-next-link", { value: [], "@odata.nextLink": "" }],
      ["object-delta-link", { value: [], "@odata.deltaLink": { privateValue } }],
      ["both-links", { value: [], "@odata.nextLink": next, "@odata.deltaLink": terminal }],
    ] as const) await rejects(`${cursor === null ? "initial" : "saved"}/${name}`, [() => json(body)], cursor);
  }
  await rejects("late-unfinished", [() => json({ value: [item()], "@odata.nextLink": next }), () => json({})]);
  await rejects("410-unfinished", [() => json({}, 410), () => json({})], saved);
  await rejects("206-partial", [() => json({ value: [] }, 206)], null, "delta", "response");
  await rejects("content-range-partial", [() => json({ value: [] }, 200, { "content-range": "items 0-0/2" })], null, "delta", "response");
  await rejects("snapshot/missing-value", [unsupported, () => json({})], null, "snapshot", "value");
  const emptySnapshot = read([unsupported, () => json({ value: [] })]);
  assert.deepEqual(await emptySnapshot.result, { changes: [], nextCursor: null, reset: true });
  assert.deepEqual(emptySnapshot.requests, [initial, snapshot]); cases++;

  for (const body of [true, { error: null, value: [], "@odata.deltaLink": terminal },
    { error: { message: privateValue }, value: [], "@odata.deltaLink": terminal }]) {
    await rejects("invalid-envelope", [() => json(body)], null, "delta", "body");
  }
  for (const bad of [null, true, false, 1, privateValue, [], {}, { id: null }, { id: 1 },
    { id: "" }, { id: " " }, { id: " leading" }, { id: "trailing " }, { id: "line\nbreak" },
    { id: "control\u007f" }, { id: "." }, { id: ".." }]) {
    for (const kind of ["delta", "snapshot"] as const) {
      const response = () => json({ value: [bad], ...(kind === "delta" ? { "@odata.deltaLink": terminal } : {}) });
      await rejects(`${kind}/invalid-item`, kind === "delta" ? [response] : [unsupported, response], null, kind, "item");
    }
  }
  for (const removed of [null, false, true, 0, 1, privateValue, []]) {
    await rejects("malformed-removal", [() => complete([{ id: "removed", "@removed": removed }])], null, "delta", "removal");
  }
  for (const link of [undefined, null, "", 0, false, {}, [], " relative", "/relative", ` ${next}`, `${next} `,
    `${next}\n`, `${next}\u007f`, "https://other.example.invalid/tasks", next.replace("https:", "http:"),
    next.replace("https://", "https://private-user:private-password@"), next.replace("https://", "https://@"),
    `${next}#fragment`, `${next}#`, next.replace("/v1.0/", "/v1.0/../v1.0/"),
    next.replace("/v1.0/", "/v1.0/%2e%2e/v1.0/"), next.replace("/v1.0/", "\\v1.0/"),
    next.replace("https://", "https:/"), next.replace("graph.example", "%67raph.example"),
    next.replace("https://", "https:///"), next.replace("/v1.0/", "/v1.0/contains space/")]) {
    // Explicit undefined cannot occur in JSON; model it as null for wire parity.
    const wire = link === undefined ? null : link;
    for (const field of ["@odata.nextLink", "@odata.deltaLink"]) {
      await rejects(`delta/invalid-${field}`, [() => json({ value: [], [field]: wire })], null, "delta", "link");
    }
    await rejects("snapshot/invalid-next", [unsupported, () => json({ value: [], "@odata.nextLink": wire })], null, "snapshot", "link");
  }
  for (const [nextValue, deltaValue] of [[next, null], [null, terminal], ["", terminal], [next, ""], [false, false]]) {
    await rejects("both-links-even-falsy", [() => json({ value: [], "@odata.nextLink": nextValue, "@odata.deltaLink": deltaValue })], null, "delta", "completion");
  }
  for (const deltaLink of [null, "", terminal]) {
    await rejects("snapshot/mixed-delta-envelope", [unsupported, () => json({ value: [], "@odata.deltaLink": deltaLink })], null, "snapshot", "completion");
  }
  for (const kind of ["delta", "snapshot"] as const) {
    const final = kind === "delta" ? { value: [], "@odata.deltaLink": terminal } : { value: [] };
    for (const status of [201, 202, 204, 206]) {
      const response = () => json(final, status);
      await rejects(`${kind}/status-${status}`, kind === "delta" ? [response] : [unsupported, response], null, kind, "response");
    }
    for (const response of [
      () => Object.defineProperty(json(final), "redirected", { value: true }),
      () => json(final, 200, { "content-range": "" }),
      () => new Response(`{"value":[{"id":"${privateValue}"`),
      () => Object.assign(json(final), { json: async () => { throw new Error(privateValue); } }),
    ]) await rejects(`${kind}/partial-or-undecodable`, kind === "delta" ? [response] : [unsupported, response], null, kind);
    const malformedItem = () => json({ value: [{ id: "one", body: { content: { privateValue } } }],
      ...(kind === "delta" ? { "@odata.deltaLink": terminal } : {}) });
    await rejects(`${kind}/normalization-private-error`, kind === "delta" ? [malformedItem] : [unsupported, malformedItem], null, kind, "normalization");
  }

  // Full-chain validation occurs before even an earlier active/deleted page
  // can be returned. Empty intermediate pages must still follow continuation.
  for (const first of [[], [item()], [{ id: "removed", "@removed": { reason: "deleted" } }]]) {
    await rejects("late-malformed-delta", [() => json({ value: first, "@odata.nextLink": next }), () => json({ value: [] })]);
    await rejects("late-malformed-snapshot", [unsupported, () => json({ value: first, "@odata.nextLink": next }), () => json({})], null, "snapshot");
  }
  for (const cursor of [null, saved]) {
    const { result, requests } = read([() => complete()], cursor);
    assert.deepEqual(await result, { changes: [], nextCursor: terminal, reset: cursor === null });
    assert.deepEqual(requests, [cursor ?? initial]); cases++;
    const pages = read([
      () => json({ value: [], "@odata.nextLink": next, "@odata.context": "ordinary metadata" }),
      () => complete([item("first"), { id: "first" }, { id: "removed", "@removed": { reason: "deleted" } }]),
    ], cursor);
    const full = await pages.result;
    assert.deepEqual(changeIDs(full), ["first", "first", "removed"], "Replay IDs and sparse updates remain valid and ordered");
    assert.equal(full.changes[2]!.kind === "task" && full.changes[2]!.data.deleted, true);
    assert.deepEqual(pages.requests, [cursor ?? initial, next]);
    assert.equal(full.nextCursor, terminal); assert.equal(full.reset, cursor === null); cases++;
  }
  const snapshotPages = read([unsupported,
    () => json({ value: [], "@odata.nextLink": next }),
    () => json({ value: [{ id: "sparse" }, { id: "sparse" }, { id: "native-removal", "@removed": {} }] }),
  ]);
  const snapshotResult = await snapshotPages.result;
  assert.deepEqual(changeIDs(snapshotResult), ["sparse", "sparse", "native-removal"]);
  assert.equal(snapshotResult.nextCursor, null); assert.equal(snapshotResult.reset, true);
  assert.deepEqual(snapshotPages.requests, [initial, snapshot, next]); cases++;
  // Same origin /users routes are valid without claiming a new task collection
  // identity profile. Opaque query bytes are never decoded/reconstructed.
  const usersNext = `${graphBase}/users/user%40example.invalid/todo/lists/opaque%2Fid/tasks/delta?token=%2b%3D&x=z&x=a&empty=`;
  const usersTerminal = `${usersNext}&end=true`;
  const routed = read([() => json({ value: [], "@odata.nextLink": usersNext }),
    () => json({ value: [item("opaque/id%2F")], "@odata.deltaLink": usersTerminal })]);
  assert.equal((await routed.result).nextCursor, usersTerminal);
  assert.deepEqual(routed.requests, [initial, usersNext]); cases++;

  // Repeated continuation fails before fetching it again. A 410 clears both
  // the old buffered batch and traversal history, not the shared page budget.
  await rejects("delta-cycle", [() => json({ value: [item()], "@odata.nextLink": initial })], null, "delta", "cycle");
  await rejects("snapshot-cycle", [unsupported, () => json({ value: [item()], "@odata.nextLink": snapshot })], null, "snapshot", "cycle");
  const renewal = read([() => json({ value: [item("discard-before-410")], "@odata.nextLink": next }),
    () => json({}, 410), () => complete([item("after-renewal")])]);
  assert.deepEqual(changeIDs(await renewal.result), ["after-renewal"]);
  assert.deepEqual(renewal.requests, [initial, next, initial]); cases++;
  const repeatedRenewal = read([() => json({}, 410), () => json({ value: [], "@odata.nextLink": next }),
    () => json({}, 410), () => complete()], saved);
  assert.deepEqual(await repeatedRenewal.result, { changes: [], nextCursor: terminal, reset: true }); cases++;
  for (const phase of ["delta", "snapshot", "410-renewals", "fallback"] as const) {
    let calls = 0;
    await assert.rejects(fetchMicrosoftTaskChanges(token, "fixture", phase === "410-renewals" ? saved : null, {
      graphBase,
      fetchImpl: async (_input, init) => {
        assertRequest(init); calls++;
        assert.ok(calls <= 1000, "The shared budget must prevent request 1001");
        if (phase === "snapshot" && calls === 1 || phase === "fallback" && calls === 999) return unsupported();
        if (phase === "410-renewals" && calls % 2 === 1) return json({}, 410);
        return json({ value: [], "@odata.nextLink": `${collection}/delta?opaque-page=${calls}` });
      },
    }), error => {
      assert.ok(error instanceof GraphTaskReadResponseError);
      assert.equal(error.cause.reason, "page-limit");
      assert.equal(error.cause.readKind, phase === "snapshot" || phase === "fallback" ? "snapshot" : "delta");
      return true;
    });
    assert.equal(calls, 1000); cases++;
  }
  // Terminal page 1000 is within budget; the limit never truncates success.
  let allowedPages = 0;
  const allowed = await fetchMicrosoftTaskChanges(token, "fixture", null, { graphBase,
    fetchImpl: async () => ++allowedPages === 1000 ? complete()
      : json({ value: [], "@odata.nextLink": `${collection}/delta?page=${allowedPages}` }),
  });
  assert.equal(allowedPages, 1000); assert.equal(allowed.nextCursor, terminal); cases++;

  const invalidCursor = "https://outside.example.invalid/PRIVATE-cursor";
  await rejects("invalid-saved-cursor-before-fetch", [], invalidCursor, "delta", "link");
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  const safeError = await rejects("private-malformed-body", [() => new Response(privateValue)], null, "delta", "body");
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { new StructuredLogger("error").error("sync.tasks.fetch_unavailable", { error: safeError }); }
  finally { process.stderr.write = originalWrite; }
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!).error.cause, safeError.cause);
  for (const value of [graphBase, token, privateValue]) assert.equal(lines[0]!.includes(value), false);
  console.log(`Microsoft task read completeness: ${cases} actual-adapter cases; full-chain authority, bounded traversal, opaque URLs and private-safe errors OK`);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
