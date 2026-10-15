import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:7531";

async function main() {
  const { fetchMicrosoftTaskChanges } = await import("./microsoft");
  const { GraphTaskReadHttpError } = await import("./microsoft_task_read_error");
  const { StructuredLogger } = await import("@musubi/config");
  const { isOptionalTaskError, isTransientSyncError } = await import("../errors");
  const graph = "https://graph.microsoft.com/v1.0";
  const listID = "PRIVATE-Task-List-A/B";
  const token = "PRIVATE-Access-Token-Only-In-Injected-Request";
  const privateValue = "PRIVATE-Provider-Message-And-Opaque-Token";
  const collection = `${graph}/me/todo/lists/${encodeURIComponent(listID)}/tasks`;
  const initial = `${collection}/delta?$top=100`;
  const snapshot = `${collection}?$top=100`;
  const opaqueQuery = `?$skiptoken=${privateValue}%2b%3D&encoded=%252F&repeat=z&repeat=a&empty=`;
  const saved = `${collection}/delta?$deltatoken=${privateValue}%2B%3d`;
  const next = `${collection}/delta${opaqueQuery}`;
  const terminal = `${collection}/delta?$deltatoken=${privateValue}%2b%3D&terminal=true`;
  const snapshotNext = `${collection}${opaqueQuery}`;
  const item = (id: string) => ({ id, title: id, status: "notStarted" });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  const unsupported = () => json({ error: {
    code: "BadRequest", message: "Delta query is not supported by this resource",
  } }, 400);
  const read = (fetchImpl: typeof fetch, cursor: string | null = null) =>
    fetchMicrosoftTaskChanges(token, listID, cursor, { fetchImpl });
  const assertRequest = (init: RequestInit | undefined) => {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
  };
  const changeIDs = (result: Awaited<ReturnType<typeof read>>) =>
    result.changes.map(change => change.kind === "task" && change.data.externalId);

  // Diagnostics cannot change successful paging, the original opaque URL
  // bytes, or the legacy terminal fallback when Graph omits both link fields.
  for (const previous of [null, saved]) {
    const requests: string[] = [];
    const result = await read(async (input, init) => {
      const url = String(input); requests.push(url); assertRequest(init);
      if (requests.length === 1) {
        assert.equal(url, previous ?? initial);
        return json({ value: [item("first-delta-page")], "@odata.nextLink": next });
      }
      assert.equal(requests.length, 2); assert.equal(url, next);
      return json({ value: [item("last-delta-page")], "@odata.deltaLink": terminal });
    }, previous);
    assert.deepEqual(requests, [previous ?? initial, next]);
    assert.deepEqual(changeIDs(result), ["first-delta-page", "last-delta-page"]);
    assert.equal(result.nextCursor, terminal);
    assert.equal(result.reset, previous === null);

    let terminalRequests = 0;
    const withoutLink = await read(async (input, init) => {
      terminalRequests++; assertRequest(init); assert.equal(String(input), previous ?? initial);
      return json({ value: [item("legacy-terminal")] });
    }, previous);
    assert.equal(terminalRequests, 1);
    assert.equal(withoutLink.nextCursor, previous ?? initial);
    assert.equal(withoutLink.reset, previous === null);
    const terminalPageRequests: string[] = [];
    const withoutTerminalLink = await read(async input => {
      const url = String(input); terminalPageRequests.push(url);
      if (terminalPageRequests.length === 1) return json({ value: [], "@odata.nextLink": next });
      assert.equal(url, next);
      return json({ value: [item("legacy-last-page")] });
    }, previous);
    assert.deepEqual(terminalPageRequests, [previous ?? initial, next]);
    assert.equal(withoutTerminalLink.nextCursor, next, "The legacy no-deltaLink fallback retains the actual terminal page URL");
    assert.equal(withoutTerminalLink.reset, previous === null);
  }

  // The existing unsupported-delta branch still discards any buffered delta
  // changes and returns the full paginated snapshot with its existing reset.
  for (const origin of ["initial", "saved", "next"] as const) {
    const requests: string[] = [];
    const result = await read(async (input, init) => {
      const url = String(input); requests.push(url); assertRequest(init);
      if (origin === "next" && requests.length === 1) {
        assert.equal(url, initial);
        return json({ value: [item("discarded-delta-page")], "@odata.nextLink": next });
      }
      if (url === (origin === "saved" ? saved : origin === "next" ? next : initial)) return unsupported();
      if (url === snapshot) return json({ value: [item("first-snapshot-page")], "@odata.nextLink": snapshotNext });
      assert.equal(url, snapshotNext);
      return json({ value: [item("last-snapshot-page")] });
    }, origin === "saved" ? saved : null);
    assert.deepEqual(requests, origin === "next" ? [initial, next, snapshot, snapshotNext]
      : [origin === "saved" ? saved : initial, snapshot, snapshotNext]);
    assert.deepEqual(changeIDs(result), ["first-snapshot-page", "last-snapshot-page"]);
    assert.equal(result.nextCursor, null);
    assert.equal(result.reset, true);
  }

  const recoveryRequests: string[] = [];
  const recovered = await read(async (input, init) => {
    const url = String(input); recoveryRequests.push(url); assertRequest(init);
    if (url === saved) return json({ error: { code: "SyncStateNotFound", message: privateValue } }, 410);
    assert.equal(url, initial);
    return json({ value: [item("recovered-task")], "@odata.deltaLink": terminal });
  }, saved);
  assert.deepEqual(recoveryRequests, [saved, initial]);
  assert.deepEqual(changeIDs(recovered), ["recovered-task"]);
  assert.equal(recovered.reset, true);
  assert.equal(recovered.nextCursor, terminal);

  const causeKeys = ["code", "readKind", "requestPhase", "httpStatus", "graphCode", "graphInnerCode", "queryState", "skipState", "deltaState"];
  const expectedCause = (status: number, extra: Record<string, unknown> = {}) => ({
    code: "graph-task-read-http-failed", readKind: "delta", requestPhase: "initial", httpStatus: status,
    graphCode: "BadRequest", graphInnerCode: "missing", queryState: "other", skipState: "absent", deltaState: "absent", ...extra,
  });
  const assertDiagnostic = (error: unknown, expected: Record<string, unknown>) => {
    assert.ok(error instanceof GraphTaskReadHttpError, "The actual task reader must attach its typed bounded diagnostic");
    assert.equal(error.name, "GraphTaskReadHttpError");
    assert.equal(error.message, `Outlook ${expected.httpStatus}: Task read failed.`);
    assert.deepEqual(Object.keys(error.cause).sort(), [...causeKeys].sort());
    assert.deepEqual(error.cause, expected);
    const lines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { new StructuredLogger("error").error("sync.tasks.fetch_unavailable", { error }); }
    finally { process.stderr.write = originalWrite; }
    assert.equal(lines.length, 1);
    const serialized = lines[0]!;
    const logged = JSON.parse(serialized);
    assert.deepEqual(logged.error.cause, expected, "The real logger must preserve the diagnostic rather than redact its shape fields");
    assert.equal(logged.error.message, error.message);
    assert.match(logged.error.stack, /GraphTaskReadHttpError/);
    for (const sensitive of [graph, collection, initial, snapshot, saved, next, terminal, listID, encodeURIComponent(listID), token, privateValue]) {
      assert.equal(serialized.includes(sensitive), false, "Diagnostic message, stack and cause must omit opaque addresses and provider data");
    }
    return true;
  };
  type Step = { url: string; response: () => Response };
  const failure = async (steps: Step[], previous: string | null = null) => {
    const requests: string[] = [];
    let observed: unknown;
    await assert.rejects(read(async (input, init) => {
      const url = String(input); requests.push(url); assertRequest(init);
      const step = steps[requests.length - 1];
      assert.ok(step, "HTTP diagnostics must not add requests, retries or a cursor reset");
      assert.equal(url, step.url, "Dispatch the original provider URL without query or token normalization");
      return step.response();
    }, previous), error => { observed = error; return true; });
    assert.deepEqual(requests, steps.map(step => step.url));
    return observed;
  };
  const denied400 = () => json({ error: { code: "BadRequest", message: `${privateValue} (503 is only untrusted body text)` } }, 400);
  const phases: { name: string; steps: Step[]; previous?: string | null; expected: Record<string, unknown> }[] = [
    { name: "initial delta", steps: [{ url: initial, response: denied400 }], expected: expectedCause(400) },
    { name: "saved delta", previous: saved, steps: [{ url: saved, response: denied400 }],
      expected: expectedCause(400, { requestPhase: "saved-cursor", queryState: "delta", deltaState: "present" }) },
    { name: "returned delta next", steps: [
      { url: initial, response: () => json({ value: [item("buffered-delta")], "@odata.nextLink": next }) },
      { url: next, response: denied400 }], expected: expectedCause(400, { requestPhase: "next-page", queryState: "skip", skipState: "present" }) },
    { name: "initial after 410", previous: saved, steps: [
      { url: saved, response: () => json({ error: { code: "SyncStateNotFound", message: privateValue } }, 410) },
      { url: initial, response: denied400 }], expected: expectedCause(400, { requestPhase: "recovery-initial" }) },
    { name: "initial after next-page 410", steps: [
      { url: initial, response: () => json({ value: [item("discarded-before-expiry")], "@odata.nextLink": next }) },
      { url: next, response: () => json({ error: { code: "SyncStateNotFound", message: privateValue } }, 410) },
      { url: initial, response: denied400 }], expected: expectedCause(400, { requestPhase: "recovery-initial" }) },
    { name: "snapshot initial", steps: [{ url: initial, response: unsupported }, { url: snapshot, response: denied400 }],
      expected: expectedCause(400, { readKind: "snapshot" }) },
    { name: "snapshot next", steps: [{ url: initial, response: unsupported },
      { url: snapshot, response: () => json({ value: [item("buffered-snapshot")], "@odata.nextLink": snapshotNext }) },
      { url: snapshotNext, response: denied400 }],
      expected: expectedCause(400, { readKind: "snapshot", requestPhase: "next-page", queryState: "skip", skipState: "present" }) },
  ];
  for (const fixture of phases) {
    const error = await failure(fixture.steps, fixture.previous ?? null);
    assertDiagnostic(error, fixture.expected);
    assert.equal(isOptionalTaskError(error), false, `${fixture.name}: an ordinary 400 remains a hard failure`);
    assert.equal(isTransientSyncError(error), false, "Private message numbers cannot change error classification");
  }

  // Machine codes are classified without copying arbitrary provider strings.
  // They provide evidence only; status and existing read behavior still decide
  // optional/transient handling and unsupported-delta snapshot fallback.
  for (const code of ["BadRequest", "InvalidRequest", "ErrorInvalidRequest", "ErrorInvalidUrlQuery", "SyncStateNotFound", "syncStateNotFound",
    "InvalidDeltaToken", "ErrorInvalidSyncStateData", "InvalidAuthenticationToken", "ErrorAccessDenied", "AccessDenied",
    "ErrorItemNotFound", "TooManyRequests", "ServiceUnavailable", "MailboxNotEnabledForRESTAPI"]) {
    const error = await failure([{ url: initial,
      response: () => json({ error: { code, message: privateValue, innerError: { code: "ErrorInvalidUrlQuery", message: privateValue } } }, 400) }]);
    assertDiagnostic(error, expectedCause(400, { graphCode: code, graphInnerCode: "ErrorInvalidUrlQuery" }));
    assert.equal(isOptionalTaskError(error), false, "A machine code alone must not turn HTTP 400 into an optional task failure");
  }
  const bodies: { body?: unknown; raw?: string; graphCode: string; graphInnerCode: string }[] = [
    { body: {}, graphCode: "missing", graphInnerCode: "missing" },
    { body: { error: {} }, graphCode: "missing", graphInnerCode: "missing" },
    { body: { error: { code: privateValue, innerError: { code: privateValue, message: privateValue } } }, graphCode: "other", graphInnerCode: "other" },
    { body: { error: { code: "badrequest", innerError: { code: "serviceunavailable" } } }, graphCode: "other", graphInnerCode: "other" },
    { body: { error: { code: "BadRequest", innererror: { code: "SyncStateNotFound", message: privateValue } } }, graphCode: "BadRequest", graphInnerCode: "SyncStateNotFound" },
    { body: { error: { code: "BadRequest", innerError: {} } }, graphCode: "BadRequest", graphInnerCode: "missing" },
    ...[null, [], privateValue, 3].map(body => ({ body, graphCode: "malformed", graphInnerCode: "malformed" })),
    ...[null, [], privateValue, 3].map(error => ({ body: { error }, graphCode: "malformed", graphInnerCode: "malformed" })),
    ...["", " ", 3, null, [], {}].map(code => ({ body: { error: { code, message: privateValue } }, graphCode: "malformed", graphInnerCode: "missing" })),
    ...[null, [], privateValue, 3].map(innerError => ({ body: { error: { code: "BadRequest", innerError } }, graphCode: "BadRequest", graphInnerCode: "malformed" })),
    ...["", " ", 3, null, [], {}].map(code => ({ body: { error: { code: "BadRequest", innerError: { code, message: privateValue } } }, graphCode: "BadRequest", graphInnerCode: "malformed" })),
    { raw: `${privateValue} is not JSON`, graphCode: "malformed", graphInnerCode: "malformed" },
  ];
  for (const fixture of bodies) {
    const error = await failure([{ url: initial, response: () => fixture.raw === undefined
      ? json(fixture.body, 400) : new Response(fixture.raw, { status: 400 }) }]);
    assertDiagnostic(error, expectedCause(400, { graphCode: fixture.graphCode, graphInnerCode: fixture.graphInnerCode }));
  }

  const queryShapes = [
    { url: `${collection}/delta`, queryState: "none", skipState: "absent", deltaState: "absent" },
    { url: `${collection}/delta?`, queryState: "none", skipState: "absent", deltaState: "absent" },
    { url: `${collection}/delta?custom=${privateValue}`, queryState: "other", skipState: "absent", deltaState: "absent" },
    { url: `${collection}/delta?$skiptoken`, queryState: "skip", skipState: "empty", deltaState: "absent" },
    { url: `${collection}/delta?SKIPTOKEN=${privateValue}`, queryState: "skip", skipState: "present", deltaState: "absent" },
    { url: `${collection}/delta?$skipToken=${privateValue}&skiptoken=`, queryState: "skip", skipState: "multiple", deltaState: "absent" },
    { url: `${collection}/delta?$deltatoken=`, queryState: "delta", skipState: "absent", deltaState: "empty" },
    { url: `${collection}/delta?DeltaToken=${privateValue}`, queryState: "delta", skipState: "absent", deltaState: "present" },
    { url: `${collection}/delta?$deltaToken=${privateValue}&DELTATOKEN=${privateValue}`, queryState: "delta", skipState: "absent", deltaState: "multiple" },
    { url: `${collection}/delta?$SKIPTOKEN=${privateValue}&deltaToken=${privateValue}`, queryState: "both", skipState: "present", deltaState: "present" },
    { url: `not-an-absolute-url-${privateValue}`, queryState: "invalid", skipState: "unknown", deltaState: "unknown" },
  ];
  for (const { url, ...shape } of queryShapes) {
    const error = await failure([{ url, response: denied400 }], url);
    assertDiagnostic(error, expectedCause(400, { requestPhase: "saved-cursor", ...shape }));
  }

  for (const [status, optional, transient] of [[400, false, false], [401, false, false], [403, true, false],
    [404, false, false], [408, true, true], [410, false, false], [429, true, true], [500, true, true], [503, true, true]] as const) {
    const error = await failure([{ url: initial, response: () => json({ error: { code: "BadRequest", message: privateValue } }, status) }]);
    assertDiagnostic(error, expectedCause(status));
    assert.equal(isOptionalTaskError(error), optional, `HTTP ${status}: existing optional task classification`);
    assert.equal(isTransientSyncError(error), transient, `HTTP ${status}: existing transient classification`);
  }

  console.log("Microsoft task read diagnostics: bounded private-safe HTTP evidence; request phases, status classification and existing paging/fallback behavior preserved OK");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
