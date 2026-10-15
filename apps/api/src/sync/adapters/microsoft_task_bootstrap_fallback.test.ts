import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:7531";

async function main() {
  const { fetchMicrosoftTaskChanges } = await import("./microsoft");
  const { GraphTaskReadHttpError, graphTaskReadFailureKind } = await import("./microsoft_task_read_error");
  const { GraphTaskReadResponseError } = await import("./microsoft_task_read_page");
  const { reconcileExternalChanges } = await import("../engine");
  const { isOptionalTaskError, isTransientSyncError } = await import("../errors");
  const { logger, StructuredLogger } = await import("@musubi/config");
  const graphBase = "https://graph.example.invalid/v1.0";
  const collection = `${graphBase}/me/todo/lists/PRIVATE-list%2Fid/tasks`;
  const initial = `${collection}/delta?$top=100`;
  const snapshot = `${collection}?$top=100`;
  const saved = `${collection}/delta?$deltatoken=PRIVATE-saved%2B%3d&repeated=z&repeated=a&empty=`;
  const next = `${collection}/delta?$skiptoken=PRIVATE-next%2b%3D`;
  const snapshotNext = `${collection}?$skiptoken=PRIVATE-snapshot%2b%3D&encoded=%252F&repeat=z&repeat=a&empty=`;
  const terminal = `${collection}/delta?$deltatoken=PRIVATE-terminal%2b%3D`;
  const token = "PRIVATE-access-token";
  const privateValue = "PRIVATE-provider-body-and-task-title";
  const item = (id = "snapshot-task") => ({ id, title: privateValue });
  const json = (body: unknown, status = 200, headers?: HeadersInit) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  const failure = (message: unknown = "Skip token is not provided.", code: unknown = "BadRequest", status = 400) =>
    json({ error: { code, message, innerError: { code: "PRIVATE-inner-code", message: privateValue } } }, status);
  const unsupported = () => json({ error: { message: "Invalid request. Delta query is not supported by this resource." } }, 400);
  type Log = { message: string; fields: Record<string, unknown> };
  const logs: Log[] = [];
  const originalInfo = logger.info;
  logger.info = (message, fields) => { logs.push({ message, fields: fields ?? {} }); };
  let cases = 0;
  type Step = { url: string; response: () => Response };
  const read = (steps: Step[], cursor: string | null = null) => {
    logs.length = 0;
    const requests: string[] = [];
    return { requests, result: fetchMicrosoftTaskChanges(token, "PRIVATE-list/id", cursor, {
      graphBase,
      fetchImpl: async (input, init) => {
        assert.equal(init?.method ?? "GET", "GET"); assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
        requests.push(String(input));
        const step = steps[requests.length - 1];
        assert.ok(step, "Do not add an unplanned retry, reset or fallback");
        assert.equal(String(input), step.url, "Every provider URL must retain its original bytes");
        return step.response();
      },
    }) };
  };
  const changeIDs = (result: Awaited<ReturnType<typeof fetchMicrosoftTaskChanges>>) =>
    result.changes.map(change => change.kind === "task" && change.data.externalId);
  const assertLog = (log: Log, message: string, phase: string, reason: string, taskCount?: number) => {
    assert.equal(log.message, message);
    assert.deepEqual(log.fields, { provider: "microsoft", mode: "snapshot", requestPhase: phase, reason,
      ...(taskCount === undefined ? {} : { taskCount }) });
    const serialized = JSON.stringify(log);
    for (const secret of [graphBase, saved, next, snapshotNext, privateValue, token, "PRIVATE-list"]) {
      assert.equal(serialized.includes(secret), false, "Fallback telemetry must contain only fixed classifications and counts");
    }
  };
  const selected = (phase: string, reason = "missing-page-state") => {
    assert.ok(logs[0]); assertLog(logs[0], "sync.tasks.snapshot_fallback_selected", phase, reason);
  };
  const completed = (phase: string, count: number, reason = "missing-page-state") => {
    assert.equal(logs.length, 2); selected(phase, reason);
    assertLog(logs[1]!, "sync.tasks.snapshot_read_completed", phase, reason, count);
  };
  const reject = async (steps: Step[], cursor: string | null = null, expectedKind = "other", responseFailure = false) => {
    const { result, requests } = read(steps, cursor);
    let writerCalls = 0;
    const write = async () => { writerCalls++; return false; };
    const sweep = async () => { writerCalls++; return 0; };
    let observed: unknown;
    await assert.rejects(async () => {
      const batch = await result;
      await reconcileExternalChanges(batch.changes, batch.reset, {
        upsertEvent: write, upsertTask: write, deleteEvent: write,
        deleteTask: write, sweepEvents: sweep, sweepTasks: sweep,
      });
    }, error => {
      observed = error;
      if (responseFailure) assert.ok(error instanceof GraphTaskReadResponseError);
      else {
        assert.ok(error instanceof GraphTaskReadHttpError);
        assert.equal(error.cause.failureKind, expectedKind);
        assert.equal(error.cause.httpStatus, steps[steps.length - 1]!.response().status);
        if (error.cause.httpStatus === 400) {
          assert.equal(isOptionalTaskError(error), false); assert.equal(isTransientSyncError(error), false);
        }
      }
      const encoded = JSON.stringify(error);
      for (const secret of [graphBase, saved, next, snapshotNext, token, privateValue]) assert.equal(encoded.includes(secret), false);
      return true;
    });
    assert.equal(writerCalls, 0, "A failed snapshot must not expose even an earlier buffered task to the writer");
    assert.deepEqual(requests, steps.map(step => step.url)); cases++;
    return observed;
  };

  try {
    // Exact code and whole-message matching only. Case folding is the sole
    // permitted message normalization; trailing newlines must not match.
    for (const message of ["skip token is not provided", "Skip token is not provided.",
      "SKIP TOKEN IS NOT PROVIDED", "sKiP tOkEn Is NoT pRoViDeD."]) {
      assert.equal(graphTaskReadFailureKind({ error: { code: "BadRequest", message } }), "missing-page-state");
      for (const origin of ["initial", "saved-expired", "next-expired"] as const) {
        const phase = origin === "initial" ? "initial" : "recovery-initial";
        const prefix: Step[] = origin === "saved-expired" ? [{ url: saved, response: () => json({}, 410) }]
          : origin === "next-expired" ? [
            { url: initial, response: () => json({ value: [item("discard-before-410")], "@odata.nextLink": next }) },
            { url: next, response: () => json({}, 410) },
          ] : [];
        const steps = [...prefix, { url: initial, response: () => failure(message) },
          { url: snapshot, response: () => json({ value: [], "@odata.nextLink": snapshotNext }) },
          { url: snapshotNext, response: () => json({ value: [item(), { id: "native-removal", "@removed": { reason: "deleted" } }] }) },
        ];
        const actual = read(steps, origin === "saved-expired" ? saved : null);
        const result = await actual.result;
        assert.deepEqual(changeIDs(result), ["snapshot-task", "native-removal"]);
        assert.equal(result.reset, true); assert.equal(result.nextCursor, null);
        assert.deepEqual(actual.requests, steps.map(step => step.url));
        completed(phase, 2); cases++;
      }
    }
    const empty = read([{ url: initial, response: failure }, { url: snapshot, response: () => json({ value: [] }) }]);
    assert.deepEqual(await empty.result, { changes: [], reset: true, nextCursor: null }); completed("initial", 0); cases++;

    // A saved cursor which happens to have the initial URL is still not an
    // initial phase. A returned next-page signature also cannot choose fallback.
    for (const cursor of [saved, initial]) {
      await reject([{ url: cursor, response: failure }], cursor, "missing-page-state");
      assert.deepEqual(logs, []);
    }
    await reject([{ url: initial, response: () => json({ value: [item("buffered")], "@odata.nextLink": next }) },
      { url: next, response: failure }], null, "missing-page-state");
    assert.deepEqual(logs, []);
    for (const message of ["Skip token is not provided..", "Skip token is not provided ", " Skip token is not provided",
      "Skip token is not provided.\n", "Skip token is not provided\n", "Skip token is not provided\r",
      "Skip token is not provided\r\n", "Skip token is not provided\u2028", "Skip token is not provided\u2029",
      "Skip token is not provided\u0000", `Skip token is not provided.${privateValue}`,
      `${privateValue}Skip token is not provided`, "Skip token is not provided for this request", "", null, 5, [], {}]) {
      await reject([{ url: initial, response: () => failure(message) }]);
      assert.deepEqual(logs, []);
    }
    for (const code of ["badrequest", "BADREQUEST", "BadRequest ", " BadRequest", "InvalidRequest", "Other", "", null, 1, [], {}]) {
      await reject([{ url: initial, response: () => failure("Skip token is not provided.", code) }]);
      assert.deepEqual(logs, []);
    }
    for (const body of [{ error: { message: "Skip token is not provided" } }, { error: { code: "BadRequest" } }]) {
      await reject([{ url: initial, response: () => json(body, 400) }]);
      assert.deepEqual(logs, [], "Both the exact code and the whole message are required");
    }
    for (const body of [null, [], privateValue, 1, {}, { error: null }, { error: [] }, { error: privateValue }]) {
      await reject([{ url: initial, response: () => json(body, 400) }], null, "unparseable");
      assert.deepEqual(logs, []);
    }
    await reject([{ url: initial, response: () => new Response(privateValue, { status: 400 }) }], null, "unparseable");
    assert.deepEqual(logs, []);
    for (const status of [401, 403, 404, 408, 410, 429, 500, 503]) {
      await reject([{ url: initial, response: () => failure(undefined, undefined, status) }], null, "missing-page-state");
      assert.deepEqual(logs, [], "The exact body signature cannot make a different HTTP status eligible");
    }
    // Existing unsupported-delta matching remains available from every prior
    // phase, with its separately observable bounded reason.
    for (const origin of ["initial", "saved", "next"] as const) {
      const prefix = origin === "next" ? [{ url: initial,
        response: () => json({ value: [item("discard-unsupported")], "@odata.nextLink": next }) }] : [];
      const first = origin === "saved" ? saved : origin === "next" ? next : initial;
      const actual = read([...prefix, { url: first, response: unsupported },
        { url: snapshot, response: () => json({ value: [item("snapshot-after-unsupported")] }) }], origin === "saved" ? saved : null);
      assert.deepEqual(changeIDs(await actual.result), ["snapshot-after-unsupported"]);
      completed(origin === "saved" ? "saved-cursor" : origin === "next" ? "next-page" : "initial", 1, "delta-unsupported"); cases++;
    }

    // Selection and completed-read evidence are different events. Incomplete,
    // cyclic, partial or failing snapshots must emit no completed marker.
    const malformed = [() => json({}), () => json({ value: null }), () => json({ value: [], "@odata.nextLink": null }),
      () => json({ value: [], "@odata.deltaLink": terminal }), () => json({ value: [null] }),
      () => json({ value: [{ id: "bad-removed", "@removed": null }] }), () => json({ value: [] }, 206),
      () => json({ value: [] }, 200, { "content-range": "items 0-0/2" }),
      () => Object.defineProperty(json({ value: [] }), "redirected", { value: true }),
      () => new Response(`{"value":[{"id":"${privateValue}"`),
    ];
    for (const response of malformed) {
      for (const late of [false, true]) {
        await reject([{ url: initial, response: failure },
          ...(late ? [{ url: snapshot, response: () => json({ value: [item("never-committed")], "@odata.nextLink": snapshotNext }) }] : []),
          { url: late ? snapshotNext : snapshot, response }], null, "other", true);
        assert.equal(logs.length, 1); selected("initial");
      }
    }
    for (const late of [false, true]) {
      await reject([{ url: initial, response: failure },
        ...(late ? [{ url: snapshot, response: () => json({ value: [item()], "@odata.nextLink": snapshotNext }) }] : []),
        { url: late ? snapshotNext : snapshot, response: failure }], null, "missing-page-state");
      assert.equal(logs.length, 1); selected("initial");
    }
    await reject([{ url: initial, response: failure }, { url: snapshot, response: unsupported }], null, "delta-unsupported");
    assert.equal(logs.length, 1); selected("initial");
    await reject([{ url: initial, response: failure },
      { url: snapshot, response: () => json({ value: [item()], "@odata.nextLink": snapshot }) }], null, "other", true);
    assert.equal(logs.length, 1); selected("initial");

    // Existing complete delta works normally; degradation is retried next read
    // by returning no cursor rather than persisting or repairing a delta URL.
    const ordinary = read([{ url: saved, response: () => json({ value: [], "@odata.deltaLink": terminal }) }], saved);
    assert.deepEqual(await ordinary.result, { changes: [], reset: false, nextCursor: terminal }); assert.deepEqual(logs, []); cases++;
    let calls = 0;
    logs.length = 0;
    await assert.rejects(fetchMicrosoftTaskChanges(token, "PRIVATE-list/id", saved, { graphBase,
      fetchImpl: async () => {
        calls++;
        assert.ok(calls <= 1000, "Renewal and fallback must not restart the global request budget");
        if (calls === 1) return json({}, 410);
        if (calls === 2) return failure();
        return json({ value: [], "@odata.nextLink": `${collection}?opaque-page=${calls}` });
      },
    }), error => error instanceof GraphTaskReadResponseError && error.cause.reason === "page-limit");
    assert.equal(calls, 1000); assert.equal(logs.length, 1); selected("recovery-initial"); cases++;

    // Exercise the real structured logger with the exact bounded fields. No
    // message/code/body/URL/token is copied into the diagnostic or fallback log.
    const privateError = await reject([{ url: saved, response: failure }], saved, "missing-page-state");
    const serializedLines: string[] = [];
    const stdout = process.stdout.write, stderr = process.stderr.write;
    process.stdout.write = process.stderr.write = ((chunk: string) => {
      serializedLines.push(String(chunk)); return true;
    }) as typeof process.stdout.write;
    try {
      const structured = new StructuredLogger("info");
      structured.error("sync.tasks.fetch_unavailable", { error: privateError });
      structured.info("sync.tasks.snapshot_fallback_selected", { provider: "microsoft", mode: "snapshot", requestPhase: "initial", reason: "missing-page-state" });
      structured.info("sync.tasks.snapshot_read_completed", { provider: "microsoft", mode: "snapshot", requestPhase: "initial", reason: "missing-page-state", taskCount: 1 });
    } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    assert.equal(serializedLines.length, 3);
    assert.equal(JSON.parse(serializedLines[0]!).error.cause.failureKind, "missing-page-state");
    for (const line of serializedLines) for (const secret of [graphBase, saved, next, token, privateValue, "PRIVATE-inner-code"]) assert.equal(line.includes(secret), false);
    console.log(`Microsoft task bootstrap fallback: ${cases} actual-adapter cases; exact signature, initial-only degradation, complete snapshot authority, telemetry privacy and unchanged hard failures OK`);
  } finally { logger.info = originalInfo; }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
