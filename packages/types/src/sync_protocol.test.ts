import assert from "node:assert/strict";
import {
  SYNC_PROFILE_V1, SyncCapabilityDecisionSchema, SyncCoverageSchema, SyncDeliveryReceiptSchema,
  SyncErrorSchema, SyncObjectIdentitySchema, SyncObservationSchema, SyncOperationIdentitySchema,
  SyncOccurrenceIdentitySchema, SyncReadBatchSchema, SyncReadScopeSchema, SyncRecurrenceSchema,
  SyncTimeSchema, SyncValidatorSchema, applySyncReadBatch, classifySyncProfile,
  musubiInclusiveDatesToSync, scopedProviderLocatorKey, syncDatesToMusubiInclusive,
  syncOccurrenceKey, syncReadScopeKey,
  type SyncHostApplyPort,
} from "./sync_protocol";

// Copies share an iCal UID and a native ID but remain separate resources and host objects.
const alice = SyncObjectIdentitySchema.parse({
  hostObjectId: "host-event-alice", uid: "meeting-uid", familyId: "alice-family",
  locator: { provider: "google", connectionId: "alice-grant", collectionId: "primary", resourceId: "native-event" },
});
const bob = SyncObjectIdentitySchema.parse({
  hostObjectId: "host-event-bob", uid: "meeting-uid", familyId: "bob-family",
  locator: { ...alice.locator, connectionId: "bob-grant" },
});
assert.notEqual(scopedProviderLocatorKey(alice.locator), scopedProviderLocatorKey(bob.locator));
assert.notEqual(scopedProviderLocatorKey(alice.locator), scopedProviderLocatorKey({ ...alice.locator, collectionId: SyncReadScopeSchema.parse({
  provider: "google", connectionId: "alice-grant", collectionId: "secondary",
  sourceEpoch: { sourceId: "source-1", generation: 1 }, configurationFingerprint: "all-events",
}).collectionId }));
assert.equal(alice.uid, bob.uid);
assert.notEqual(alice.hostObjectId, alice.locator.resourceId);
const sharedSlot = { kind: "instant", value: "2026-10-12T08:00:00Z" };
assert.notEqual(
  syncOccurrenceKey(SyncOccurrenceIdentitySchema.parse({ familyId: alice.familyId, originalStart: sharedSlot })),
  syncOccurrenceKey(SyncOccurrenceIdentitySchema.parse({ familyId: bob.familyId, originalStart: sharedSlot })),
  "Host-assigned family IDs scope equal native series IDs and original slots across connections",
);
const operation = SyncOperationIdentitySchema.parse({ commandId: "human-edit", operationId: "destination-write", attemptId: "attempt-1" });
const recovered = SyncOperationIdentitySchema.parse({ ...operation, attemptId: "attempt-2" });
assert.equal(operation.operationId, recovered.operationId);
assert.notEqual(operation.attemptId, recovered.attemptId);
assert.equal(SyncOperationIdentitySchema.safeParse({ ...operation, providerId: "native-event" }).success, false);

// A moved exception retains its ORIGINAL slot; no current start is part of its identity.
const original = SyncOccurrenceIdentitySchema.parse({ familyId: "dav-resource-family", originalStart: { kind: "date", value: "2026-10-12" } });
const family = SyncRecurrenceSchema.parse({
  kind: "series", familyId: original.familyId, rules: ["FREQ=DAILY;COUNT=3"], inclusions: [], exclusions: [],
  overrides: [{ originalStart: original.originalStart, cancelled: false,
    time: { kind: "date", startDate: "2026-10-14", endDateExclusive: "2026-10-15" } }], completeness: "complete",
});
assert.equal(family.kind, "series");
if (family.kind !== "series") throw new Error("Unexpected recurrence fixture");
assert.equal(syncOccurrenceKey(original), syncOccurrenceKey({ familyId: family.familyId, originalStart: family.overrides[0].originalStart }));
assert.notEqual(syncOccurrenceKey(original), syncOccurrenceKey(SyncOccurrenceIdentitySchema.parse({ familyId: original.familyId, originalStart: { kind: "floating", value: "2026-10-12T00:00:00" } })));
assert.equal(SyncObjectIdentitySchema.safeParse({ ...alice, occurrence: original }).success, false, "a DAV family cannot be silently adopted into another host family");

