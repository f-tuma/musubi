import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:7531";

async function main() {
  const microsoft = await import("./microsoft");
  const { isMicrosoftEventMailboxUnavailable } = await import("./microsoft_calendar_discovery_error");
  const privateValue = "PRIVATE-provider-body-token-and-calendar-name";
  const graph = "https://graph.microsoft.com/v1.0";
  let cases = 0;
  // Run this assertion first: before the fix the actual calendar reader accepts
  // {} as a complete empty inventory, which can remove seeded local mirrors.
  await assert.rejects(microsoft.fetchMicrosoftCalendars(privateValue, async () => Response.json({})), /incomplete or invalid/);
  cases++;
  for (const [status, phase, body, expected] of [
    [404, "initial", { error: { code: "MailboxNotEnabledForRESTAPI" } }, true],
    [404, "initial", { error: { code: "MailboxNotSupportedForRESTAPI" } }, true],
    [404, "initial", { error: { code: "ErrorItemNotFound", innerError: { code: "MailboxNotEnabledForRESTAPI" } } }, true],
    [404, "initial", { error: { code: "ErrorItemNotFound", innererror: { code: "MailboxNotSupportedForRESTAPI" } } }, true],
    [404, "initial", { error: { code: "ResourceNotFound", message: "MailboxNotEnabledForRESTAPI" } }, false],
    [404, "initial", { error: { code: "mailboxnotenabledforrestapi" } }, false],
    [404, "initial", { error: { code: "ErrorItemNotFound", innerError: { innerError: { code: "MailboxNotEnabledForRESTAPI" } } } }, false],
    [404, "initial", {}, false],
    ...[400, 401, 403, 408, 410, 429, 500, 503].map(status => [status, "initial", { error: { code: "MailboxNotEnabledForRESTAPI" } }, false]),
    [404, "next-page", { error: { code: "MailboxNotEnabledForRESTAPI" } }, false],
  ] as const) {
    let requests = 0;
    await assert.rejects(microsoft.fetchMicrosoftCalendars(privateValue, async () => {
      requests++;
      if (phase === "next-page" && requests === 1) return Response.json({ value: [], "@odata.nextLink": `${graph}/me/calendars?second=true` });
      return Response.json(body, { status: Number(status) });
    }), error => {
      assert.equal(isMicrosoftEventMailboxUnavailable(error), expected);
      return true;
    });
    assert.equal(requests, phase === "next-page" ? 2 : 1); cases++;
  }
  assert.equal(isMicrosoftEventMailboxUnavailable({ cause: { httpStatus: 404, requestPhase: "initial", graphCode: "MailboxNotEnabledForRESTAPI" } }), false); cases++;
  for (const kind of ["events", "tasks"] as const) {
    const initial = kind === "events"
      ? `${graph}/me/calendars?$select=id,name,hexColor,canEdit,canViewPrivateItems,isDefaultCalendar&$top=100`
      : `${graph}/me/todo/lists?$top=100`;
    const collection = kind === "events" ? "/me/calendars" : "/me/todo/lists";
    const next = `${graph}${collection}?$skiptoken=PRIVATE%2b%3D&repeat=z&repeat=a&empty=`;
    const item = (id = "one") => kind === "events" ? { id, name: privateValue, canEdit: true } : { id, displayName: privateValue, isOwner: true };
    const reader = kind === "events" ? microsoft.fetchMicrosoftCalendars : microsoft.fetchMicrosoftTaskLists;
    const run = (responses: (() => Response)[]) => {
      const requests: string[] = [];
      const result = reader(privateValue, async (input, init) => {
        requests.push(String(input));
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${privateValue}`);
        assert.ok(requests.length <= responses.length, "No unplanned extra request");
        return responses[requests.length - 1]!();
      });
      return { result, requests };
    };
    const rejects = async (responses: (() => Response)[], expectedRequests = responses.length) => {
      const read = run(responses);
      await assert.rejects(read.result, error => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "GraphDiscoveryInventoryError");
        const evidence = JSON.stringify({ message: error.message, stack: error.stack, cause: (error as Error & { cause?: unknown }).cause });
        assert.ok(!evidence.includes(privateValue));
        assert.ok(!evidence.includes(next));
        return true;
      });
      assert.equal(read.requests.length, expectedRequests);
      cases++;
    };
    for (const body of [null, [], privateValue, {}, { value: null }, { value: {} }, { value: [null] },
      { value: [{}] }, { value: [{ id: "" }] }, { value: [{ id: " one" }] },
      { value: [{ ...item(), id: "bad\ud800" }] },
      { value: [{ id: "one\n" }] }, { value: [item(), item()] },
      { value: [{ ...item(), "@removed": { reason: "deleted" } }] },
      { value: [], error: null }, { value: [], "@odata.deltaLink": next },
      { value: [], "@odata.nextLink": null }, { value: [], "@odata.nextLink": "" },
    ]) await rejects([() => Response.json(body)]);
    for (const fields of kind === "events" ? [{ name: null }, { name: {} }, { name: undefined }, { name: "bad\u0000name" }, { hexColor: "bad\u0000color" }, { hexColor: {} }, { canEdit: "true" }, { canViewPrivateItems: 1 }, { isDefaultCalendar: [] }]
      : [{ displayName: {} }, { displayName: "bad\u0000name" }, { isOwner: "true" }]) await rejects([() => Response.json({ value: [{ ...item(), ...fields }] })]);
    if (kind === "events") for (const id of ["musubi-microsoft-task-list:", "musubi-microsoft-task-list:foo"])
      await rejects([() => Response.json({ value: [item(id)] })]);
    await rejects([() => new Response(null, { status: 204 })]);
    await rejects([() => Response.json({ value: [] }, { status: 206 })]);
    await rejects([() => Response.json({ value: [] }, { headers: { "content-range": "items 0-0/2" } })]);
    await rejects([() => Object.defineProperty(Response.json({ value: [] }), "redirected", { value: true })]);
    await rejects([() => new Response(privateValue)]);
    for (const bad of ["https://evil.invalid/steal", `${graph}${collection}/../calendars?x`,
      `https://graph.microsoft.com\\v1.0${collection}`, `https://u:p@graph.microsoft.com/v1.0${collection}`,
      `${next}#private`, `${graph}/me/events`, `${graph}/me/todo/lists/other/tasks`, `${graph}/me/calendars/other/events`,
    ]) await rejects([() => Response.json({ value: [item()], "@odata.nextLink": bad })]);
    await rejects([() => Response.json({ value: [item()], "@odata.nextLink": next }), () => Response.json({})]);
    await rejects([() => Response.json({ value: [item()], "@odata.nextLink": next }), () => Response.json({ value: [item()] })]);
    await rejects([() => Response.json({ value: [], "@odata.nextLink": initial })], 1);
    const empty = run([() => Response.json({ value: [] })]);
    assert.deepEqual(await empty.result, []); cases++;
    const complete = run([() => Response.json({ value: [], "@odata.nextLink": next }), () => Response.json({ value: [item()] })]);
    assert.equal((await complete.result).length, 1);
    assert.deepEqual(complete.requests, [initial, next]); cases++;
    const opaqueID = "opaque:'musubi-microsoft-task-list:foo";
    const opaque = run([() => Response.json({ value: [item(opaqueID)] })]);
    const opaqueResult = await opaque.result;
    assert.equal(kind === "events" ? (opaqueResult[0] as { externalId: string }).externalId : (opaqueResult[0] as { id: string }).id, opaqueID);
    cases++;
    if (kind === "tasks") {
      const nativeTaskID = "musubi-microsoft-task-list:foo";
      const prefixed = run([() => Response.json({ value: [item(nativeTaskID)] })]);
      assert.equal(((await prefixed.result)[0] as { id: string }).id, nativeTaskID, "The reserved host namespace does not rewrite native Task list IDs"); cases++;
      assert.equal(microsoft.microsoftTaskListExternalId(nativeTaskID), `musubi-microsoft-task-list:${nativeTaskID}`);
    }
    for (const displayName of ["", " Work ", " Český kalendář 日本語 ", "line\nname"]) {
      const display = run([() => Response.json({ value: [{ ...item(), [kind === "events" ? "name" : "displayName"]: displayName }] })]);
      assert.equal((await display.result).length, 1, "Human names are not identity or continuation locators"); cases++;
    }
    const pages = Array.from({ length: 1000 }, (_, index) => () => Response.json({ value: [], "@odata.nextLink": `${graph}${collection}?page=${index}` }));
    await rejects(pages, 1000);
  }
  console.log(`Microsoft discovery inventories: ${cases} actual-reader strict inventory cases OK`);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
