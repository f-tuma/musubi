import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:7531";

async function main() {
  const { fetchMicrosoftTaskLists } = await import("./microsoft");
  const { isMicrosoftEventMailboxUnavailable } = await import("./microsoft_calendar_discovery_error");
  const { StructuredLogger } = await import("@musubi/config");
  const { isOptionalTaskError, isTransientSyncError } = await import("../errors");
  const graph = "https://graph.microsoft.com/v1.0";
  const initial = `${graph}/me/todo/lists?$top=100`;
  const privateValue = "PRIVATE-provider-message-account-and-calendar-id";
  const token = "PRIVATE-access-token-only-in-the-request";
  const next = `${graph}/me/todo/lists?$skiptoken=PRIVATE-opaque%2b%3D&encoded=%252F&repeat=z&repeat=a&empty=`;
  const prefer = 'outlook.timezone="UTC", outlook.body-content-type="text", odata.maxpagesize=100';
  const calendar = (id: string) => ({ id, displayName: privateValue, isOwner: true });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, statusText: "PRIVATE-provider-status-text", headers: { "content-type": "application/json" },
  });
  type Step = { url: string; response: () => Response };
  const read = (steps: Step[]) => {
    const requests: string[] = [];
    const result = fetchMicrosoftTaskLists(token, async (input, init) => {
      requests.push(String(input));
      const step = steps[requests.length - 1];
      assert.ok(step, "Task-list discovery must not retry, fall back or dispatch item/event requests");
      assert.equal(String(input), step.url, "Opaque continuation bytes and request order are unchanged");
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
      assert.equal(new Headers(init?.headers).get("Prefer"), prefer);
      return step.response();
    });
    return { result, requests };
  };
  const expected = (status: number, requestPhase = "initial", graphCode = "MailboxNotEnabledForRESTAPI", graphInnerCode = "missing") => ({
    code: "graph-task-list-discovery-http-failed", requestPhase, httpStatus: status, graphCode, graphInnerCode,
  });
  type DiagnosticError = Error & { cause?: ReturnType<typeof expected> };
  const privateValues = [privateValue, token, initial, next, "PRIVATE-provider-status-text", "PRIVATE-request-id", "PRIVATE-deep-code"];
  let cases = 0;
  const failure = async (response: () => Response, cause: ReturnType<typeof expected>, phase: "initial" | "next-page" = "initial") => {
    const steps = phase === "initial" ? [{ url: initial, response }] : [
      { url: initial, response: () => json({ value: [calendar("PRIVATE-buffered-calendar")], "@odata.nextLink": next }) },
      { url: next, response },
    ];
    const { result, requests } = read(steps);
    let observed: DiagnosticError | undefined;
    await assert.rejects(result, error => {
      assert.ok(error instanceof Error);
      observed = error;
      const serialized = JSON.stringify({ name: error.name, message: error.message, stack: error.stack, cause: (error as DiagnosticError).cause });
      for (const value of privateValues) assert.equal(serialized.includes(value), false, "Provider-controlled values cannot enter error evidence");
      assert.equal(error.name, "GraphTaskListDiscoveryHttpError");
      assert.equal(isMicrosoftEventMailboxUnavailable(error), false, "Task-list HTTP failures never authorize calendar mailbox isolation");
      assert.equal(error.message, `Outlook ${cause.httpStatus}: Task list discovery failed.`);
      assert.deepEqual((error as DiagnosticError).cause, cause);
      assert.deepEqual(Object.keys((error as DiagnosticError).cause!).sort(), ["code", "graphCode", "graphInnerCode", "httpStatus", "requestPhase"]);
      assert.equal(Object.isFrozen((error as DiagnosticError).cause), true);
      return true;
    });
    assert.deepEqual(requests, steps.map(step => step.url), "A failed inventory page cannot return buffered lists or fetch another page");
    assert.ok(observed);
    cases++;
    return observed;
  };

  for (const phase of ["initial", "next-page"] as const) {
    const error = await failure(() => json({ error: {
      code: "MailboxNotEnabledForRESTAPI", message: privateValue,
      requestId: "PRIVATE-request-id", innerError: { message: privateValue },
    } }, 404), expected(404, phase), phase);
    assert.equal(isOptionalTaskError(error), false);
    assert.equal(isTransientSyncError(error), false);
    const lines: string[] = [];
    const stderr = process.stderr.write;
    process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { new StructuredLogger("error").error("sync.provider.failed", { error }); }
    finally { process.stderr.write = stderr; }
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]!);
    assert.equal(logged.error.name, "GraphTaskListDiscoveryHttpError");
    assert.deepEqual(logged.error.cause, expected(404, phase));
    for (const value of privateValues) assert.equal(lines[0]!.includes(value), false);
  }
  for (const [status, optional, transient] of [
    [400, false, false], [401, false, false], [403, true, false], [404, false, false],
    [408, true, true], [410, false, false], [429, true, true], [500, true, true], [503, true, true],
  ] as const) {
    const error = await failure(() => json({ error: { code: "BadRequest", message: `${privateValue} 503` } }, status), expected(status, "initial", "BadRequest"));
    assert.equal(isOptionalTaskError(error), optional, "Optional classification follows the actual HTTP status");
    assert.equal(isTransientSyncError(error), transient, "Private provider message digits do not override the actual HTTP status");
  }
  for (const code of ["MailboxNotEnabledForRESTAPI", "MailboxNotSupportedForRESTAPI", "ErrorItemNotFound", "ResourceNotFound", "BadRequest", "InvalidRequest", "ErrorInvalidRequest", "InvalidAuthenticationToken", "ErrorAccessDenied", "AccessDenied", "TooManyRequests", "ServiceUnavailable"]) {
    for (const innerField of ["innerError", "innererror"]) {
      await failure(() => json({ error: { code, message: privateValue,
        [innerField]: { code, message: privateValue, innerError: { code: "PRIVATE-deep-code" } },
      } }, 404), expected(404, "initial", code, code));
    }
  }
  for (const [code, bounded] of [
    [privateValue, "other"], ["mailboxnotenabledforrestapi", "other"],
    ["", "unparseable"], [" ", "unparseable"], [" BadRequest", "unparseable"],
    ["BadRequest ", "unparseable"], [null, "unparseable"], [3, "unparseable"],
    [true, "unparseable"], [[], "unparseable"], [{ privateValue }, "unparseable"],
  ] as const) {
    await failure(() => json({ error: { code, message: privateValue, innerError: { code } } }, 404), expected(404, "initial", bounded, bounded));
  }
  await failure(() => json({}, 404), expected(404, "initial", "missing", "missing"));
  await failure(() => json({ error: {} }, 404), expected(404, "initial", "missing", "missing"));
  for (const body of [null, [], privateValue, 3, true, { error: null }, { error: [] }, { error: privateValue }]) {
    await failure(() => json(body, 404), expected(404, "initial", "unparseable", "unparseable"));
  }
  for (const innerError of [null, [], privateValue, 3, true]) {
    await failure(() => json({ error: { code: "BadRequest", innerError } }, 404), expected(404, "initial", "BadRequest", "unparseable"));
  }
  await failure(() => json({ error: { code: "BadRequest", innerError: null, innererror: { code: "ErrorAccessDenied" } } }, 404), expected(404, "initial", "BadRequest", "unparseable"));
  await failure(() => new Response(privateValue, { status: 404, statusText: "PRIVATE-provider-status-text" }), expected(404, "initial", "unparseable", "unparseable"));
  await failure(() => Object.assign(json({}, 404), { json: async () => { throw Object.assign(new Error(privateValue), { cause: new Error(token) }); } }), expected(404, "initial", "unparseable", "unparseable"));

  // Success pagination returns the original task-list inventory, including empty
  // intermediate pages. Missing envelopes remain fail-closed before authority.
  const first = calendar("PRIVATE-task-list-one"), last = { ...calendar("PRIVATE-task-list-two"), isOwner: false };
  const pages = read([
    { url: initial, response: () => json({ value: [first], "@odata.nextLink": next }) },
    { url: next, response: () => json({ value: [last] }) },
  ]);
  assert.deepEqual(await pages.result, [first, last]);
  assert.deepEqual(pages.requests, [initial, next]); cases++;
  const emptyIntermediate = read([
    { url: initial, response: () => json({ value: [], "@odata.nextLink": next }) },
    { url: next, response: () => json({ value: [last] }) },
  ]);
  assert.deepEqual(await emptyIntermediate.result, [last]);
  assert.deepEqual(emptyIntermediate.requests, [initial, next]); cases++;
  for (const body of [{ value: [] }]) {
    const empty = read([{ url: initial, response: () => json(body) }]);
    assert.deepEqual(await empty.result, []);
    assert.deepEqual(empty.requests, [initial]); cases++;
  }
  const invalidEmpty = read([{ url: initial, response: () => json({}) }]);
  await assert.rejects(invalidEmpty.result, error => error instanceof Error && error.name === "GraphDiscoveryInventoryError");
  assert.deepEqual(invalidEmpty.requests, [initial]); cases++;
  let transportCalls = 0;
  const transportError = new TypeError("Synthetic network failure");
  await assert.rejects(fetchMicrosoftTaskLists(token, async () => { transportCalls++; throw transportError; }), error => error === transportError);
  assert.equal(transportCalls, 1, "Transport errors are not retried or rewrapped by HTTP diagnostics"); cases++;
  let defaultFetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    defaultFetchCalls++; assert.equal(String(input), initial);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    return json({ value: [first] });
  };
  try { assert.deepEqual(await fetchMicrosoftTaskLists(token), [first]); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(defaultFetchCalls, 1); cases++;
  const defaultRequests: string[] = [];
  globalThis.fetch = async input => {
    defaultRequests.push(String(input)); assert.equal(String(input), initial);
    globalThis.fetch = async input => {
      defaultRequests.push(String(input)); assert.equal(String(input), next);
      return json({ value: [last] });
    };
    return json({ value: [first], "@odata.nextLink": next });
  };
  try { assert.deepEqual(await fetchMicrosoftTaskLists(token), [first, last]); }
  finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(defaultRequests, [initial, next], "The default fetch is still resolved per page, as before extraction"); cases++;
  console.log(`Microsoft task-list discovery diagnostics: ${cases} actual-reader cases; safe bounded HTTP evidence, status parity and unchanged paging OK`);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