// Fold observations can have reversed civil endpoint order while instants remain ordered.
const fold = SyncTimeSchema.parse({
  kind: "zoned", timeZone: "America/New_York", startLocal: "2026-11-01T01:45:00", endLocal: "2026-11-01T01:15:00",
  resolved: { start: "2026-11-01T05:45:00Z", end: "2026-11-01T06:15:00Z" },
});
assert.deepEqual(SyncTimeSchema.parse(JSON.parse(JSON.stringify(fold))), fold);
const gap = SyncTimeSchema.parse({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T02:30:00", endLocal: "2026-03-29T04:30:00" });
assert.equal(gap.kind === "zoned" && gap.startLocal, "2026-03-29T02:30:00.000");
const floating = SyncTimeSchema.parse({ kind: "floating", startLocal: "2026-03-29T02:30:00", endLocal: "2026-03-29T03:30:00" });
assert.equal("timeZone" in floating, false);
const legacy = SyncTimeSchema.parse({ kind: "legacy-unknown", observed: { start: "2026-10-12T08:00:00Z", end: "2026-10-12T09:00:00Z" } });
assert.equal(legacy.kind, "legacy-unknown");
assert.equal("timeZone" in legacy, false);
for (const value of [
  { ...floating, timeZone: "Europe/Prague" },
  { ...legacy, timeZone: "UTC" },
  { kind: "date", startDate: "2026-10-12", endDateExclusive: "2026-10-12" },
  { kind: "date", startDate: "2026-02-30", endDateExclusive: "2026-03-02" },
  { kind: "zoned", timeZone: "+02:00", startLocal: "2026-10-12T08:00:00", endLocal: "2026-10-12T09:00:00" },
  { kind: "floating", startLocal: "2026-10-12T08:00:00Z", endLocal: "2026-10-12T09:00:00Z" },
]) assert.equal(SyncTimeSchema.safeParse(value).success, false);
for (const [first, last, exclusive] of [
  ["2026-10-12", "2026-10-12", "2026-10-13"],
  ["2028-02-28", "2028-02-29", "2028-03-01"],
  ["2026-12-31", "2026-12-31", "2027-01-01"],
  ["0099-12-31", "0099-12-31", "0100-01-01"],
]) {
  assert.deepEqual(musubiInclusiveDatesToSync({ startDate: first, endDateInclusive: last }), { startDate: first, endDateExclusive: exclusive });
  assert.deepEqual(syncDatesToMusubiInclusive({ startDate: first, endDateExclusive: exclusive }), { startDate: first, endDateInclusive: last });
}
assert.throws(() => musubiInclusiveDatesToSync({ startDate: "9999-12-31", endDateInclusive: "9999-12-31" }), "out-of-profile date must fail rather than truncate");

// A Graph guarded DELETE compares the exact native weak ETag; it is still not an atomic CAS.
const capabilityContext = {
  locator: { ...alice.locator, provider: "microsoft" }, sourceEpoch: { sourceId: "outlook-link", generation: 3 },
  operation: "delete", role: "personal-owner", scopeKnowledge: "known", grantedScopes: ["Calendars.ReadWrite"], family: "personal-single",
};
const guarded = SyncCapabilityDecisionSchema.parse({
  kind: "allowed", context: capabilityContext, profile: SYNC_PROFILE_V1,
  guarantee: { kind: "guarded-preflight", validatorKind: "etag", endpointProfile: "graph-personal-delete-v1", race: "read-write-gap", uncertainReplay: "observe-only" },
});
assert.equal(guarded.kind === "allowed" && guarded.guarantee.kind, "guarded-preflight");
const conditional = SyncCapabilityDecisionSchema.parse({
  kind: "allowed", context: { ...capabilityContext, locator: { ...alice.locator, provider: "caldav" } }, profile: SYNC_PROFILE_V1,
  guarantee: { kind: "conditional", validatorKind: "etag", endpointProfile: "dav-resource-if-match-v1" },
});
assert.equal(conditional.kind === "allowed" && conditional.guarantee.kind, "conditional");
assert.equal(SyncValidatorSchema.parse({ kind: "change-key", value: "opaque-key" }).kind, "change-key");
const graphNativeWeakEtag = SyncValidatorSchema.parse({ kind: "etag", value: 'W/"native-resource-version"' });
assert.equal(graphNativeWeakEtag.kind, "etag");
assert.notDeepEqual(graphNativeWeakEtag, SyncValidatorSchema.parse({ kind: "change-key", value: "native-resource-version" }), "changeKey must not substitute for the exact native ETag evidence");
assert.equal(SyncValidatorSchema.safeParse({ kind: "etag", value: "opaque-key", localRevision: "3" }).success, false);
assert.equal(SyncCapabilityDecisionSchema.safeParse({ ...guarded, guarantee: { kind: "unconditional" } }).success, false);
for (const context of [
  { ...capabilityContext, role: "reader" }, { ...capabilityContext, role: "unknown" },
  { ...capabilityContext, scopeKnowledge: "unknown" }, { ...capabilityContext, family: "unknown" },
  { ...capabilityContext, operation: "read" },
]) assert.equal(SyncCapabilityDecisionSchema.safeParse({ ...guarded, context }).success, false);
for (const [kind, reason] of [["denied", "read-only"], ["unknown", "permission-unknown"], ["unsupported", "unsupported-recurrence"]]) {
  assert.equal(SyncCapabilityDecisionSchema.parse({ kind, context: capabilityContext, reason }).kind, kind);
}
assert.equal(SyncCapabilityDecisionSchema.safeParse({ kind: "denied", context: capabilityContext, reason: "permission-unknown" }).success, false, "unknown is not a known denial");
assert.equal(classifySyncProfile(SYNC_PROFILE_V1), "supported");
for (const profile of [undefined, null, "sync-profile-v0", "sync-profile-v2", {}]) assert.equal(classifySyncProfile(profile), "unsupported");

// Complete paging inside a calendarView window never certifies collection inventory.
const scope = SyncReadScopeSchema.parse({
  provider: "google", connectionId: "alice-grant", collectionId: "primary",
  sourceEpoch: { sourceId: "source-1", generation: 3 }, configurationFingerprint: "events-with-current-access",
});
const absent = SyncObservationSchema.parse({ kind: "resource-absent", observationId: "window-removal-1", locator: alice.locator, reason: "window-removal" });
const window = { kind: "window", fromInclusive: "2026-10-01T00:00:00Z", untilExclusive: "2026-11-01T00:00:00Z", complete: true };
const batch = SyncReadBatchSchema.parse({ profile: SYNC_PROFILE_V1, scope, runId: "read-1", observations: [absent], coverage: window, checkpoint: "cursor-1" });
assert.equal(batch.coverage.kind, "window");
assert.equal(batch.observations[0].kind, "resource-absent");
assert.equal(SyncCoverageSchema.parse({ kind: "partial", reason: "permissions" }).kind, "partial");
assert.equal(SyncReadBatchSchema.safeParse({ ...batch, continuation: "next-page" }).success, false);
assert.equal(SyncReadBatchSchema.safeParse({ ...batch, coverage: { kind: "collection-inventory-complete", snapshotId: "inventory-1" }, continuation: "next-page" }).success, false);
assert.equal(SyncReadBatchSchema.safeParse({ ...batch, observations: [{ ...absent, locator: bob.locator }] }).success, false);
assert.equal(SyncObservationSchema.safeParse({ ...absent, kind: "deletion-proven", reason: undefined }).success, false);
const proven = SyncObservationSchema.parse({
  kind: "deletion-proven", observationId: "native-get-404", locator: alice.locator,
  evidence: { kind: "scoped-native-absence", responseStatus: 404, readAuthorityVerified: true, nativeReadProfile: "verified-native-resource-get-v1" },
});
assert.equal(proven.kind, "deletion-proven");
if (proven.kind !== "deletion-proven") throw new Error("Unexpected deletion fixture");
assert.equal(SyncObservationSchema.safeParse({ ...proven, evidence: { ...proven.evidence, readAuthorityVerified: false } }).success, false);
assert.notEqual(syncReadScopeKey(scope), syncReadScopeKey({ ...scope, sourceEpoch: { ...scope.sourceEpoch, generation: 4 } }));
assert.notEqual(syncReadScopeKey(scope), syncReadScopeKey({ ...scope, sourceEpoch: { ...scope.sourceEpoch, sourceId: "reconnected-new-source" } }));
assert.notEqual(syncReadScopeKey(scope), syncReadScopeKey({ ...scope, configurationFingerprint: "different-filter" }));

// Retirement after HTTP but before the fenced apply rejects both observations AND cursor.
let currentScope = scope;
let transactionActive = false;
let applied = 0;
let checkpoint: string | undefined;
const host: SyncHostApplyPort = {
  async withSourceTransaction(_scope, body) {
    assert.equal(transactionActive, false);
    transactionActive = true;
    try {
      return await body({
        async revalidateSource(expected) {
          assert.equal(transactionActive, true);
          return syncReadScopeKey(expected) === syncReadScopeKey(currentScope) ? { kind: "current" } : { kind: "changed" };
        },
        async applyBatch(value) {
          assert.equal(transactionActive, true);
          applied++;
          checkpoint = value.checkpoint;
        },
      });
    } finally { transactionActive = false; }
  },
};
currentScope = { ...scope, sourceEpoch: { ...scope.sourceEpoch, generation: 4 } };
assert.deepEqual(await applySyncReadBatch(host, batch), { kind: "rejected-source", reason: "changed" });
assert.equal(applied, 0);
assert.equal(checkpoint, undefined);
currentScope = { ...scope, configurationFingerprint: "changed-after-http" };
assert.deepEqual(await applySyncReadBatch(host, batch), { kind: "rejected-source", reason: "changed" });
assert.equal(applied, 0);
assert.equal(checkpoint, undefined);
const retiredHost: SyncHostApplyPort = {
  async withSourceTransaction(_scope, body) {
    return body({
      async revalidateSource() { return { kind: "retired" }; },
      async applyBatch() { throw new Error("Retired source must not apply observations/checkpoint"); },
    });
  },
};
assert.deepEqual(await applySyncReadBatch(retiredHost, batch), { kind: "rejected-source", reason: "retired" });
currentScope = scope;
assert.deepEqual(await applySyncReadBatch(host, batch), { kind: "applied" });
assert.equal(applied, 1);
assert.equal(checkpoint, "cursor-1");
await assert.rejects(applySyncReadBatch({
  async withSourceTransaction(_scope, body) {
    return body({ async revalidateSource() { return { kind: "current" }; }, async applyBatch() { throw new Error("transaction rollback"); } });
  },
}, batch), /transaction rollback/);

// Endpoint acceptance, remote readback and invitation delivery are independent evidence.
const receipt = SyncDeliveryReceiptSchema.parse({
  profile: SYNC_PROFILE_V1, operationId: operation.operationId, attemptId: operation.attemptId,
  local: { kind: "committed", hostObjectId: alice.hostObjectId, revision: "host-revision-3" },
  provider: { kind: "accepted" }, remote: { kind: "unobserved" }, notification: { kind: "unknown" },
});
assert.equal(receipt.local.kind, "committed");
assert.equal(receipt.provider.kind, "accepted");
assert.equal(receipt.remote.kind, "unobserved");
assert.equal(receipt.notification.kind, "unknown");
const lostReply = SyncDeliveryReceiptSchema.parse({ ...receipt, provider: { kind: "uncertain" }, remote: { kind: "confirmed", observationId: "matching-readback" } });
assert.equal(lostReply.provider.kind, "uncertain", "matching readback must not invent an endpoint reply");
assert.equal(SyncDeliveryReceiptSchema.safeParse({ ...receipt, local: { kind: "not-committed" } }).success, false);
assert.equal(SyncDeliveryReceiptSchema.safeParse({ ...receipt, notification: { kind: "delivered" } }).success, false);
assert.equal(SyncErrorSchema.safeParse({ code: "uncertain-dispatch", retry: "after-delay", retryAfterMs: 1000 }).success, false);
assert.deepEqual(SyncErrorSchema.parse({ code: "uncertain-dispatch", retry: "observe-only" }), { code: "uncertain-dispatch", retry: "observe-only" });

console.log("Host-independent sync profile contracts: OK");

console.log("SYNC_CONFORMANCE_COMPLETE:unit/types/protocol");
