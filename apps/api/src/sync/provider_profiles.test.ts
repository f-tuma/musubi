import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { SYNC_PROFILE_V1 } from "@musubi/types";
import {
  CURRENT_SYNC_ENDPOINT_PROFILES,
  CurrentSyncEndpointProfileSchema,
  findCurrentSyncEndpointProfile,
} from "./provider_profiles";

const get = (provider: "google" | "microsoft" | "caldav", family: "personal-single" | "task", operation: "create" | "update" | "delete") => {
  const value = findCurrentSyncEndpointProfile({ provider, family, operation, profile: SYNC_PROFILE_V1 });
  assert.ok(value, `${provider}/${family}/${operation} has an explicit descriptor`);
  return value;
};
const guarantee = (provider: "google" | "microsoft" | "caldav", family: "personal-single" | "task", operation: "create" | "update" | "delete") => {
  const profile = get(provider, family, operation);
  assert.equal(profile.support.kind, "profiled");
  if (profile.support.kind !== "profiled") throw new Error("Unsupported portability is not a write guarantee");
  return profile.support.guarantee;
};

test("endpoint inventory is scoped, unique, serializable and has real implementation/evidence references", () => {
  assert.equal(CURRENT_SYNC_ENDPOINT_PROFILES.length, 18);
  const ids = new Set<string>();
  const selectors = new Set<string>();
  const repository = new URL("../../../../", import.meta.url);
  for (const profile of CURRENT_SYNC_ENDPOINT_PROFILES) {
    assert.deepEqual(CurrentSyncEndpointProfileSchema.parse(JSON.parse(JSON.stringify(profile))), profile);
    assert.equal(ids.has(profile.id), false, "a versioned endpoint ID cannot name two contracts");
    ids.add(profile.id);
    const selector = JSON.stringify([profile.provider, profile.family, profile.operation]);
    assert.equal(selectors.has(selector), false, "generic lookup must be unambiguous");
    selectors.add(selector);
    for (const path of profile.sources) assert.ok(existsSync(new URL(path, repository)), `missing source ${path}`);
  }
});

test("Graph native event version has distinct PATCH and guarded DELETE guarantees", () => {
  const patch = get("microsoft", "personal-single", "update");
  const deletion = get("microsoft", "personal-single", "delete");
  assert.equal(patch.validator, "native-weak-etag");
  assert.equal(deletion.validator, "native-weak-etag");
  assert.deepEqual(guarantee("microsoft", "personal-single", "update"), {
    kind: "conditional", validatorKind: "etag", endpointProfile: patch.id,
  });
  assert.deepEqual(guarantee("microsoft", "personal-single", "delete"), {
    kind: "guarded-preflight", validatorKind: "etag", endpointProfile: deletion.id,
    race: "read-write-gap", uncertainReplay: "observe-only",
  });
  assert.equal(deletion.recovery.policy, "observe-only");
  assert.deepEqual(patch.roles, ["personal-owner"], "shared-writer is not owned personal-calendar evidence");
  assert.ok(patch.sources.includes("apps/api/src/sync/adapters/microsoft_event_content.test.ts"));
  assert.ok(deletion.sources.includes("apps/api/src/sync/adapters/microsoft_event_delete.test.ts"));
});

test("event CREATE correlation does not imply indefinite Graph POST replay", () => {
  const google = get("google", "personal-single", "create");
  const graph = get("microsoft", "personal-single", "create");
  const dav = get("caldav", "personal-single", "create");
  assert.equal(google.createIdentity?.kind, "google-client-id");
  assert.equal(google.createIdentity?.binding, "operation");
  assert.equal(google.support.kind, "unsupported-portability");
  if (google.support.kind === "unsupported-portability") assert.equal(google.support.reason, "unsafe-uncertain-create");
  assert.equal(google.recovery.policy, "legacy-only-unproven");
  assert.ok(google.primaryReferences.includes("https://developers.google.com/workspace/calendar/api/v3/reference/events/insert"));
  assert.equal(graph.createIdentity?.kind, "graph-transaction-id");
  assert.deepEqual(guarantee("microsoft", "personal-single", "create"), {
    kind: "non-idempotent-action", endpointProfile: graph.id, uncertainReplay: "observe-only",
  });
  assert.equal(graph.recovery.policy, "observe-only");
  assert.equal(dav.createIdentity?.kind, "dav-operation-url-uid");
  assert.equal(dav.createIdentity?.binding, "operation");
  assert.deepEqual(guarantee("caldav", "personal-single", "create"), {
    kind: "conditional", validatorKind: "resource-must-not-exist", endpointProfile: dav.id,
  });
  assert.equal(dav.recovery.policy, "observe-before-same-identity-create");
});

