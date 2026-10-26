import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EVENT_COMPATIBILITY_FIXTURES, eventCompatibilityFamily, eventCompatibilityFixtureSource, eventCompatibilityDataHash, eventCompatibilityNormalizedWitnessInput, eventCompatibilityGeneratedClockResource, type EventCompatibilitySerializerClock } from "./event_compatibility_fixture_manifest";
import { normalizeEventCompatibilityReceipt } from "./event_compatibility_delivery.integration.test";

async function main() {
  for (const fixture of EVENT_COMPATIBILITY_FIXTURES) {
    const path = new URL(`./${fixture.source}`, import.meta.url), source = await readFile(path, "utf8"), adapted = eventCompatibilityFixtureSource(source, fileURLToPath(path));
    assert(adapted.includes("export const eventCompatibilityFixtureDone ="));
    assert.equal((adapted.match(/assert\./g) ?? []).length, (source.match(/assert\./g) ?? []).length, `${fixture.id}: independent assertions must remain intact`);
    const functionStart = source.indexOf("async function");
    assert(functionStart >= 0 || fixture.id === "graph-rsvp");
  }
  const rootManifest = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  const retained = Object.values(rootManifest.scripts).join("\n");
  for (const fixture of EVENT_COMPATIBILITY_FIXTURES.filter(value => value.retainedGate !== false)) assert(retained.includes(fixture.source), `${fixture.id}: default DB inventory must retain its original fixture gate`);
  const specialized = new Set(EVENT_COMPATIBILITY_FIXTURES.flatMap(fixture => fixture.families.map(family => family.split(":")[0])).filter(family => family !== "generic"));
  assert.equal(specialized.size, 13, "Every actual specialized discriminant must have a retained native fixture gate");
  assert.throws(() => eventCompatibilityFixtureSource("finishUnknown();", "unknown.ts"), /unknown fixture/);
  assert.equal(eventCompatibilityFamily({ provider: "microsoft", payload: { organizer: {}, graphOccurrenceContent: {}, rsvp: {} } }), "graphOccurrenceContent");
  assert.equal(eventCompatibilityFamily({ provider: "google", payload: { rsvp: {} } }), "rsvp:google");
  const receipt = { schemaVersion: 1 as const, label: "new" as const, sourceSha256: "source", records: [{ id: "unchanged-id", family: "caldavSeries", before: null, returned: null, after: null,
    state: { events: [{ id: "unchanged-event", start: "2026-10-26T10:11:12.123Z", end: "2026-10-26T11:12:13.456Z", updated_at: "2026-10-26T12:00:00Z", original_start: { kind: "instant", value: "2026-10-26T10:11:12.123Z" }, native_etag: '"exact"' }] }, wireStart: 0, wireEnd: 1 }],
    wire: [{ url: "http://127.0.0.1:12345/dav/whole.ics", method: "PUT", headers: { "if-match": '"exact"', authorization: "Basic fixture" }, body: "BEGIN:VCALENDAR\r\nDTSTAMP:20261026T120000Z\r\nDTSTART:20261026T101112Z\r\nX-PRIVATE:exact\r\nEND:VCALENDAR\r\n", redirect: "error", status: 204, responseHeaders: { etag: '"result"', date: "volatile transport date" } }],
    origins: [{ origin: "http://127.0.0.1:12345", alias: "<owned-fixture-origin:1>" }], ownedPoolsClosed: 1, passed: true };
  const normalized = normalizeEventCompatibilityReceipt(receipt);
  const serialized = JSON.stringify(normalized);
  assert(serialized.includes("2026-10-26T10:11:12.123Z")); assert(serialized.includes("2026-10-26T11:12:13.456Z"));
  assert(serialized.includes("unchanged-event")); assert(serialized.includes("unchanged-id")); assert(serialized.includes("X-PRIVATE:exact"));
  assert(serialized.includes("DTSTART:20261026T101112Z")); assert(serialized.includes("if-match")); assert(serialized.includes("Basic fixture"));
  assert(serialized.includes("<host-metadata>")); assert(serialized.includes("DTSTAMP:20261026T120000Z"), "A calendar wrapper alone grants no serializer clock provenance");
  assert(!serialized.includes("volatile transport date"));
  assert.equal(receipt.wire[0]!.body.includes("DTSTAMP:20261026T120000Z"), true, "Raw native bytes must remain available unchanged");
  const first = receipt.records[0]!;
  const cohort = { id: 7, count: 2, after: { status: "completed" }, state: first.state };
  const race = { ...receipt, records: [{ ...first, returned: { status: "pending" }, cohort }, { ...first, returned: { status: "completed" }, cohort }] };
  const otherTiming = { ...receipt, records: [{ ...first, returned: { status: "attempting" }, cohort }, { ...first, returned: { status: "completed" }, cohort }] };
  assert.deepEqual(normalizeEventCompatibilityReceipt(race), normalizeEventCompatibilityReceipt(otherTiming), "Concurrent locked-claim observations compare their whole native ledger and exact settled durable state");
  assert.notDeepEqual(race.records, otherTiming.records, "The raw timing observations stay present without normalization");
  assert.throws(() => normalizeEventCompatibilityReceipt({ ...race, records: [race.records[0]!] }), /strictly equal/, "A missing concurrent observation cannot disappear from parity");
  const native = { updatedAt: "native-clock-1", createdAt: "native-created", deletedAt: "native-deleted", startedAt: "native-started", acceptedAt: "native-accepted", label: "native-label", sourceSha256: "native-source", ownedPoolsClosed: "native-private", unknown: { updatedAt: "nested-native-clock" }, body: "Notes\r\nDTSTAMP:20261026T120000Z", etag: '"native-tag"', slot: "2026-10-26T10:11:12.123Z", actorID: "actor-one", source: "source-one", permission: { canEdit: true, owner: "actor-one" } };
  const baseline = { ...receipt, records: [{ ...first, before: { payload: { graphOccurrenceContent: { native } } } }] };
  for (const field of Object.keys(native)) {
    const changed = structuredClone(baseline); (changed.records[0]!.before!.payload.graphOccurrenceContent.native as Record<string, unknown>)[field] = "changed";
    assert.notDeepEqual(normalizeEventCompatibilityReceipt(baseline), normalizeEventCompatibilityReceipt(changed), `Native ${field} cannot be hidden by host normalization`);
  }
  const notes = { ...receipt, wire: [{ ...receipt.wire[0]!, body: "Notes\r\nDTSTAMP:20261026T120000Z" }] };
  assert(JSON.stringify(normalizeEventCompatibilityReceipt(notes)).includes("DTSTAMP:20261026T120000Z"), "Arbitrary native notes are not an iCalendar serializer clock");
  const input = { context: { family: [{ id: "event", createdAt: "host-time", providerState: native }], mappings: [] }, baseline: { native }, identity: { actorID: "exact-actor" }, native };
  const rawHash = eventCompatibilityDataHash(input), normalizedHash = eventCompatibilityDataHash(eventCompatibilityNormalizedWitnessInput(input));
  const proven = { ...receipt, records: [{ ...first, before: { payload: { graphOccurrenceContent: { request: { expectedSeriesVersion: rawHash } } } } }], witnesses: [{ kind: "graph-content" as const, rawHash, recomputedRawHash: rawHash, normalizedHash, input }] };
  assert(JSON.stringify(normalizeEventCompatibilityReceipt(proven)).includes(normalizedHash));
  const altered = structuredClone(proven); altered.records[0]!.before!.payload.graphOccurrenceContent.request.expectedSeriesVersion = "0".repeat(64);
  assert.throws(() => normalizeEventCompatibilityReceipt(altered), /altered\/unproven/);
  const alteredProof = structuredClone(proven); alteredProof.witnesses[0]!.input.native.updatedAt = "changed-native";
  assert.throws(() => normalizeEventCompatibilityReceipt(alteredProof), /exact raw witness/);
  const rawBaseline = { ...receipt, records: [{ ...first, before: { payload: { graphSeriesCreate: { baseline: native } } } }] };
  for (const field of Object.keys(native)) { const changed = structuredClone(rawBaseline); (changed.records[0]!.before!.payload.graphSeriesCreate.baseline as Record<string, unknown>)[field] = "changed";
    assert.notDeepEqual(normalizeEventCompatibilityReceipt(rawBaseline), normalizeEventCompatibilityReceipt(changed), `Native baseline ${field} remains exact`); }
  const ownership = { actor_id: "actor", provider: "caldav", user_id: "owner", account_id: "account", calendar_id: "calendar", external_calendar_link_id: "link", external_calendar_id: "http://127.0.0.1:12345/dav/" };
  const mappings = [0, 1, 2].map(index => ({ id: `mapping-${index}`, eventID: `event-${index}`, provider: "caldav", calendarID: "calendar", externalCalendarID: ownership.external_calendar_id, externalEventID: `http://127.0.0.1:12345/dav/family.ics${index ? `#slot-${index}` : ""}`, icalUid: "family", originalStart: index ? { kind: "instant", value: `2026-10-${26 + index}T10:11:12.123Z` } : null }));
  const echoObservations = mappings.map((mapping, sequence) => ({ sequence, operationId: "echo-operation", fixtureCase: "delete-sweep-echo" as const, evidence: { isEcho: true, externalEventId: mapping.externalEventID, etag: null, icalUid: "family", deleted: true, observedAt: `host-clock-${sequence}` }, ownership, mapping, updateSql: 'update "event_outbox" set "remote_snapshot" = $1 where "event_outbox"."id" = $2', rowCount: 1, committed: true as const }));
  const beforeEcho = { id: "echo-operation", ...ownership, payload: { caldavSeriesDeletion: { context: { mappings } } } }, last = echoObservations[2]!.evidence;
  const afterEcho = { ...beforeEcho, status: "completed", remote_snapshot: last };
  const scoped = { ...receipt, records: [{ ...first, id: "echo-operation", family: "caldavSeriesDeletion", fixtureCase: "delete-sweep-echo", before: beforeEcho, after: afterEcho, returned: { id: "echo-operation", remoteSnapshot: last }, state: { ...first.state, event_outbox: [afterEcho] } }], echoObservations };
  const anotherOrder = structuredClone(scoped); anotherOrder.echoObservations.reverse(); anotherOrder.echoObservations.forEach((value, index) => { value.sequence = index; });
  const anotherLast = anotherOrder.echoObservations[2]!.evidence;
  anotherOrder.records[0]!.after.remote_snapshot = anotherLast; anotherOrder.records[0]!.returned.remoteSnapshot = anotherLast; anotherOrder.records[0]!.state.event_outbox[0]!.remote_snapshot = anotherLast;
  assert.deepEqual(normalizeEventCompatibilityReceipt(scoped), normalizeEventCompatibilityReceipt(anotherOrder), "Only this named sweep's proven last-member choice compares its complete exact committed evidence set");
  assert.notDeepEqual(scoped.records[0]!.after.remote_snapshot, anotherOrder.records[0]!.after.remote_snapshot, "Every selected raw address remains disclosed");
  const foreignEcho = structuredClone(scoped); foreignEcho.echoObservations[0]!.evidence.externalEventId = "https://foreign.example/family.ics";
  assert.throws(() => normalizeEventCompatibilityReceipt(foreignEcho), /foreign echo/);
  const missingEcho = structuredClone(scoped); missingEcho.echoObservations.pop(); assert.throws(() => normalizeEventCompatibilityReceipt(missingEcho), /every admitted/);
  const changedSlot = structuredClone(scoped); changedSlot.echoObservations[1]!.mapping = { ...changedSlot.echoObservations[1]!.mapping, originalStart: { ...changedSlot.echoObservations[1]!.mapping.originalStart!, value: "changed-slot" } }; assert.throws(() => normalizeEventCompatibilityReceipt(changedSlot), /original slot/);
  const changedOwner = structuredClone(scoped); changedOwner.echoObservations[0]!.ownership.actor_id = "another-actor"; assert.throws(() => normalizeEventCompatibilityReceipt(changedOwner));
  const wrongLast = structuredClone(scoped); wrongLast.records[0]!.after.remote_snapshot = wrongLast.echoObservations[0]!.evidence; assert.throws(() => normalizeEventCompatibilityReceipt(wrongLast), /last committed/);
  for (const nativeLookalike of [
    { payload: { event: { updatedAt: "native-time-one" } } },
    { payload: { organizer: { dispatch: { startedAt: "native-time-one" } } } },
    { payload: { rsvp: { graphDispatch: { startedAt: "native-time-one", acceptedAt: "native-time-one" } } } },
    { payload: { rsvp: { caldavDelivery: { startedAt: "native-time-one" } } } },
    { payload: { graphOccurrenceContent: { context: { family: [{ updatedAt: "native-time-one" }] } } } },
    { remote_snapshot: { observedAt: "native-time-one" } },
    { state: { events: [{ updated_at: "native-time-one" }] } },
  ]) {
    const source = { ...receipt, records: [{ ...first, before: { payload: { rsvp: { baseline: nativeLookalike } } } }] };
    const changed = JSON.parse(JSON.stringify(source).replace("native-time-one", "native-time-two")) as typeof source;
    assert.notDeepEqual(normalizeEventCompatibilityReceipt(source), normalizeEventCompatibilityReceipt(changed), "Only rooted actual receipt relations own host clocks");
  }
  const rsvpMarkers = { ...receipt, records: [{ ...first, before: { payload: { rsvp: { graphDispatch: { kind: "graph-rsvp-dispatch", version: 1, startedAt: "host-time-one", acceptedAt: "host-time-one" }, caldavDelivery: { kind: "one-send", startedAt: "host-time-one", acceptedAt: "unknown-native-field" } } } } }] };
  const laterMarkers = JSON.parse(JSON.stringify(rsvpMarkers).split("host-time-one").join("host-time-two")) as typeof rsvpMarkers;
  assert.deepEqual(normalizeEventCompatibilityReceipt(rsvpMarkers), normalizeEventCompatibilityReceipt(laterMarkers), "Only the three exact production RSVP host marker clock fields may vary");
  const changedRsvpPolicy = structuredClone(rsvpMarkers); changedRsvpPolicy.records[0]!.before!.payload.rsvp.caldavDelivery.kind = "another-policy";
  assert.notDeepEqual(normalizeEventCompatibilityReceipt(rsvpMarkers), normalizeEventCompatibilityReceipt(changedRsvpPolicy));
  const unknownRsvpField = structuredClone(rsvpMarkers); unknownRsvpField.records[0]!.before!.payload.rsvp.caldavDelivery.acceptedAt = "changed-unknown-native-field";
  assert.notDeepEqual(normalizeEventCompatibilityReceipt(rsvpMarkers), normalizeEventCompatibilityReceipt(unknownRsvpField), "CalDAV does not gain an invented acceptedAt field");
  const desiredResource = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:owned-uid\r\nDTSTAMP:20261026T120000Z\r\nDTSTART:20261026T101112Z\r\nDTEND:20261026T111213Z\r\nDESCRIPTION:Literal DTSTAMP:20260101T000000Z\r\nX-PRIVATE;X-KEEP=yes:Folded\r\n extension\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const clock: EventCompatibilitySerializerClock = { operationId: "serializer-operation", resourceUrl: receipt.wire[0]!.url, uid: "owned-uid", stamp: "20261026T120000Z", desiredResource,
    resourceSha256: createHash("sha256").update(desiredResource).digest("hex"), serializer: "caldavOrganizerDesired", verified: true, generatedProperty: true };
  const serializerReceipt = { ...receipt, serializerClocks: [clock], records: [{ ...first, id: clock.operationId, before: { id: clock.operationId, provider: "caldav", payload: { organizer: { request: { provider: "caldav", action: "create" }, desired: { id: clock.resourceUrl, iCalUID: clock.uid, stamp: clock.stamp, data: desiredResource } } } } }],
    wire: [{ ...receipt.wire[0]!, body: desiredResource, responseBody: desiredResource }] };
  const otherClock = structuredClone(serializerReceipt), nextStamp = "20261027T120000Z";
  otherClock.serializerClocks[0]!.stamp = nextStamp; otherClock.serializerClocks[0]!.desiredResource = desiredResource.replace(`DTSTAMP:${clock.stamp}`, `DTSTAMP:${nextStamp}`);
  otherClock.serializerClocks[0]!.resourceSha256 = createHash("sha256").update(otherClock.serializerClocks[0]!.desiredResource).digest("hex");
  otherClock.records[0]!.before!.payload.organizer.desired.stamp = nextStamp; otherClock.records[0]!.before!.payload.organizer.desired.data = otherClock.serializerClocks[0]!.desiredResource;
  otherClock.wire[0]!.body = otherClock.serializerClocks[0]!.desiredResource; otherClock.wire[0]!.responseBody = otherClock.serializerClocks[0]!.desiredResource;
  assert.deepEqual(normalizeEventCompatibilityReceipt(serializerReceipt), normalizeEventCompatibilityReceipt(otherClock), "Only the actual-proven owned serializer clock may vary");
  const foreign = desiredResource.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:foreign-sibling\r\nDTSTAMP:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR");
  assert.equal(eventCompatibilityGeneratedClockResource(foreign, clock), foreign, "Foreign or preserved sibling component stamps stay exact even with an owned target proof");
  const withSibling = structuredClone(serializerReceipt); withSibling.wire[0]!.responseBody = foreign;
  const changedSibling = structuredClone(withSibling); changedSibling.wire[0]!.responseBody = foreign.replace("DTSTAMP:20260101T000000Z\r\nEND:VEVENT", "DTSTAMP:20260202T000000Z\r\nEND:VEVENT");
  assert.notDeepEqual(normalizeEventCompatibilityReceipt(withSibling), normalizeEventCompatibilityReceipt(changedSibling));
  for (const [oldBytes, newBytes] of [[" extension", "  extension"], ["X-PRIVATE", "X-private"], ["Folded", "Folded "], ["Literal DTSTAMP:20260101T000000Z", "Literal DTSTAMP:20260202T000000Z"]]) {
    const changed = structuredClone(serializerReceipt); changed.wire[0]!.responseBody = desiredResource.replace(oldBytes!, newBytes!);
    assert.notDeepEqual(normalizeEventCompatibilityReceipt(serializerReceipt), normalizeEventCompatibilityReceipt(changed), "Unknown property bytes, folding, case and descriptions must survive clock comparison");
  }
  const wrongBody = structuredClone(serializerReceipt); wrongBody.wire[0]!.body = desiredResource.replace("Folded", "Changed native field");
  assert.throws(() => normalizeEventCompatibilityReceipt(wrongBody), /whole recomputed native serializer resource/);
  const recurrenceResource = desiredResource.replace("UID:owned-uid", "UID:owned-uid\r\nRECURRENCE-ID:20261026T101112Z");
  assert.equal(eventCompatibilityGeneratedClockResource(recurrenceResource, clock), recurrenceResource, "An unowned recurrence component never gains a generated-clock exception");
  console.log(`Event compatibility fixture source: ${EVENT_COMPATIBILITY_FIXTURES.length} assertion-bearing programs, priority and strict normalization: PASS`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
