import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventSchema } from "@musubi/types";
import { resolveEventTimeEdit } from "@musubi/calendar";
import { graphSeriesFamilyEvidence, readGraphSeriesFamily, readGraphSeriesFamilyOrMissing } from "./microsoft_series_family";
import { graphInstanceTimeFromUtc, graphOriginalStartFromUtc } from "./microsoft_time";

const template = EventSchema.parse({ id: "00000000-0000-4000-8000-000000000181", revision: 1, creatorID: "owner", organizer: "", title: "Series", color: "red", calendars: [], isCanceled: false, recurrence: "RRULE:FREQ=DAILY;COUNT=4", ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-27T09:00:00", endLocal: "2026-03-27T10:00:00" }) });
const master: any = { id: "series/id", iCalUId: "master-uid", "@odata.etag": 'W/"master"', type: "seriesMaster", isAllDay: false, isCancelled: false, originalStartTimeZone: "Europe/Prague", originalEndTimeZone: "Europe/Prague", start: { dateTime: "2026-03-27T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-03-27T09:00:00.0000000", timeZone: "UTC" }, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", startDate: "2026-03-27", numberOfOccurrences: 4, recurrenceTimeZone: "Europe/Prague" } }, subject: "Series", body: { contentType: "text", content: "Notes" }, location: { displayName: "Office" }, attendees: [], isOrganizer: true, organizer: { emailAddress: { address: "owner@example.test" } }, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, cancelledOccurrences: [], exceptionOccurrences: [], isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: "busy", sensitivity: "normal", responseStatus: { response: "organizer" } };
const occurrence = (day: number, hour: number): any => ({ ...master, id: `occ-${day}`, iCalUId: `uid-${day}`, "@odata.etag": `W/"${day}"`, type: "occurrence", seriesMasterId: master.id, originalStart: `2026-03-${day}T0${hour}:00:00.0000000Z`, recurrence: null, start: { dateTime: `2026-03-${day}T0${hour}:00:00.0000000`, timeZone: "UTC" }, end: { dateTime: `2026-03-${day}T0${hour + 1}:00:00.0000000`, timeZone: "UTC" } });
const ordinary = [occurrence(27, 8), occurrence(28, 8), occurrence(29, 7), occurrence(30, 7)];
const moved = { ...ordinary[2], type: "exception", subject: "Moved", start: { dateTime: "2027-05-01T12:00:00", timeZone: "UTC" }, end: { dateTime: "2027-05-01T13:00:00", timeZone: "UTC" }, originalStartTimeZone: "Central Europe Standard Time", originalEndTimeZone: "Central Europe Standard Time", isReminderOn: false, sensitivity: "private" };
const changed = { ...master, exceptionOccurrences: [moved], cancelledOccurrences: ["opaque-not-a-date"] };
const listed = [ordinary[0], ordinary[3]];
const ref = { externalEventId: master.id, icalUid: master.iCalUId };
const evidence = (native = changed, values = listed) => graphSeriesFamilyEvidence(native, values, template, ref);
const before = JSON.stringify({ changed, listed, template });
const proof = evidence();
const untilChanged = { ...changed, recurrence: { pattern: master.recurrence.pattern, range: { type: "endDate", startDate: "2026-03-27", endDate: "2026-03-30", recurrenceTimeZone: "Europe/Prague" } } };
const untilProof = evidence(untilChanged);
assert.deepEqual(untilProof.instances, proof.instances);
assert.deepEqual(untilProof.cancelled, proof.cancelled);
assert.equal(untilProof.master.recurrence, "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20260330T070000Z");
assert.throws(() => evidence(untilChanged, listed.slice(0, 1)));
assert.throws(() => evidence({ ...untilChanged, recurrence: { ...untilChanged.recurrence, range: { ...untilChanged.recurrence.range, endDate: "2026-03-31" } } }));
assert.equal(evidence({ ...changed, transactionId: "00000000-0000-4000-8000-000000000190" }).master.creationOperationID, "00000000-0000-4000-8000-000000000190");
assert.deepEqual(proof.instances.map(value => value.externalId), ["occ-27", "occ-29", "occ-30"]);
assert.deepEqual(proof.instances.map(value => value.icalUid), ["uid-27", "uid-29", "uid-30"]);
assert.equal(proof.instances[1]!.start.toISOString(), "2027-05-01T12:00:00.000Z");
assert.deepEqual(proof.instances[1]!.timeModel, { kind: "legacy-unknown" });
assert.equal(proof.instances[1]!.providerState?.privacy, "private");
assert.deepEqual(proof.instances[1]!.providerState?.reminders, { provider: "microsoft", isOn: false, minutesBeforeStart: 15 });
assert.deepEqual(proof.cancelled.map(value => value.originalStart), [{ kind: "instant", value: "2026-03-28T08:00:00.000Z" }]);
assert.deepEqual(proof.cancelledOccurrenceIDs, ["opaque-not-a-date"]);
assert.equal(JSON.stringify({ changed, listed, template }), before);
assert.equal(evidence(master, ordinary).instances.length, 4);
const aliasMaster = structuredClone(master); aliasMaster.recurrence.range.recurrenceTimeZone = "Central Europe Standard Time";
const aliasBefore = structuredClone(aliasMaster);
assert.deepEqual(evidence(aliasMaster, ordinary), evidence(master, ordinary));
assert.deepEqual(aliasMaster, aliasBefore);
assert.throws(() => evidence(aliasMaster, ordinary.slice(0, 3)));
assert.throws(() => evidence(aliasMaster, [...ordinary, ordinary[0]]));
assert.throws(() => evidence(aliasMaster, ordinary.map((item, i) => i === 2 ? { ...item, start: { ...item.start, dateTime: "2026-03-29T08:00:00" } } : item)));
assert.throws(() => graphSeriesFamilyEvidence(aliasMaster, ordinary, { ...template, timeModel: null }, ref));
assert.deepEqual(evidence(changed, [...listed, moved]), proof);
assert.deepEqual(evidence(changed, [...listed].reverse()), proof);
const allCancelled = evidence({ ...master, cancelledOccurrences: ["opaque1", "opaque2", "opaque3", "opaque4"] }, []);
assert.equal(allCancelled.cancelled.length, 4);
for (const native of [
  { ...changed, cancelledOccurrences: [] }, { ...changed, cancelledOccurrences: undefined }, { ...changed, cancelledOccurrences: ["dup", "dup"] },
  { ...changed, exceptionOccurrences: undefined }, { ...changed, exceptionOccurrences: [moved, moved] },
  { ...changed, "exceptionOccurrences@odata.nextLink": "https://graph.microsoft.com/more" }, { ...changed, "exceptionOccurrences@odata.count": 2 },
  { ...changed, "cancelledOccurrences@odata.count": 0 }, { ...changed, id: "wrong" }, { ...changed, iCalUId: "wrong" },
  { ...changed, "@removed": {} }, { ...changed, attendees: undefined }, { ...changed, "attendees@odata.count": 1 },
  { ...changed, "attendees@odata.nextLink": "https://graph.microsoft.com/more" }, { ...changed, body: { contentType: "html", content: "Notes" } },
  { ...changed, recurrence: { ...master.recurrence, range: { ...master.recurrence.range, type: "noEnd", numberOfOccurrences: undefined } } },
]) assert.throws(() => evidence(native));
for (const values of [
  [], [listed[0]], [...listed, listed[0]], [...listed, { ...moved, subject: "Changed concurrently" }],
  [...listed, { ...moved, id: "unknown-exception" }], [...listed, ordinary[2]],
  [{ ...listed[0], seriesMasterId: "other" }, listed[1]], [{ ...listed[0], originalStart: "2026-04-01T08:00:00Z" }, listed[1]],
  [{ ...listed[0], subject: "Unmarked exception" }, listed[1]], [{ ...listed[0], recurrence: master.recurrence }, listed[1]],
  [{ ...listed[0], start: { ...listed[0].start, dateTime: "2026-03-27T08:15:00" } }, listed[1]],
  [{ ...listed[0], isCancelled: true }, listed[1]], [{ ...listed[0], "@removed": {} }, listed[1]],
]) assert.throws(() => evidence(changed, values));
// A meeting read retains native attendance; it is not a personal-create writer.
const meeting = { ...master, isOrganizer: false, attendees: [{ emailAddress: { address: "guest@example.test", name: "Guest" }, type: "required", status: { response: "accepted" } }], responseStatus: { response: "tentativelyAccepted" }, onlineMeeting: { joinUrl: "https://meeting.test/join" }, isOnlineMeeting: true };
assert.equal(evidence(meeting, ordinary).master.providerState?.ownResponse, "tentativelyAccepted");
assert.equal(evidence(meeting, ordinary).master.url, "https://meeting.test/join");
// Exact UTC exception instants survive both sides of a DST fold, without a
// fabricated current zone derived from historical original*TimeZone labels.
const expected = { ...template, originalStart: { kind: "instant" as const, value: template.start.toISOString() } };
for (const start of ["2026-10-25T00:30:00", "2026-10-25T01:30:00"]) {
  const time = graphInstanceTimeFromUtc({ ...ordinary[0], type: "exception", start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: "2026-10-25T03:00:00", timeZone: "UTC" } }, master.id, expected);
  assert.equal(time.start.toISOString(), `${start}.000Z`); assert.deepEqual(time.timeModel, { kind: "legacy-unknown" });
}
assert.deepEqual(graphOriginalStartFromUtc("2026-12-31T00:00:00.0000000Z", true), { kind: "date", value: "2026-12-31" });
for (const value of ["2026-03-27T08:00:00.0000001Z", "2026-03-27T08:00:00+00:00", "2026-02-30T00:00:00Z", null]) assert.throws(() => graphOriginalStartFromUtc(value, false));
assert.throws(() => graphOriginalStartFromUtc("2026-12-31T01:00:00Z", true));
const dayTemplate = { ...template, recurrence: "RRULE:FREQ=DAILY;COUNT=1", ...resolveEventTimeEdit({ kind: "all-day", startDate: "2026-12-31", endDate: "2027-01-01" }) };
const dayMaster = { ...master, isAllDay: true, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", start: { dateTime: "2026-12-31T00:00:00", timeZone: "UTC" }, end: { dateTime: "2027-01-02T00:00:00", timeZone: "UTC" }, recurrence: { ...master.recurrence, range: { type: "numbered", startDate: "2026-12-31", numberOfOccurrences: 1 } } };
const dayInstance = { ...dayMaster, id: "day-instance", iCalUId: "day-uid", type: "occurrence", seriesMasterId: master.id, originalStart: "2026-12-31T00:00:00Z", recurrence: null };
assert.equal(graphSeriesFamilyEvidence(dayMaster, [dayInstance], dayTemplate, ref).instances[0]!.end.toISOString(), "2027-01-01T00:00:00.000Z");
for (const change of [{ isAllDay: false }, { originalStart: "2026-12-31T01:00:00Z" }, { end: dayInstance.start }, { start: { ...dayInstance.start, timeZone: "Europe/Prague" } }]) assert.throws(() => graphSeriesFamilyEvidence(dayMaster, [{ ...dayInstance, ...change }], dayTemplate, ref));

async function main() {
  let mode = "normal", reads: string[] = [], masterReads = 0;
  const path = "/v1.0/me/calendars/cal%2Fone/events/series%2Fid";
  const next = `https://graph.microsoft.com${path}/instances?$skiptoken=next`;
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, "Bearer synthetic-token");
    assert.equal(req.headers["if-match"], undefined); assert.equal(req.headers["cache-control"], "no-cache");
    assert.match(String(req.headers.prefer), /outlook.timezone="UTC"/); assert.match(String(req.headers.prefer), /outlook.body-content-type="text"/);
    const url = new URL(req.url!, "http://fixture.test"); reads.push(url.pathname + url.search);
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (mode.startsWith("missing")) {
      const error = { error: { code: "ErrorItemNotFound" } };
      if (url.pathname === "/v1.0/me/calendars/cal%2Fone") {
        assert.equal(url.searchParams.get("$select"), "id,canViewPrivateItems");
        if (mode === "missing-calendar-denied") return send(error, 403);
        if (mode === "missing-calendar-gone") return send(error, 404);
        if (mode === "missing-calendar-failed") return send(error, 503);
        if (mode === "missing-calendar-partial") res.setHeader("Content-Range", "bytes 0-10/100");
        return send({ id: mode === "missing-wrong-calendar" ? "other" : "cal/one",
          ...(mode === "missing-calendar-private-unknown" ? {} : {
            canViewPrivateItems: mode === "missing-calendar-private-lost" ? false
              : mode === "missing-calendar-private-null" ? null : true,
          }),
        });
      }
      assert.equal(url.pathname, path); masterReads++;
      if (mode === "missing-restored" && masterReads === 2) return send(changed);
      if (mode === "missing-partial") res.setHeader("Content-Range", "bytes 0-10/100");
      if (mode === "missing-truncated") { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":'); return; }
      return send(mode === "missing-malformed" ? {}
        : mode === "missing-masked-404" ? { error: { code: "ErrorAccessDenied" } } : error, 404);
    }
    if (mode === "partial") { res.setHeader("Content-Range", "bytes 0-10/100"); return send(changed); }
    if (mode === "redirect") { res.writeHead(302, { location: "https://other.test/leak" }); res.end(); return; }
    if (mode === "network") { req.socket.destroy(); return; }
    if (url.pathname === path) {
      assert.equal(url.searchParams.get("$expand"), "exceptionOccurrences");
      assert.ok(url.searchParams.get("$select")?.includes("cancelledOccurrences"));
      assert.ok(url.searchParams.get("$select")?.includes("transactionId"));
      masterReads++;
      if (masterReads === 2 && mode === "changed-transaction") return send({ ...changed, transactionId: "another-operation" });
      if (masterReads === 2 && mode === "changed-exception") return send({ ...changed, exceptionOccurrences: [{ ...moved, subject: "Concurrent" }] });
      if (masterReads === 2 && mode === "changed-cancel") return send({ ...changed, cancelledOccurrences: ["different-opaque"] });
      if (masterReads === 2 && mode === "changed-rule") return send({ ...changed, recurrence: { ...master.recurrence, range: { ...master.recurrence.range, numberOfOccurrences: 5 } } });
      if (masterReads === 2 && mode === "master-failure") return send({}, 503);
      if (mode.startsWith("until")) return send(masterReads === 2 && mode === "until-changed" ? { ...untilChanged, recurrence: { ...untilChanged.recurrence, range: { ...untilChanged.recurrence.range, endDate: "2026-03-31" } } } : untilChanged);
      return send(changed);
    }
    assert.equal(url.pathname, `${path}/instances`);
    if (url.searchParams.has("$skiptoken")) {
      if (mode === "page-failure") return send({}, 503);
      if (mode === "duplicate") return send({ value: [listed[0]] });
      return send({ value: [listed[1]], ...(mode === "wrong-count" ? { "@odata.count": 3 } : {}) });
    }
    assert.equal(url.searchParams.get("startDateTime"), "2026-03-27T08:00:00.000Z");
    assert.equal(url.searchParams.get("endDateTime"), "2026-03-30T08:00:00.000Z");
    assert.ok(url.searchParams.get("$select")?.includes("originalStart"));
    if (mode === "malformed") return send({ value: null });
    const link = mode === "foreign" ? "https://other.test/leak" : mode === "wrong-calendar" ? next.replace("cal%2Fone", "other") : mode === "wrong-master" ? next.replace("series%2Fid", "other") : mode === "loop" ? `https://graph.microsoft.com${req.url}` : next;
    return send({ value: [listed[0]], "@odata.nextLink": link });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com"); assert.equal(init?.redirect, "error");
    return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  };
  const read = () => readGraphSeriesFamily("synthetic-token", "cal/one", template, ref);
  try {
    mode = "until"; assert.deepEqual(await read(), untilProof);
    mode = "until-changed"; masterReads = 0; await assert.rejects(read);
    mode = "normal"; reads = []; masterReads = 0;
    assert.deepEqual(await read(), proof); assert.equal(reads.length, 4); assert.equal(masterReads, 2);
    for (const scenario of ["partial", "redirect", "network", "foreign", "wrong-calendar", "wrong-master", "loop", "malformed", "page-failure", "duplicate", "wrong-count", "changed-exception", "changed-transaction", "changed-cancel", "changed-rule", "master-failure"]) {
      mode = scenario; reads = []; masterReads = 0; await assert.rejects(read); assert.ok(reads.length <= 4);
    }
    mode = "missing"; reads = []; masterReads = 0;
    await assert.rejects(read, "Create ACK always requires an active complete family");
    reads = []; masterReads = 0;
    assert.equal(await readGraphSeriesFamilyOrMissing("synthetic-token", "cal/one", template, ref), null);
    assert.equal(masterReads, 2); assert.equal(reads.length, 3);
    for (const scenario of ["missing-calendar-denied", "missing-calendar-gone", "missing-calendar-failed", "missing-calendar-partial", "missing-wrong-calendar", "missing-restored", "missing-partial", "missing-truncated", "missing-malformed", "missing-masked-404", "missing-calendar-private-lost", "missing-calendar-private-unknown", "missing-calendar-private-null", "master-failure", "page-failure"]) {
      mode = scenario; reads = []; masterReads = 0;
      await assert.rejects(() => readGraphSeriesFamilyOrMissing("synthetic-token", "cal/one", template, ref));
    }
    mode = "normal"; reads = []; masterReads = 0;
    const mutable = structuredClone(template), mutableRef = { ...ref };
    const pending = readGraphSeriesFamily("synthetic-token", "cal/one", mutable, mutableRef);
    mutable.seriesID = template.id; mutableRef.icalUid = "changed";
    assert.deepEqual(await pending, proof);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => readGraphSeriesFamily("synthetic-token", "cal/one", template, ref, controller.signal));
    for (const invalid of [".", "..", "", " cal"]) await assert.rejects(() => readGraphSeriesFamily("synthetic-token", invalid, template, ref));
    console.log("Graph finite family: complete scoped pages, moved exceptions, exact original identities, native UID preservation, explicit cancellation cardinality, UTC unknown exception zones, changed second observations and incomplete/foreign refusal: OK");
  } finally { globalThis.fetch = realFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