test("task CREATE preserves response-address and deterministic DAV recovery boundaries", () => {
  for (const provider of ["google", "microsoft"] as const) {
    const profile = get(provider, "task", "create");
    assert.equal(profile.createIdentity?.kind, "provider-assigned");
    assert.equal(profile.createIdentity?.binding, "response-address");
    assert.equal(profile.recovery.policy, "observe-only");
    assert.equal(guarantee(provider, "task", "create").kind, "non-idempotent-action");
  }
  const dav = get("caldav", "task", "create");
  assert.equal(dav.createIdentity?.kind, "dav-task-url-uid");
  assert.equal(dav.createIdentity?.binding, "host-object", "current VTODO identity is task-derived, not event operation-derived");
  assert.equal(dav.recovery.policy, "observe-only", "deterministic address alone does not enable a new replay strategy");
});

test("To Do legacy home If-Match does not become portable conditional capability", () => {
  for (const operation of ["update", "delete"] as const) {
    const profile = get("microsoft", "task", operation);
    assert.equal(profile.validator, "native-weak-etag");
    assert.equal(profile.support.kind, "unsupported-portability");
    if (profile.support.kind === "unsupported-portability") {
      assert.equal(profile.support.reason, "conditional-write-unproven");
      assert.match(profile.support.legacyBehavior, /Existing home methods/);
    }
    assert.equal(profile.recovery.policy, "legacy-only-unproven");
    assert.ok(profile.sources.includes("apps/api/src/sync/adapters/microsoft_task_write.test.ts"));
  }
});

test("Calendar/Tasks scopes remain independent; DAV requires native privilege evidence", () => {
  for (const operation of ["create", "update", "delete"] as const) {
    assert.deepEqual(get("google", "personal-single", operation).requiredScopes, ["https://www.googleapis.com/auth/calendar.events"]);
    assert.deepEqual(get("google", "task", operation).requiredScopes, ["https://www.googleapis.com/auth/tasks"]);
    assert.deepEqual(get("microsoft", "personal-single", operation).requiredScopes, ["Calendars.ReadWrite"]);
    assert.deepEqual(get("microsoft", "task", operation).requiredScopes, ["Tasks.ReadWrite"]);
    for (const family of ["personal-single", "task"] as const) {
      const dav = get("caldav", family, operation);
      assert.deepEqual(dav.requiredScopes, []);
      assert.ok(dav.requiredEvidence.some(value => value.includes("DAV")), "empty OAuth scopes cannot stand in for DAV ACL evidence");
    }
  }
});

test("unknown semantic profiles and specialized families have no generic fallback", () => {
  const selector = { provider: "google", family: "personal-single", operation: "update", profile: SYNC_PROFILE_V1 } as const;
  for (const profile of [undefined, null, "sync-profile-v0", "sync-profile-v2", {}, 1, ""]) {
    assert.equal(findCurrentSyncEndpointProfile({ ...selector, profile }), undefined);
  }
  for (const family of ["recurring-master", "recurring-occurrence", "recurring-following", "meeting", "unknown"] as const) {
    assert.equal(findCurrentSyncEndpointProfile({ ...selector, family }), undefined);
  }
  for (const operation of ["read", "list", "rsvp", "organizer-update", "move", "split-following"] as const) {
    assert.equal(findCurrentSyncEndpointProfile({ ...selector, operation }), undefined);
  }
  assert.equal(findCurrentSyncEndpointProfile({ ...selector, provider: "unknown-provider" }), undefined);
});

test("write descriptor schema refuses fake read guarantees and malformed identity contracts", () => {
  const profile = get("google", "personal-single", "create");
  assert.equal(CurrentSyncEndpointProfileSchema.safeParse({ ...profile, createIdentity: undefined }).success, false);
  assert.equal(CurrentSyncEndpointProfileSchema.safeParse({ ...profile, support: { kind: "profiled", guarantee: { kind: "read-only" } } }).success, false);
  const update = get("google", "personal-single", "update");
  assert.equal(CurrentSyncEndpointProfileSchema.safeParse({ ...update, createIdentity: profile.createIdentity }).success, false);
  const unsupported = get("microsoft", "task", "update");
  assert.equal(CurrentSyncEndpointProfileSchema.safeParse({ ...unsupported, support: { ...unsupported.support, guarantee: guarantee("google", "task", "update") } }).success, false);
});
