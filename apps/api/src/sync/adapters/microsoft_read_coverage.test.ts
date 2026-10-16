import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { fetchMicrosoftChanges, parseCursor } = await import("./microsoft");
  const { StructuredLogger } = await import("@musubi/config");
  const { isOptionalTaskError, isTransientSyncError } = await import("../errors");
  const base = "https://graph.microsoft.com/v1.0";
  const calendar = "work/team";
  const view = `${base}/me/calendars/work%2Fteam/calendarView/delta`;
  const eventPath = `${base}/me/calendars/work%2Fteam/events/`;
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const day = 86_400_000;
  const cursor = JSON.stringify({ version: 2, calendarId: calendar, windowStart: now - 180 * day,
    windowEnd: now + 730 * day, link: `${view}?token=previous` });
  const item = (id = "native", extra: Record<string, unknown> = {}) => ({
    id, type: "singleInstance", subject: "Present", isAllDay: false,
    start: { dateTime: "2026-11-01T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-01T10:00:00.0000000", timeZone: "UTC" },
    ...extra,
  });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const page = (value: unknown[] = [], token = "next") => json({ value, "@odata.deltaLink": `${view}?token=${token}` });
  const removed = (id = "native") => ({ id, "@removed": { reason: "deleted" } });
  const missing = () => json({ error: { code: "ErrorItemNotFound", message: "Item missing" } }, 404);
  const read = (fetchImpl: typeof fetch, previous = cursor, extra: Record<string, unknown> = {}) =>
    fetchMicrosoftChanges("fixture", calendar, previous, { now, fetchImpl, ...extra });

  // Graph may spell the same opaque calendar ID differently in continuation
  // paths. Compare that one path segment by identity, then fetch and save the
  // provider's original URL without rebuilding its opaque query or encoding.
  const continuationCases = [
    { id: "AAMkFixture=", segments: ["AAMkFixture=", "AAMkFixture%3D", "AAMkFixture%3d"] },
    { id: "AAMk+Fixture", segments: ["AAMk+Fixture", "AAMk%2BFixture", "AAMk%2bFixture"] },
    { id: "work/team", segments: ["work%2Fteam", "work%2fteam"] },
    { id: "Work-Team_~", segments: ["Work-Team_~", "%57ork%2DTeam%5f%7E"] },
    { id: "work%2Fteam", segments: ["work%252Fteam", "%77ork%252Fteam"] },
  ];
  const opaqueQuery = "?$skiptoken=one%2btwo%3D&$skiptoken=keep+plus&encoded=%252F&empty=&order=z&order=a";
  const preservedWindow = { windowStart: now - 120 * day, windowEnd: now + 300 * day };
  for (const fixture of continuationCases) {
    for (const [index, segment] of fixture.segments.entries()) {
      const canonical = `${base}/me/calendars/${encodeURIComponent(fixture.id)}/calendarView/delta`;
      const previousLink = `${canonical}?$deltatoken=previous%2Bopaque%3d`;
      const nextLink = `${base}/me/calendars/${segment}/calendarView/delta${opaqueQuery}`;
      const terminalSegment = fixture.segments[(index + 1) % fixture.segments.length]!;
      const terminalLink = `${base}/me/calendars/${terminalSegment}/calendarView/delta${opaqueQuery}&terminal=true`;
      const previous = JSON.stringify({ version: 2, calendarId: fixture.id, ...preservedWindow, link: previousLink });
      const requests: string[] = [];
      const result = await fetchMicrosoftChanges("fixture", fixture.id, previous, { now,
        fetchImpl: async (input, init) => {
          const url = String(input); requests.push(url);
          assert.equal(init?.redirect, "error");
          assert.equal(init?.method ?? "GET", "GET");
          assert.equal(url, requests.length === 1 ? previousLink : nextLink,
            "The adapter must fetch the original continuation bytes");
          assert.ok(requests.length <= 2, "A completed two-page delta must stop fetching");
          return json({ value: requests.length === 1 ? [item("first-page")] : [item("last-page")],
            [requests.length === 1 ? "@odata.nextLink" : "@odata.deltaLink"]:
              requests.length === 1 ? nextLink : terminalLink });
        } });
      assert.deepEqual(requests, [previousLink, nextLink]);
      assert.deepEqual(result.changes.map(change => change.kind === "event" && change.data.externalId), ["first-page", "last-page"]);
      assert.equal(result.reset, false);
      assert.equal(result.cursorRestarted, false, "Equivalent path encoding must not renew the saved cursor");
      assert.deepEqual(parseCursor(result.nextCursor), { version: 2, calendarId: fixture.id,
        ...preservedWindow, link: terminalLink });
      assert.deepEqual(result.coverage, { kind: "window", complete: true,
        fromInclusive: new Date(preservedWindow.windowStart).toISOString(),
        untilExclusive: new Date(preservedWindow.windowEnd).toISOString() });

      let roundTripRequests = 0;
      const afterRoundTrip = await fetchMicrosoftChanges("fixture", fixture.id, result.nextCursor, { now: now + day,
        fetchImpl: async input => {
          roundTripRequests++;
          assert.equal(String(input), terminalLink, "A saved continuation must round-trip byte-for-byte");
          return json({ value: [], "@odata.deltaLink": terminalLink });
        } });
      assert.equal(roundTripRequests, 1);
      assert.equal(afterRoundTrip.cursorRestarted, false);
      assert.deepEqual(parseCursor(afterRoundTrip.nextCursor), parseCursor(result.nextCursor));
      assert.deepEqual(afterRoundTrip.coverage, result.coverage, "The exact original window survives cursor reuse");
    }
  }

  // Decoding a calendar segment cannot authorize another origin, route,
  // identity, or a second decode. Reject unsafe next/delta links before any
  // credential-bearing follow-up request; do not certify the partial page.
  const outsideScopeLinks = [
    "https://foreign.example/v1.0/me/calendars/work%2Fteam/calendarView/delta?token=opaque",
    "http://graph.microsoft.com/v1.0/me/calendars/work%2Fteam/calendarView/delta?token=opaque",
    "https://graph.microsoft.com:444/v1.0/me/calendars/work%2Fteam/calendarView/delta?token=opaque",
    `${base.replace("v1.0", "beta")}/me/calendars/work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/users/someone/calendars/work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendar/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/events/delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/delta/extra?token=opaque`,
    `${base}/prefix/me/calendars/work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/Work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%2Fother/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work/team/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%252Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%2team/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%GGteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%C0%AFteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/de\tlta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/de\nlta?token=opaque`,
    `${base}/me/calendars/./work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/ignored/../work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/%2e/work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/ignored/%2E%2e/work%2Fteam/calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/./delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/ignored/../delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/%2e/delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam\\calendarView/delta?token=opaque`,
    `${base}/me/calendars/work%2Fteam/calendarView/delta?token=opaque#fragment`,
    `${base}/me/calendars/work%2Fteam/calendarView/delta?token=opaque#`,
    "https://@graph.microsoft.com/v1.0/me/calendars/work%2Fteam/calendarView/delta?token=opaque",
    "https://fixture@graph.microsoft.com/v1.0/me/calendars/work%2Fteam/calendarView/delta?token=opaque",
    "https://fixture:synthetic@graph.microsoft.com/v1.0/me/calendars/work%2Fteam/calendarView/delta?token=opaque",
  ];
  const boundCalendarURL = `${base}/me/calendars/${encodeURIComponent(calendar)}`;
  const principalURL = `${base}/me?$select=id`;
  const eligibleUnprovenAliases = new Set([
    `${base}/users/someone/calendars/work%2Fteam/calendarView/delta?token=opaque`,
  ]);
  for (const link of outsideScopeLinks) {
    for (const property of ["@odata.nextLink", "@odata.deltaLink"]) {
      let requests = 0;
      await assert.rejects(read(async input => {
        requests++;
        if (String(input) === boundCalendarURL) {
          assert.ok(eligibleUnprovenAliases.has(link), "Unsafe shapes cannot initiate calendar identity probes");
          return json({ id: calendar, "@odata.id": boundCalendarURL });
        }
        if (String(input) === principalURL) {
          assert.ok(eligibleUnprovenAliases.has(link));
          return json({ id: "different-current-principal" });
        }
        assert.equal(String(input), JSON.parse(cursor).link);
        assert.equal(requests, 1, "A rejected continuation must never be followed");
        return json({ value: [item("uncommitted-page")], [property]: link });
      }), /delta link/, `A foreign or malformed ${property} must be rejected`);
      assert.equal(requests, eligibleUnprovenAliases.has(link) ? 3 : 1);
    }
    let renewedRequests = 0;
    const unsafeCursor = JSON.stringify({ ...JSON.parse(cursor), link });
    const renewed = await read(async input => {
      renewedRequests++;
      if (String(input) === boundCalendarURL) {
        assert.ok(eligibleUnprovenAliases.has(link));
        return json({ id: calendar, "@odata.id": boundCalendarURL });
      }
      if (String(input) === principalURL) {
        assert.ok(eligibleUnprovenAliases.has(link));
        return json({ id: "different-current-principal" });
      }
      const requested = new URL(String(input));
      assert.equal(requested.origin, "https://graph.microsoft.com");
      assert.equal(requested.pathname, new URL(view).pathname);
      assert.equal(requested.searchParams.get("startDateTime"), new Date(now - 180 * day).toISOString());
      assert.equal(requested.searchParams.get("endDateTime"), new Date(now + 730 * day).toISOString());
      return page();
    }, unsafeCursor);
    assert.equal(renewedRequests, eligibleUnprovenAliases.has(link) ? 3 : 1,
      "An unsafe saved cursor must be renewed without fetching its link");
    assert.equal(renewed.cursorRestarted, true);
    assert.equal(renewed.reset, false);
    assert.deepEqual(renewed.changes, []);
  }

  // Incident diagnostics describe only the structural rejection. Even the
  // real logger's Error serialization must never reveal opaque link material.
  const privateCalendar = "PRIVATE-Calendar-AAMk+confidential=";
  const privateOtherCalendar = "PRIVATE-OtherCalendar-ID";
  const privateToken = "PRIVATE-DeltaToken-NotCredential";
  const privateUser = "PRIVATE-User-Synthetic";
  const privatePassword = "PRIVATE-Password-Synthetic";
  const privateOtherOwner = "PRIVATE-OtherOwner";
  const privateView = `${base}/me/calendars/${encodeURIComponent(privateCalendar)}/calendarView/delta`;
  const privateCursor = JSON.stringify({ version: 2, calendarId: privateCalendar,
    ...preservedWindow, link: `${privateView}?token=previous` });
  const defaultRoutes = [
    { path: "/me/calendarView/delta", ownerKind: "me" },
    { path: "/me/calendar/calendarView/delta", ownerKind: "me" },
    { path: `/users/${privateOtherOwner}/calendarView/delta`, ownerKind: "users-segment" },
    { path: `/users/${privateOtherOwner}/calendar/calendarView/delta`, ownerKind: "users-segment" },
    { path: `/users('${privateOtherOwner}')/calendarView/delta`, ownerKind: "users-odata" },
    { path: `/users('${privateOtherOwner}')/calendar/calendarView/delta`, ownerKind: "users-odata" },
  ];
  const diagnosticCases: { link: string; bindingMismatch?: boolean; invalid?: boolean;
    route?: string; ownerKind?: string; details?: Record<string, boolean> }[] = [
    { link: `https://${privateUser}:${privatePassword}@graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(privateCalendar)}/calendarView/delta?$deltatoken=${privateToken}`,
      details: { hasCredentials: true, calendarIdMatches: true } },
    { link: `${base}/me/calendars/${privateOtherCalendar}/calendarView/delta?$deltatoken=${privateToken}`,
      details: { calendarIdMatches: false, pathPrefixMatches: true, pathSuffixMatches: true } },
    { link: `${base}/users('${privateOtherOwner}')/calendars('${encodeURIComponent(privateCalendar)}')/calendarView/delta?$deltatoken=${privateToken}`,
      bindingMismatch: true, details: { pathPrefixMatches: false, calendarIdMatches: false } },
    { link: `${base}/me/calendars/%GG/calendarView/delta?$deltatoken=${privateToken}`,
      details: { calendarEncodingValid: false, calendarIdMatches: false } },
    { link: `${privateView}/./?$deltatoken=${privateToken}`, details: { pathUnmodified: false } },
    { link: `${privateView}?$deltatoken=${privateToken}\tcontinued`, invalid: true },
    { link: `${privateCalendar}:${privateToken} is not an absolute URL`, invalid: true },
    ...defaultRoutes.map(route => ({ link: `${base}${route.path}?$deltatoken=${privateToken}`,
      route: "default-calendar", ownerKind: route.ownerKind,
      details: { pathPrefixMatches: false, pathSuffixMatches: true } })),
    { link: `${base}/users/%GG/calendarView/delta?$deltatoken=${privateToken}`,
      details: { pathPrefixMatches: false, pathSuffixMatches: true } },
    { link: `${base}/users('')/calendarView/delta?$deltatoken=${privateToken}`,
      details: { pathPrefixMatches: false, pathSuffixMatches: true } },
    { link: `https://foreign.example/v1.0/users('${privateOtherOwner}')/calendarView/delta?$deltatoken=${privateToken}`,
      details: { sameOrigin: false } },
  ];
  const scopeBooleanKeys = ["sameOrigin", "sameProtocol", "pathPrefixMatches", "pathSuffixMatches",
    "calendarEncodingValid", "calendarIdMatches", "rawPathEqual", "pathUnmodified", "hasCredentials", "hasFragment"];
  for (const fixture of diagnosticCases) {
    for (const property of ["@odata.nextLink", "@odata.deltaLink"] as const) {
      let requests = 0;
      await assert.rejects(fetchMicrosoftChanges("fixture", privateCalendar, privateCursor, { now,
        fetchImpl: async input => {
          requests++;
          if (String(input) === `${base}/me/calendars/${encodeURIComponent(privateCalendar)}`) {
            assert.equal(fixture.bindingMismatch, true);
            return json({ id: privateCalendar, "@odata.id": privateView.replace("/calendarView/delta", "") });
          }
          if (String(input) === principalURL) {
            assert.equal(fixture.bindingMismatch, true);
            return json({ id: privateUser });
          }
          assert.equal(String(input), JSON.parse(privateCursor).link);
          assert.equal(requests, 1);
          return json({ value: [], [property]: fixture.link });
        } }), (error: unknown) => {
        assert.ok(error instanceof Error);
        const cause = (error as Error & { cause: Record<string, unknown> }).cause;
        assert.ok(cause && typeof cause === "object" && !Array.isArray(cause));
        assert.equal(cause.linkKind, property === "@odata.nextLink" ? "next" : "delta");
        if (fixture.invalid) {
          assert.deepEqual(Object.keys(cause).sort(), ["code", "linkKind"]);
          assert.equal(cause.code, "graph-delta-link-invalid");
        } else {
          const bindingKeys = fixture.bindingMismatch ? ["canonicalProofOwnerKind",
            "canonicalCandidateKeyStyle", "canonicalProofKeyStyle", "canonicalOwnerMatches", "canonicalKeyStyleMatches",
            "canonicalMetadataState", "canonicalMetadataFailure", "principalMatches"] : [];
          assert.deepEqual(Object.keys(cause).sort(), [...scopeBooleanKeys, ...bindingKeys,
            "canonicalCandidateRoute", "canonicalCandidateOwnerKind", "code", "linkKind", "calendarSegmentCount"].sort());
          assert.equal(cause.code, "graph-delta-link-scope-invalid");
          assert.equal(cause.canonicalCandidateRoute, fixture.route ?? (fixture.bindingMismatch ? "explicit-calendar" : "unknown"));
          assert.equal(cause.canonicalCandidateOwnerKind, fixture.ownerKind ?? (fixture.bindingMismatch ? "users-odata" : "unknown"));
          for (const key of scopeBooleanKeys) assert.equal(typeof cause[key], "boolean", key);
          assert.ok(cause.calendarSegmentCount === null || Number.isSafeInteger(cause.calendarSegmentCount));
          for (const [key, value] of Object.entries(fixture.details!)) assert.equal(cause[key], value, key);
          if (fixture.bindingMismatch) {
            assert.equal(cause.canonicalCandidateOwnerKind, "users-odata");
            assert.equal(cause.canonicalProofOwnerKind, "me");
            assert.equal(cause.canonicalCandidateKeyStyle, "odata");
            assert.equal(cause.canonicalProofKeyStyle, "segment");
            assert.equal(cause.canonicalOwnerMatches, false);
            assert.equal(cause.canonicalKeyStyleMatches, false);
            assert.equal(cause.canonicalMetadataState, "present");
            assert.equal(cause.canonicalMetadataFailure, "none");
            assert.equal(cause.principalMatches, false);
          }
        }

        const lines: string[] = [];
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
        try { new StructuredLogger("error").error("sync.failed", { error }); }
        finally { process.stderr.write = originalWrite; }
        assert.equal(lines.length, 1);
        const serialized = lines[0]!;
        const logged = JSON.parse(serialized);
        assert.deepEqual(logged.error.cause, cause, "Structural diagnostics survive the real logger");
        for (const sensitive of [fixture.link, privateCalendar, encodeURIComponent(privateCalendar), privateOtherCalendar,
          privateToken, privateUser, privatePassword, privateOtherOwner]) {
          assert.equal(serialized.includes(sensitive), false, "No opaque URL, identity or credential may reach logs");
        }
        return true;
      });
      assert.equal(requests, fixture.bindingMismatch ? 3 : 1);
    }
  }
  for (const route of defaultRoutes) {
    let requests = 0;
    const renewed = await fetchMicrosoftChanges("fixture", privateCalendar,
      JSON.stringify({ ...JSON.parse(privateCursor), link: `${base}${route.path}?$deltatoken=${privateToken}` }), { now,
        fetchImpl: async input => {
          requests++;
          const requested = new URL(String(input));
          assert.equal(requested.pathname, new URL(privateView).pathname);
          assert.equal(requested.searchParams.get("startDateTime"), new Date(now - 180 * day).toISOString());
          assert.equal(requests, 1, "A default-calendar alias must renew without identity probes or following its URL");
          return json({ value: [], "@odata.deltaLink": `${privateView}?token=fresh` });
        } });
    assert.equal(requests, 1);
    assert.equal(renewed.cursorRestarted, true);
  }

  // A canonical alias is accepted only after a fresh, constructed read of the
  // bound calendar proves its exact resource address. The owner key is opaque;
  // the authenticated proof, rather than an OAuth subject or label, binds it.
  const ownerKey = "fixture-owner-guid@fixture-tenant-guid";
  const resourceCases = [
    { id: "AAMkFixture=", resource: `${base}/users('${ownerKey}')/calendars('AAMkFixture%3D')`,
      equivalent: `${base}/users('${ownerKey}')/calendars('AAMkFixture=')` },
    { id: "AAMkFixture=", resource: `${base}/users/${encodeURIComponent(ownerKey)}/calendars/AAMkFixture%3D`,
      equivalent: `${base}/users/${encodeURIComponent(ownerKey)}/calendars/AAMkFixture%3d` },
    { id: "AAMkFixture=", resource: `${base}/me/calendars('AAMkFixture%3D')`,
      equivalent: `${base}/me/calendars('AAMkFixture=')` },
    { id: "work/team", resource: `${base}/users('${ownerKey}')/calendars/work%2Fteam`,
      equivalent: `${base}/users('${ownerKey}')/calendars/work%2fteam` },
    { id: "work/team", resource: `${base}/users/${encodeURIComponent(ownerKey)}/calendars('work%2Fteam')`,
      equivalent: `${base}/users/${encodeURIComponent(ownerKey)}/calendars('work%2fteam')` },
    { id: "work%2Fteam", resource: `${base}/users('${ownerKey}')/calendars('work%252Fteam')`,
      equivalent: `${base}/users('${ownerKey}')/calendars('%77ork%252Fteam')` },
    { id: "AAMk'fixture+/=", resource: `${base}/users('${ownerKey}')/calendars('AAMk''fixture%2B%2F%3D')`,
      equivalent: `${base}/users('${ownerKey}')/calendars('AAMk%27%27fixture+%2f=')` },
  ];
  for (const fixture of resourceCases) {
    const proofURL = `${base}/me/calendars/${encodeURIComponent(fixture.id)}`;
    const standardLink = `${proofURL}/calendarView/delta?$deltatoken=original`;
    const nextLink = `${fixture.equivalent}/calendarView/delta${opaqueQuery}`;
    const finalLink = `${fixture.resource}/calendarView/delta${opaqueQuery}&terminal=true`;
    const previous = JSON.stringify({ version: 2, calendarId: fixture.id, ...preservedWindow, link: standardLink });
    let proofReads = 0;
    const requests: string[] = [];
    const result = await fetchMicrosoftChanges("canonical-fixture-access", fixture.id, previous, { now,
      fetchImpl: async (input, init) => {
        const url = String(input); requests.push(url);
        assert.equal(init?.method ?? "GET", "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer canonical-fixture-access");
        if (url === proofURL) {
          proofReads++;
          assert.equal(proofReads, 1, "A delta invocation reads its identity proof only once");
          assert.equal(new Headers(init?.headers).get("Accept"), "application/json;odata.metadata=full");
          assert.equal(new Headers(init?.headers).get("Cache-Control"), "no-cache");
          return json({ id: fixture.id, "@odata.id": fixture.resource, canViewPrivateItems: false });
        }
        if (url === standardLink) return json({ value: [item("before-alias")], "@odata.nextLink": nextLink });
        assert.equal(url, nextLink, "The proven continuation must retain its original URL bytes");
        return json({ value: [item("after-alias")], "@odata.deltaLink": finalLink });
      } });
    assert.deepEqual(requests, [standardLink, proofURL, nextLink]);
    assert.equal(proofReads, 1);
    assert.equal(result.cursorRestarted, false);
    assert.deepEqual(parseCursor(result.nextCursor), { version: 2, calendarId: fixture.id,
      ...preservedWindow, link: finalLink });
    assert.deepEqual(result.changes.map(change => change.kind === "event" && change.data.externalId), ["before-alias", "after-alias"]);

    const roundTripRequests: string[] = [];
    const roundTrip = await fetchMicrosoftChanges("canonical-fixture-access", fixture.id, result.nextCursor, { now: now + day,
      fetchImpl: async input => {
        const url = String(input); roundTripRequests.push(url);
        if (url === proofURL) return json({ id: fixture.id, "@odata.id": fixture.resource });
        assert.equal(url, finalLink);
        return json({ value: [], "@odata.deltaLink": finalLink });
      } });
    assert.deepEqual(roundTripRequests, [proofURL, finalLink], "A new invocation must re-prove a saved canonical cursor");
    assert.equal(roundTrip.cursorRestarted, false);
    assert.deepEqual(parseCursor(roundTrip.nextCursor), parseCursor(result.nextCursor));
    assert.deepEqual(roundTrip.coverage, result.coverage);
  }

  const canonicalResource = `${base}/users('${ownerKey}')/calendars('work%2Fteam')`;
  const canonicalDelta = `${canonicalResource}/calendarView/delta${opaqueQuery}`;
  const canonicalProof = () => json({ id: calendar, "@odata.id": canonicalResource,
    "@odata.type": "#microsoft.graph.calendar", canViewPrivateItems: false });
  const canonicalCursor = JSON.stringify({ ...JSON.parse(cursor), link: canonicalDelta });

  // The constructed /me/calendars/{id} proof also establishes the same /me
  // primary key written with OData syntax, even when metadata names its owner
  // canonically. It does not establish any unproven /users owner or key style.
  const meODataNext = `${base}/me/calendars('work%2fteam')/calendarView/delta${opaqueQuery}`;
  const meODataTerminal = `${base}/me/calendars('work%2Fteam')/calendarView/delta${opaqueQuery}&terminal=true`;
  const meAliasCanonicalProofs = [
    canonicalResource,
    `${base}/users('${ownerKey}')/calendars/work%2Fteam`,
    `${base}/users/${encodeURIComponent(ownerKey)}/calendars('work%2Fteam')`,
    `${base}/users/${encodeURIComponent(ownerKey)}/calendars/work%2Fteam`,
    boundCalendarURL,
  ];
  for (const resource of meAliasCanonicalProofs) {
    const requests: string[] = [];
    const alias = await read(async (input, init) => {
      const url = String(input); requests.push(url);
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
      if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource });
      if (url === JSON.parse(cursor).link) return json({ value: [item("before-me-alias")], "@odata.nextLink": meODataNext });
      assert.equal(url, meODataNext);
      return json({ value: [item("after-me-alias")], "@odata.deltaLink": meODataTerminal });
    });
    assert.deepEqual(requests, [JSON.parse(cursor).link, boundCalendarURL, meODataNext]);
    assert.deepEqual(alias.changes.map(change => change.kind === "event" && change.data.externalId), ["before-me-alias", "after-me-alias"]);
    assert.equal(alias.cursorRestarted, false);
    assert.ok(alias.nextCursor, "A completed canonical alias delta must persist its cursor");
    assert.deepEqual(parseCursor(alias.nextCursor), { ...JSON.parse(cursor), link: meODataTerminal });
    const roundTripRequests: string[] = [];
    const roundTrip = await read(async input => {
      const url = String(input); roundTripRequests.push(url);
      if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource });
      assert.equal(url, meODataTerminal);
      return json({ value: [], "@odata.deltaLink": meODataTerminal });
    }, alias.nextCursor);
    assert.deepEqual(roundTripRequests, [boundCalendarURL, meODataTerminal]);
    assert.equal(roundTrip.cursorRestarted, false);
    assert.deepEqual(parseCursor(roundTrip.nextCursor), parseCursor(alias.nextCursor));
    assert.deepEqual(roundTrip.coverage, alias.coverage);

    const terminalRequests: string[] = [];
    const terminalOnly = await read(async input => {
      const url = String(input); terminalRequests.push(url);
      if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource });
      assert.equal(url, JSON.parse(cursor).link);
      return json({ value: [], "@odata.deltaLink": meODataTerminal });
    });
    assert.deepEqual(terminalRequests, [JSON.parse(cursor).link, boundCalendarURL]);
    assert.equal(parseCursor(terminalOnly.nextCursor)?.link, meODataTerminal);
  }

  // A canonical owner/style mismatch needs an independent exact principal
  // proof. An unrelated current principal cannot authorize a similar alias.
  const mismatchedCanonicalIdentity = [
    canonicalDelta.replace(ownerKey, "another-owner@another-tenant"),
    canonicalDelta.replace(ownerKey, encodeURIComponent(ownerKey)),
    canonicalDelta.replace("users('" + ownerKey + "')", "users/" + ownerKey),
    canonicalDelta.replace("calendars('work%2Fteam')", "calendars/work%2Fteam"),
  ];
  const unprovenCanonicalLinks = [
    ...mismatchedCanonicalIdentity,
    canonicalDelta.replace("work%2Fteam", "Work%2Fteam"),
    canonicalDelta.replace("work%2Fteam", "work%2Fother"),
    canonicalDelta.replace("work%2Fteam", "work%252Fteam"),
    canonicalDelta.replace("work%2Fteam", "work%GGteam"),
    canonicalDelta.replace("https://graph.microsoft.com", "https://foreign.example"),
    canonicalDelta.replace("https://", "http://"),
    canonicalDelta.replace("/v1.0/", "/beta/"),
    canonicalDelta.replace("/v1.0/", "/v1.0/prefix/"),
    canonicalDelta.replace("/calendarView/delta", "/calendarView/delta/extra"),
    canonicalDelta.replace("/calendarView/delta", "/calendarView/./delta"),
    canonicalDelta.replace("/calendarView/delta", "\\calendarView/delta"),
    canonicalDelta.replace("/calendarView/delta", "/calendarView/de\tlta"),
    `${canonicalDelta}#`,
    canonicalDelta.replace("https://", "https://@"),
    canonicalDelta.replace("https://", "https://fixture:synthetic@"),
  ];
  for (const link of unprovenCanonicalLinks) {
    let continuationReads = 0, proofReads = 0, principalReads = 0;
    await assert.rejects(read(async input => {
      const url = String(input);
      if (url === boundCalendarURL) { proofReads++; assert.equal(proofReads, 1); return canonicalProof(); }
      if (url === principalURL) { principalReads++; assert.equal(principalReads, 1); return json({ id: "different-current-principal" }); }
      assert.equal(url, JSON.parse(cursor).link, "A candidate cannot be fetched before its exact binding is proven");
      continuationReads++;
      return json({ value: [item("uncommitted-alias")], "@odata.nextLink": link });
    }), /delta link/);
    assert.equal(continuationReads, 1);
    assert.equal(proofReads, mismatchedCanonicalIdentity.includes(link) ? 1 : 0,
      "Only a syntactically safe explicit binding candidate may request identity proof");
    assert.equal(principalReads, mismatchedCanonicalIdentity.includes(link) ? 1 : 0);
  }

  // A stale saved owner alias can renew only after a valid proof disagrees;
  // it must not reuse the rejected alias or request its identity as a probe.
  const staleAlias = canonicalDelta.replace(ownerKey, "stale-owner@stale-tenant");
  const staleRequests: string[] = [];
  const renewedAlias = await read(async input => {
    const url = String(input); staleRequests.push(url);
    if (url === boundCalendarURL) return canonicalProof();
    if (url === principalURL) return json({ id: ownerKey });
    const requested = new URL(url);
    assert.equal(requested.pathname, new URL(view).pathname);
    assert.equal(requested.searchParams.get("startDateTime"), new Date(now - 180 * day).toISOString());
    return json({ value: [], "@odata.deltaLink": canonicalDelta });
  }, JSON.stringify({ ...JSON.parse(cursor), link: staleAlias }));
  assert.equal(staleRequests.length, 3);
  assert.equal(staleRequests[0], boundCalendarURL);
  assert.equal(renewedAlias.cursorRestarted, true);
  assert.equal(parseCursor(renewedAlias.nextCursor)?.link, canonicalDelta);

  const proofSecret = "PRIVATE-Proof-Body-Identity-And-DeltaToken";
  const invalidCanonicalResources = [
    undefined, null, 3, true, {}, [], "", "  ", "/v1.0/me/calendars/work%2Fteam", "not an absolute URL",
    canonicalResource.replace("graph.microsoft.com", "foreign.example"),
    canonicalResource.replace("https://", "http://"),
    canonicalResource.replace("/v1.0/", "/beta/"),
    `${canonicalResource}?`, `${canonicalResource}?token=${proofSecret}`, `${canonicalResource}#`,
    canonicalResource.replace("https://", "https://@"),
    canonicalResource.replace("https://", `https://${proofSecret}:synthetic@`),
    canonicalResource.replace("work%2Fteam", "another-calendar"),
    canonicalResource.replace("work%2Fteam", "work%252Fteam"),
    canonicalResource.replace("work%2Fteam", "work%GGteam"),
    canonicalResource.replace(ownerKey, ""), `${canonicalResource}/events`,
    `${base}/me/calendar`, `${base}/unknown/calendars('work%2Fteam')`,
    canonicalResource.replace("/users(", "/./users("),
    canonicalResource.replace("/users(", "/%2e/users("),
    canonicalResource.replace("/calendars(", "\\calendars("),
    canonicalResource.replace("/calendars(", "/cale\nndars("),
  ];
  const contradictoryCanonicalResources = [
    canonicalResource.replace("work%2Fteam", "another-calendar"),
    canonicalResource.replace("work%2Fteam", "work%252Fteam"),
  ];
  const unusableCanonicalResources = invalidCanonicalResources.filter(resource =>
    !contradictoryCanonicalResources.includes(resource as string));
  const identityDiagnosticKeys = ["canonicalCandidateRoute", "canonicalCandidateOwnerKind", "canonicalCandidateKeyStyle",
    "canonicalMetadataState", "canonicalMetadataFailure", "canonicalProofOwnerKind", "canonicalProofKeyStyle", "principalMatches"];
  const assertIdentityFailure = (error: unknown, reason: string, privateValues: string[] = [], transient = false) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /delta link/);
    const cause = (error as Error & { cause: Record<string, unknown> }).cause;
    assert.equal(cause?.code, "graph-calendar-identity-unverified");
    assert.equal(cause.reason, reason);
    assert.deepEqual(Object.keys(cause).sort(), ["code", "reason", ...identityDiagnosticKeys,
      ...(cause.status === undefined ? [] : ["status"])].sort());
    if (cause.status !== undefined) assert.equal(typeof cause.status, "number");
    assert.equal(cause.canonicalCandidateRoute, "explicit-calendar");
    assert.ok(["me", "users-segment", "users-odata"].includes(String(cause.canonicalCandidateOwnerKind)));
    assert.ok(["segment", "odata"].includes(String(cause.canonicalCandidateKeyStyle)));
    assert.ok(["not-evaluated", "absent", "null", "non-string", "empty", "present"].includes(String(cause.canonicalMetadataState)));
    assert.ok(["not-evaluated", "none", "not-absolute", "unsafe-url", "origin", "protocol", "version", "unsupported-route", "calendar-key-mismatch"]
      .includes(String(cause.canonicalMetadataFailure)));
    assert.ok(["unknown", "me", "users-segment", "users-odata"].includes(String(cause.canonicalProofOwnerKind)));
    assert.ok(["unknown", "segment", "odata"].includes(String(cause.canonicalProofKeyStyle)));
    assert.ok(cause.principalMatches === null || typeof cause.principalMatches === "boolean");
    assert.equal(isTransientSyncError(error), transient, "Only failed HTTP proof requests may be classified as retryable");
    if (cause.status === 401 || cause.status === 403) {
      assert.equal(isOptionalTaskError(error), false, "An identity proof denial cannot become an optional Tasks failure");
    }
    const lines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { new StructuredLogger("warn")[isTransientSyncError(error) ? "warn" : "error"]("sync.account.failed", { error }); }
    finally { process.stderr.write = originalWrite; }
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).level, transient ? "warn" : "error");
    assert.deepEqual(JSON.parse(lines[0]!).error.cause, cause);
    for (const sensitive of [proofSecret, canonicalDelta, canonicalResource, ownerKey, calendar, "one%2btwo%3D", ...privateValues]) {
      assert.equal(lines[0]!.includes(sensitive), false, "Proof failures cannot expose addresses or private response bodies");
    }
    return true;
  };

  // Production returned HTTP 504 while proving a /me OData calendar alias.
  // The read must still fail without following the alias or returning buffered
  // changes. Only its failure classification is transient.
  for (const property of [null, "@odata.nextLink", "@odata.deltaLink"] as const) {
    const saved = property === null;
    const link = property === "@odata.nextLink" ? meODataNext : meODataTerminal;
    const previous = saved ? JSON.stringify({ ...JSON.parse(cursor), link }) : cursor;
    const requests: string[] = [];
    await assert.rejects(read(async (input, init) => {
      const url = String(input); requests.push(url);
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(init?.redirect, "error");
      if (url === boundCalendarURL) {
        return new Response(JSON.stringify({ error: { message: proofSecret } }), {
          status: 504, statusText: proofSecret, headers: { "content-type": "application/json" },
        });
      }
      assert.equal(saved, false, "A saved alias must obtain identity proof before its delta GET");
      assert.equal(url, JSON.parse(cursor).link, "A failed proof cannot follow the unverified alias");
      return json({ value: [item("uncommitted-me-proof-timeout")], [property!]: link });
    }, previous), error => {
      assertIdentityFailure(error, "response", [], true);
      const cause = (error as Error & { cause: Record<string, unknown> }).cause;
      assert.equal(cause.status, 504);
      assert.equal(cause.canonicalCandidateRoute, "explicit-calendar");
      assert.equal(cause.canonicalCandidateOwnerKind, "me");
      assert.equal(cause.canonicalCandidateKeyStyle, "odata");
      assert.equal(cause.canonicalMetadataState, "not-evaluated");
      assert.equal(cause.canonicalMetadataFailure, "not-evaluated");
      assert.equal(cause.canonicalProofOwnerKind, "unknown");
      assert.equal(cause.canonicalProofKeyStyle, "unknown");
      assert.equal(cause.principalMatches, null);
      return true;
    });
    assert.deepEqual(requests, saved ? [boundCalendarURL] : [JSON.parse(cursor).link, boundCalendarURL]);
  }

  // A successful scoped body read proves /me's explicit calendar primary key
  // without relying on an optional, missing or unusable metadata annotation.
  for (const resource of unusableCanonicalResources) {
    const requests: string[] = [];
    const accepted = await read(async input => {
      const url = String(input); requests.push(url);
      if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource, canViewPrivateItems: false });
      if (url === JSON.parse(cursor).link) return json({ value: [], "@odata.nextLink": meODataNext });
      assert.equal(url, meODataNext, "Unusable metadata cannot authorize another URL or change the opaque token");
      return json({ value: [item("body-proven-me")], "@odata.deltaLink": meODataTerminal });
    });
    assert.deepEqual(requests, [JSON.parse(cursor).link, boundCalendarURL, meODataNext]);
    assert.equal(accepted.cursorRestarted, false);
    assert.ok(accepted.nextCursor);
    const savedRequests: string[] = [];
    const saved = await read(async input => {
      const url = String(input); savedRequests.push(url);
      if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource });
      assert.equal(url, meODataTerminal);
      return json({ value: [], "@odata.deltaLink": meODataTerminal });
    }, accepted.nextCursor);
    assert.deepEqual(savedRequests, [boundCalendarURL, meODataTerminal]);
    assert.equal(saved.cursorRestarted, false);
    assert.deepEqual(parseCursor(saved.nextCursor), parseCursor(accepted.nextCursor));
    assert.deepEqual(saved.coverage, accepted.coverage);
    const bodyProvenUser = "BodyProvenCurrentPrincipal";
    const userLink = `${base}/users/${bodyProvenUser}/calendars/work%2Fteam/calendarView/delta${opaqueQuery}`;
    const userRequests: string[] = [];
    const userAccepted = await read(async input => {
      const url = String(input); userRequests.push(url);
      if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource });
      if (url === principalURL) return json({ id: bodyProvenUser });
      assert.equal(url, JSON.parse(cursor).link);
      return json({ value: [], "@odata.deltaLink": userLink });
    });
    assert.deepEqual(userRequests, [JSON.parse(cursor).link, boundCalendarURL, principalURL]);
    assert.equal(parseCursor(userAccepted.nextCursor)?.link, userLink);
  }
  const transientIdentityStatuses = new Set([408, 429, 500, 503, 504, 599]);
  const invalidProofs: { name: string; reason: string; transient?: boolean; response: () => Response | Promise<Response> }[] = [
    ...[null, [], {}, { id: "different", "@odata.id": canonicalResource },
      { id: calendar, "@odata.id": canonicalResource, "@removed": null },
      { id: calendar, "@odata.id": canonicalResource, "@odata.nextLink": null },
      { id: calendar, "@odata.id": canonicalResource, "@odata.deltaLink": null },
      { id: calendar, "@odata.id": canonicalResource, value: [] },
      { id: calendar, "@odata.id": canonicalResource, "@odata.type": "#microsoft.graph.event" }]
      .map((body, index) => ({ name: `body-${index}`, reason: "body", response: () => json(body) })),
    ...contradictoryCanonicalResources.map((resource, index) => ({ name: `canonical-resource-${index}`,
      reason: "canonical-resource", response: () => json({ id: calendar, "@odata.id": resource }) })),
    ...[202, 204, 206, 301, 302, 401, 403, 404, 408, 410, 429, 500, 503, 504, 599].map(status => ({ name: `status-${status}`,
      reason: "response", transient: transientIdentityStatuses.has(status),
      response: () => new Response(status === 204 ? null : JSON.stringify({ error: { message: `${proofSecret} 504 Gateway Timeout` } }),
        { status, statusText: proofSecret, headers: { "content-type": "application/json" } }) })),
    { name: "content-range", reason: "response", response: () => json({ id: calendar, "@odata.id": canonicalResource }, 200,
      { "content-range": "items 0-0/1" }) },
    { name: "redirected", reason: "response", response: () => Object.defineProperty(canonicalProof(), "redirected", { value: true }) },
    { name: "malformed-json", reason: "body", response: () => new Response(`${proofSecret} is not JSON`, { status: 200 }) },
    { name: "transport", reason: "request", response: async () => { throw new Error(`${proofSecret} ${canonicalDelta}`); } },
  ];
  for (const fixture of invalidProofs) {
    for (const saved of [false, true]) {
      const requests: string[] = [];
      await assert.rejects(read(async input => {
        const url = String(input); requests.push(url);
        if (url === boundCalendarURL) return fixture.response();
        assert.equal(saved, false, "A saved alias requires proof before any delta request");
        assert.equal(url, JSON.parse(cursor).link);
        return json({ value: [item("uncommitted-proof")], "@odata.deltaLink": canonicalDelta });
      }, saved ? canonicalCursor : cursor), (error: unknown) => {
        return assertIdentityFailure(error, fixture.reason, [], fixture.transient ?? false);
      });
      assert.deepEqual(requests, saved ? [boundCalendarURL] : [JSON.parse(cursor).link, boundCalendarURL], fixture.name);
    }
  }

  // A safe canonical URI naming a different native calendar contradicts even
  // the independent /me body proof; neither an alias nor a profile can rescue it.
  for (const resource of contradictoryCanonicalResources) {
    for (const saved of [false, true]) {
      const requests: string[] = [];
      await assert.rejects(read(async input => {
        const url = String(input); requests.push(url);
        if (url === boundCalendarURL) return json({ id: calendar, "@odata.id": resource });
        assert.equal(saved, false);
        assert.equal(url, JSON.parse(cursor).link);
        return json({ value: [], "@odata.deltaLink": meODataTerminal });
      }, saved ? JSON.stringify({ ...JSON.parse(cursor), link: meODataTerminal }) : cursor), error => {
        assertIdentityFailure(error, "canonical-resource");
        assert.equal((error as Error & { cause: Record<string, unknown> }).cause.canonicalMetadataFailure, "calendar-key-mismatch");
        return true;
      });
      assert.deepEqual(requests, saved ? [boundCalendarURL] : [JSON.parse(cursor).link, boundCalendarURL]);
    }
  }

  // Metadata-independent /users bindings use only the exact Graph principal
  // returned by fresh /me. Both key syntaxes decode once; profile.id stays raw.
  const principalIDs = ["GraphPrincipal", "GraphPrincipal@Tenant", "Graph'Principal", "Graph/Principal+%", "Graph%2FPrincipal"];
  for (const profileID of principalIDs) {
    for (const ownerStyle of ["segment", "odata", "odata-encoded-quotes"] as const) {
      for (const keyStyle of ["segment", "odata"] as const) {
        const escapedOwner = encodeURIComponent(profileID.replace(/'/g, "''"));
        const owner = ownerStyle === "segment" ? `users/${encodeURIComponent(profileID)}`
          : `users('${ownerStyle === "odata-encoded-quotes" ? escapedOwner.replace(/'/g, "%27") : escapedOwner}')`;
        const key = keyStyle === "segment" ? "calendars/work%2fteam" : "calendars('work%2fteam')";
        const profileNext = `${base}/${owner}/${key}/calendarView/delta${opaqueQuery}`;
        const profileTerminal = `${profileNext}&terminal=true`;
        const requests: string[] = [];
        const profileRead = await read(async (input, init) => {
          const url = String(input); requests.push(url);
          assert.equal(init?.method ?? "GET", "GET");
          assert.equal(init?.redirect, "error");
          assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
          if (url === boundCalendarURL) return json({ id: calendar,
            ...(ownerStyle === "segment" ? {} : { "@odata.id": canonicalResource }) });
          if (url === principalURL) {
            assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
            assert.equal(new Headers(init?.headers).get("Cache-Control"), "no-cache");
            return json({ id: profileID, "@odata.type": "#microsoft.graph.user" });
          }
          if (url === JSON.parse(cursor).link) return json({ value: [item("before-profile")], "@odata.nextLink": profileNext });
          assert.equal(url, profileNext);
          return json({ value: [item("after-profile")], "@odata.deltaLink": profileTerminal });
        });
        assert.deepEqual(requests, [JSON.parse(cursor).link, boundCalendarURL, principalURL, profileNext]);
        assert.equal(profileRead.cursorRestarted, false);
        assert.ok(profileRead.nextCursor);
        assert.deepEqual(parseCursor(profileRead.nextCursor), { ...JSON.parse(cursor), link: profileTerminal });
        const savedRequests: string[] = [];
        const profileSaved = await read(async input => {
          const url = String(input); savedRequests.push(url);
          if (url === boundCalendarURL) return json({ id: calendar });
          if (url === principalURL) return json({ id: profileID });
          assert.equal(url, profileTerminal);
          return json({ value: [], "@odata.deltaLink": profileTerminal });
        }, profileRead.nextCursor);
        assert.deepEqual(savedRequests, [boundCalendarURL, principalURL, profileTerminal]);
        assert.equal(profileSaved.cursorRestarted, false);
        assert.deepEqual(parseCursor(profileSaved.nextCursor), parseCursor(profileRead.nextCursor));
        assert.deepEqual(profileSaved.coverage, profileRead.coverage);
      }
    }
  }

  const profileOwner = "PRIVATE-Expected-Graph-Principal";
  const profileDelta = `${base}/users('${profileOwner}')/calendars('work%2Fteam')/calendarView/delta${opaqueQuery}`;
  const profileCursor = JSON.stringify({ ...JSON.parse(cursor), link: profileDelta });
  const invalidPrincipalProofs: { name: string; reason: string; transient?: boolean; response: () => Response | Promise<Response> }[] = [
    ...[null, [], {}, { id: "" }, { id: " padded " }, { id: "." }, { id: ".." }, { id: "control\nkey" }, { id: 3 },
      { id: profileOwner, value: [] }, { id: profileOwner, "@removed": null },
      { id: profileOwner, "@odata.nextLink": null }, { id: profileOwner, "@odata.deltaLink": null },
      { id: profileOwner, "@odata.type": "#microsoft.graph.calendar" }, { id: profileOwner, "@odata.type": null }]
      .map((body, index) => ({ name: `principal-body-${index}`, reason: "principal-body", response: () => json(body) })),
    ...[202, 204, 206, 301, 302, 401, 403, 404, 408, 410, 429, 500, 503, 504, 599].map(status => ({ name: `principal-status-${status}`,
      reason: "principal-response", transient: transientIdentityStatuses.has(status),
      response: () => new Response(status === 204 ? null : JSON.stringify({ error: { message: `${proofSecret} 504 Gateway Timeout` } }),
        { status, statusText: proofSecret, headers: { "content-type": "application/json" } }) })),
    { name: "principal-partial", reason: "principal-response", response: () => json({ id: profileOwner }, 200, { "content-range": "items 0-0/1" }) },
    { name: "principal-redirect", reason: "principal-response", response: () => Object.defineProperty(json({ id: profileOwner }), "redirected", { value: true }) },
    { name: "principal-malformed-json", reason: "principal-body", response: () => new Response(`${proofSecret} is not JSON`, { status: 200 }) },
    { name: "principal-transport", reason: "principal-request", response: async () => { throw new Error(`${proofSecret} ${profileDelta}`); } },
  ];
  for (const fixture of invalidPrincipalProofs) {
    for (const saved of [false, true]) {
      const requests: string[] = [];
      await assert.rejects(read(async input => {
        const url = String(input); requests.push(url);
        if (url === boundCalendarURL) return json({ id: calendar });
        if (url === principalURL) return fixture.response();
        assert.equal(saved, false, "Failed saved-cursor principal proof must fail the read, not renew or follow");
        assert.equal(url, JSON.parse(cursor).link);
        return json({ value: [item("uncommitted-principal")], "@odata.deltaLink": profileDelta });
      }, saved ? profileCursor : cursor), error => assertIdentityFailure(error, fixture.reason, [profileOwner, profileDelta], fixture.transient ?? false));
      assert.deepEqual(requests, saved ? [boundCalendarURL, principalURL]
        : [JSON.parse(cursor).link, boundCalendarURL, principalURL], fixture.name);
    }
  }

  // A valid but different principal cannot be repaired by case folding,
  // percent-decoding profile.id, guessing tenant suffixes, OAuth sub or email.
  const mismatchedPrincipals = [
    { owner: "GraphPrincipal", profile: "graphprincipal" },
    { owner: "GraphPrincipal@ForeignTenant", profile: "GraphPrincipal" },
    { owner: "GraphPrincipal=", profile: "GraphPrincipal%3D" },
    { owner: "GraphPrincipal%2F", profile: "GraphPrincipal/" },
    { owner: "person@example.test", profile: "GraphPrincipal" },
    { owner: "OAuthSubject", profile: "GraphPrincipal" },
  ];
  for (const fixture of mismatchedPrincipals) {
    const rejectedLink = `${base}/users/${encodeURIComponent(fixture.owner)}/calendars/work%2Fteam/calendarView/delta${opaqueQuery}`;
    for (const property of ["@odata.nextLink", "@odata.deltaLink"] as const) {
      const requests: string[] = [];
      await assert.rejects(read(async input => {
        const url = String(input); requests.push(url);
        if (url === boundCalendarURL) return json({ id: calendar });
        if (url === principalURL) return json({ id: fixture.profile });
        assert.equal(url, JSON.parse(cursor).link);
        return json({ value: [item("uncommitted-mismatched-owner")], [property]: rejectedLink });
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        const cause = (error as Error & { cause: Record<string, unknown> }).cause;
        assert.equal(cause.code, "graph-delta-link-scope-invalid");
        assert.equal(cause.principalMatches, false);
        assert.equal(cause.canonicalMetadataState, "absent");
        assert.equal(cause.canonicalProofOwnerKind, "unknown");
        assert.equal(cause.canonicalOwnerMatches, null);
        assert.equal(cause.canonicalKeyStyleMatches, null);
        return true;
      });
      assert.deepEqual(requests, [JSON.parse(cursor).link, boundCalendarURL, principalURL]);
    }
    const renewedRequests: string[] = [];
    const renewed = await read(async input => {
      const url = String(input); renewedRequests.push(url);
      if (url === boundCalendarURL) return json({ id: calendar });
      if (url === principalURL) return json({ id: fixture.profile });
      assert.equal(new URL(url).pathname, new URL(view).pathname);
      assert.ok(url.includes("startDateTime"));
      return page();
    }, JSON.stringify({ ...JSON.parse(cursor), link: rejectedLink }));
    assert.equal(renewedRequests.length, 3);
    assert.deepEqual(renewedRequests.slice(0, 2), [boundCalendarURL, principalURL]);
    assert.equal(renewed.cursorRestarted, true);
  }

  const principalExpiredRequests: string[] = [];
  const principalRestart = await read(async input => {
    const url = String(input); principalExpiredRequests.push(url);
    if (url === boundCalendarURL) return json({ id: calendar });
    if (url === principalURL) return json({ id: profileOwner });
    if (url === profileDelta) return json({ error: { code: "SyncStateNotFound" } }, 410);
    assert.ok(url.includes("startDateTime"));
    return json({ value: [item("fresh-after-principal-expiry")], "@odata.deltaLink": profileDelta });
  }, profileCursor);
  assert.equal(principalExpiredRequests.length, 4);
  assert.equal(principalExpiredRequests.filter(url => url === boundCalendarURL).length, 1);
  assert.equal(principalExpiredRequests.filter(url => url === principalURL).length, 1);
  assert.equal(principalRestart.cursorRestarted, true);

  // A failed later proof cannot turn earlier buffered pages into a checkpoint.
  const failedLaterRequests: string[] = [];
  await assert.rejects(read(async input => {
    const url = String(input); failedLaterRequests.push(url);
    if (url === boundCalendarURL) return json({ id: "other", "@odata.id": canonicalResource });
    if (url === JSON.parse(cursor).link) return json({ value: [item("buffered-first-page")], "@odata.nextLink": `${view}?page=2` });
    assert.equal(url, `${view}?page=2`);
    return json({ value: [item("buffered-second-page")], "@odata.deltaLink": canonicalDelta });
  }), /delta link/);
  assert.deepEqual(failedLaterRequests, [JSON.parse(cursor).link, `${view}?page=2`, boundCalendarURL]);

  // Proof is invocation-local and remains single-use across a 410 restart.
  const canonicalExpiredRequests: string[] = [];
  const canonicalRestart = await read(async input => {
    const url = String(input); canonicalExpiredRequests.push(url);
    if (url === boundCalendarURL) return canonicalProof();
    if (url === canonicalDelta) return json({ error: { code: "SyncStateNotFound" } }, 410);
    assert.ok(url.includes("startDateTime"));
    return json({ value: [item("fresh-after-canonical-expiry")], "@odata.deltaLink": canonicalDelta });
  }, canonicalCursor);
  assert.equal(canonicalExpiredRequests.length, 3);
  assert.equal(canonicalExpiredRequests.filter(url => url === boundCalendarURL).length, 1);
  assert.equal(canonicalRestart.cursorRestarted, true);
  assert.equal(canonicalRestart.changes[0]?.kind, "event");
  const canonicalCycleRequests: string[] = [];
  await assert.rejects(read(async input => {
    const url = String(input); canonicalCycleRequests.push(url);
    if (url === boundCalendarURL) return canonicalProof();
    assert.equal(url, canonicalDelta);
    return json({ value: [], "@odata.nextLink": canonicalDelta });
  }, canonicalCursor), /cyclic/);
  assert.deepEqual(canonicalCycleRequests, [boundCalendarURL, canonicalDelta]);

  // Resource identity proof is independent of private-event deletion authority.
  const canonicalAbsenceRequests: string[] = [];
  const canonicalAbsence = await read(async input => {
    const url = String(input); canonicalAbsenceRequests.push(url);
    if (url === boundCalendarURL) return canonicalProof();
    assert.equal(url, JSON.parse(cursor).link);
    return json({ value: [removed()], "@odata.deltaLink": canonicalDelta });
  }, cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: false });
  assert.deepEqual(canonicalAbsenceRequests, [JSON.parse(cursor).link, boundCalendarURL]);
  assert.deepEqual(canonicalAbsence.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal" }]);
  const privateAuthorityRequests: string[] = [];
  await assert.rejects(read(async input => {
    const url = String(input); privateAuthorityRequests.push(url);
    if (url === boundCalendarURL) return canonicalProof();
    if (url === `${eventPath}native`) return missing();
    if (url === `${boundCalendarURL}?$select=id,canViewPrivateItems`) return json({ id: calendar, canViewPrivateItems: false });
    assert.equal(url, JSON.parse(cursor).link);
    return json({ value: [removed()], "@odata.deltaLink": canonicalDelta });
  }, cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));
  assert.deepEqual(privateAuthorityRequests, [JSON.parse(cursor).link, boundCalendarURL,
    `${eventPath}native`, `${boundCalendarURL}?$select=id,canViewPrivateItems`]);

  // Exact start and end survive each delta round; old/unknown cursors renew
  // without interpreting missing entries as complete collection inventory.
  const incremental = await read(async () => page([item()]));
  assert.deepEqual(incremental.coverage, { kind: "window", fromInclusive: new Date(now - 180 * day).toISOString(),
    untilExclusive: new Date(now + 730 * day).toISOString(), complete: true });
  assert.equal(incremental.reset, false);
  assert.equal(incremental.cursorRestarted, false);
  assert.equal(parseCursor(incremental.nextCursor)?.windowStart, now - 180 * day);
  const zeroDuration = item("zero");
  zeroDuration.end = { ...zeroDuration.start };
  const equalEndpoints = await read(async () => page([zeroDuration]));
  assert.equal(equalEndpoints.changes[0]?.kind, "event", "Existing zero-duration timed events remain readable");
  await assert.rejects(read(async () => page([{ ...zeroDuration, isAllDay: true }])),
    "An exclusive all-day interval must still have positive length");
  for (const previous of [null, "https://old/delta", JSON.stringify({ link: `${view}?token=old`, windowEnd: now + 730 * day }),
    JSON.stringify({ ...JSON.parse(cursor), version: 3 }),
    JSON.stringify({ ...JSON.parse(cursor), calendarId: "different" }),
    JSON.stringify({ ...JSON.parse(cursor), windowEnd: now + 80 * day }),
    JSON.stringify({ ...JSON.parse(cursor), link: "https://foreign.example/steal" })]) {
    const urls: string[] = [];
    const snapshot = await read(async input => { urls.push(String(input)); return page(); }, previous as string);
    assert.equal(snapshot.reset, false);
    assert.equal(snapshot.cursorRestarted, true);
    assert.equal(snapshot.coverage?.kind, "window");
    assert.deepEqual(snapshot.changes, []);
    const requested = new URL(urls[0]!);
    assert.equal(requested.pathname, new URL(view).pathname);
    assert.equal(requested.searchParams.get("startDateTime"), new Date(now - 180 * day).toISOString());
    assert.equal(requested.searchParams.get("endDateTime"), new Date(now + 730 * day).toISOString());
  }

  // An expired token on page 2 discards page 1. The new bounded snapshot
  // reports coverage only, never the obsolete window's missing inventory.
  const expiredRequests: string[] = [];
  const restarted = await read(async input => {
    const url = String(input); expiredRequests.push(url);
    if (url.includes("startDateTime")) return page([item("fresh")]);
    if (url.includes("page=2")) return json({ error: { code: "SyncStateNotFound" } }, 410);
    return json({ value: [item("obsolete")], "@odata.nextLink": `${view}?page=2` });
  });
  assert.equal(expiredRequests.length, 3);
  assert.equal(restarted.reset, false);
  assert.equal(restarted.cursorRestarted, true);
  assert.deepEqual(restarted.changes.map(change => change.kind === "event" && change.data.externalId), ["fresh"]);
  assert.equal(restarted.coverage?.kind, "window");

  // No plausible-looking partial or wrong-scope page can certify a checkpoint.
  const malformed = [
    json({}), json({ "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [], "@odata.nextLink": `${view}?page=2`, "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [] }), json({ value: [], "@odata.deltaLink": null }),
    json({ value: [item("")], "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [item("native", { start: { dateTime: "2026-02-30T09:00:00", timeZone: "UTC" } })], "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [], "@odata.deltaLink": "https://foreign.example/steal" }),
    json({ value: [], "@odata.deltaLink": `${base}/me/calendars/another/calendarView/delta?token=next` }),
    json({ value: [], "@odata.deltaLink": `${view}?token=next#fragment` }),
    json({ value: [], "@odata.deltaLink": `${view}?token=next` }, 206),
    json({ value: [], "@odata.deltaLink": `${view}?token=next` }, 200, { "content-range": "items 0-1/10" }),
  ];
  for (const response of malformed) await assert.rejects(read(async () => response));
  await assert.rejects(read(async () => json({ value: [], "@odata.nextLink": `${view}?token=previous` })), /cyclic/);
  let excessivePages = 0;
  await assert.rejects(read(async () => json({ value: [], "@odata.nextLink": `${view}?page=${++excessivePages}` })), /excessive/);
  assert.equal(excessivePages, 1000);
  let pages = 0;
  await assert.rejects(read(async () => ++pages === 1
    ? json({ value: [item()], "@odata.nextLink": `${view}?page=2` })
    : json({ error: { code: "ServiceUnavailable" } }, 503)));
  assert.equal(pages, 2);

  // A native change outside the delta window is returned as @removed by Graph.
  // Its full scoped GET wins; no tombstone is manufactured from the delta.
  const moved = item("native", { start: { dateTime: "2030-11-01T09:00:00", timeZone: "UTC" },
    end: { dateTime: "2030-11-01T10:00:00", timeZone: "UTC" }, subject: "Moved outside window" });
  const movedRequests: string[] = [];
  const outside = await read(async (input, init) => {
    const url = String(input); movedRequests.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, undefined);
    return url.startsWith(eventPath) ? json(moved) : page([removed()]);
  }, cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true });
  assert.equal(movedRequests.length, 2);
  assert.equal(outside.changes[0]?.kind, "event");
  if (outside.changes[0]?.kind === "event") {
    assert.equal(outside.changes[0].data.status, "active");
    assert.equal(outside.changes[0].data.title, "Moved outside window");
  }
  const definition = await read(async input => String(input).startsWith(eventPath)
    ? json(item("native", { type: "seriesMaster", recurrence: { pattern: { type: "daily" } } })) : page([removed()]),
  cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true });
  assert.deepEqual(definition.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal" }],
    "A full master definition cannot be flattened into one imported instance");

  // Unknown addresses and uncertain/private-redacted authority remain plain
  // absence observations. They cannot poison future create recovery tombstones.
  for (const options of [{ knownEventIDs: [] , microsoftReadAuthorityVerified: true },
    { knownEventIDs: ["native"], microsoftReadAuthorityVerified: false }]) {
    let count = 0;
    const unknown = await read(async () => { count++; return page([removed()]); }, cursor, options);
    assert.equal(count, 1);
    assert.deepEqual(unknown.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal" }]);
  }

  // A real deletion in the fake provider produces two exact native 404 reads
  // bracketing the readable calendar. Delta alone is still insufficient.
  let nativePresent = true;
  const proofRequests: string[] = [];
  const fakeProvider: typeof fetch = async (input, init) => {
    const url = String(input); proofRequests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "DELETE") { nativePresent = false; return new Response(null, { status: 204 }); }
    if (url === `${eventPath}native`) return nativePresent ? json(item()) : missing();
    if (url.includes("?$select=id,canViewPrivateItems")) return json({ id: calendar, canViewPrivateItems: true });
    return page([removed()]);
  };
  await fakeProvider(`${eventPath}native`, { method: "DELETE" });
  const deleted = await read(fakeProvider, cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true });
  assert.deepEqual(deleted.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal",
    deletionEvidence: { kind: "scoped-native-absence", responseStatus: 404, readAuthorityVerified: true,
      nativeReadProfile: "graph-event-double-404-calendar-v1" } }]);
  assert.deepEqual(proofRequests.slice(2), [`GET ${eventPath}native`,
    `GET ${base}/me/calendars/work%2Fteam?$select=id,canViewPrivateItems`, `GET ${eventPath}native`]);

  for (const bad of [json({ error: { code: "ErrorAccessDenied" } }, 403),
    json({ error: { code: "TooManyRequests" } }, 429), json({ error: { code: "ServiceUnavailable" } }, 503),
    json({ error: { code: "ErrorItemNotFound" } }, 410), json({ error: { code: "ErrorAccessDenied" } }, 404),
    json({}, 404), json({ error: { code: "ErrorItemNotFound" } }, 404, { "content-range": "bytes 0-5/100" }),
    json({ ...item(), id: "wrong" }), json({ id: "native" })]) {
    await assert.rejects(read(async input => String(input).startsWith(eventPath) ? bad : page([removed()]),
      cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));
  }
  // Captured DB authority can become stale while provider reads are in flight.
  // Native private-item access must still be explicit at the bracketing read.
  for (const badCalendar of [json({ id: "wrong", canViewPrivateItems: true }),
    json({ error: { code: "ErrorAccessDenied" } }, 403),
    json({ id: calendar, canViewPrivateItems: true, "@odata.nextLink": `${view}?page=2` }),
    json({ id: calendar, canViewPrivateItems: false }), json({ id: calendar }),
    json({ id: calendar, canViewPrivateItems: null })]) {
    await assert.rejects(read(async input => String(input).startsWith(eventPath) ? missing()
      : String(input).includes("?$select=id,canViewPrivateItems") ? badCalendar : page([removed()]), cursor,
    { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));
  }
  let nativeReads = 0;
  await assert.rejects(read(async input => String(input).startsWith(eventPath)
    ? (++nativeReads === 1 ? missing() : json(item()))
    : String(input).includes("?$select=id,canViewPrivateItems") ? json({ id: calendar, canViewPrivateItems: true }) : page([removed()]), cursor,
  { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));

  // A moved exception retains its original slot, which differs from its current
  // start. Master hydration never substitutes the master's conditional version.
  const exception = item("exception", { ...moved, id: "exception", type: "exception", seriesMasterId: "master",
    originalStart: "2026-11-01T09:00:00.0000000Z" });
  const hydrated = await read(async input => {
    const url = String(input);
    if (url.includes(`${eventPath}master`)) return json(item("master", { type: "seriesMaster", "@odata.etag": 'W/"master"' }));
    if (url.includes(`${eventPath}exception`)) return json(exception);
    return page([removed("exception")]);
  }, cursor, { knownEventIDs: ["exception"], microsoftReadAuthorityVerified: true });
  assert.equal(hydrated.changes[0]?.kind, "event");
  if (hydrated.changes[0]?.kind === "event") {
    assert.deepEqual(hydrated.changes[0].data.providerOccurrence, { externalSeriesID: "master",
      originalStart: { kind: "instant", value: "2026-11-01T09:00:00.000Z" } });
    assert.equal(hydrated.changes[0].data.start.toISOString(), "2030-11-01T09:00:00.000Z");
    assert.equal(hydrated.changes[0].data.etag, null);
  }
  await assert.rejects(read(async input => {
    const url = String(input);
    if (url.includes(`${eventPath}master`)) return json(item("master", { type: "seriesMaster" }));
    if (url.includes(`${eventPath}exception`)) return json({ ...exception, originalStart: "2026-02-30T09:00:00Z" });
    return page([removed("exception")]);
  }, cursor, { knownEventIDs: ["exception"], microsoftReadAuthorityVerified: true }),
  "Invalid calendar dates must never roll into a fabricated original slot");

  // Full-family exclusions happen before ambiguous removal/dependency reads.
  let exclusionCalls = 0;
  const excluded = await read(async () => { exclusionCalls++; return page([removed("tracked"),
    item("tracked-slot", { seriesMasterId: "tracked-master" })]); }, cursor,
  { knownEventIDs: ["tracked"], microsoftReadAuthorityVerified: true,
    excludedEventIDs: ["tracked"], excludedSeriesIDs: ["tracked-master"] });
  assert.deepEqual(excluded.changes, []);
  assert.equal(exclusionCalls, 1);
  console.log("microsoft read coverage self-check: OK");
}

main().catch(error => { console.error(error); process.exit(1); });
