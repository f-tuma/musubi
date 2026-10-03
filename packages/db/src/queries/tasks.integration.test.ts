import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db, user, tasks, calendarTasks, calendarMembers, externalCalendars, externalTasks,
  taskOutbox, taskMutations, createCalendar, removeCalendar, createTask, updateTask,
  getTask, getTaskSnapshot, getUserTask, getUserTasks, linkTask, unlinkTask, forkTask, getTaskForkReplay, rejectTaskFork,
  removeTask, claimTaskOutbox, finishTaskOutbox, getDueTaskOutboxIDs, getTaskOutbox,
  getTaskOutboxExpectedRef, assertTaskOutboxSourceInTransaction, taskOutboxSnapshot,
  getTaskOutboxPredecessorEvidence, prepareTaskOutboxInTransaction, appendTaskOutbox, createTaskInTransaction,
  upsertExternalTask,
  DuplicateTaskMutationError, type TaskWriteOptions,
  deleteUserWithCalendarRevisions,
} from "..";
import { lockCalendarLifecycle } from "./calendar-lifecycle";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use only a disposable test PostgreSQL database.");
  const owner = `tasks-owner-${randomUUID()}`, secondaryOwner = `tasks-share-${randomUUID()}`, viewer = `tasks-viewer-${randomUUID()}`;
  for (const id of [owner, secondaryOwner, viewer]) await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  const options = (revision: number, actorID = owner): TaskWriteOptions => ({ actorID, expectedRevision: revision, mutationID: randomUUID() });
  try {
    const home = await createCalendar({ creatorID: owner, name: "Home", color: "#112233" });
    const share = await createCalendar({ creatorID: secondaryOwner, name: "Share", color: "#112233" });
    const other = await createCalendar({ creatorID: owner, name: "Other", color: "#112233" });
    await db.insert(calendarMembers).values([
      { userID: owner, calendarID: share.id, role: "viewer" },
      { userID: secondaryOwner, calendarID: home.id, role: "viewer" },
      { userID: viewer, calendarID: share.id, role: "viewer" },
    ]);
    const createIdentity = { actorID: owner, mutationID: randomUUID() };
    const task = await createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "One identity", description: "Rich description", status: "needs-action" }, createIdentity);
    assert.equal(task.revision, 1);
    assert.equal(task.originCalendarID, home.id);
    assert.deepEqual(task.calendars, [home.id]);
    await assert.rejects(() => createTask({ id: randomUUID(), creatorID: owner, calendarID: home.id, title: "Duplicate mutation" }, createIdentity), DuplicateTaskMutationError);
    assert.equal((await db.select().from(taskMutations).where(eq(taskMutations.mutationID, createIdentity.mutationID))).length, 1);
    const linked = await linkTask(task.id, share.id, options(1, secondaryOwner));
    assert.ok(linked); assert.equal(linked.revision, 2);
    const readable = await getUserTask(viewer, task.id);
    assert.ok(readable); assert.deepEqual(readable.calendars, [share.id]);
    assert.equal(readable.canEdit, false, "A readable secondary does not grant home write authority");
    assert.equal(readable.canShareContent, true, "Sharing a readable snapshot does not require home write authority");
    assert.deepEqual(readable.editableCalendarIDs, []);
    assert.equal((await getUserTasks(owner)).filter((t) => t.id === task.id).length, 1, "Two readable calendars render one logical task");
    await assert.rejects(() => updateTask(task.id, { title: "Wrong authority" }, options(2, secondaryOwner)), /not permitted/);
    await assert.rejects(() => removeTask(task.id, options(2, secondaryOwner)), /not permitted/);
    await assert.rejects(() => linkTask(task.id, other.id, options(2, viewer)), /not permitted/);
    await assert.rejects(() => unlinkTask(task.id, home.id, options(2)), /instead of unlinking home/);
    const completed = await updateTask(task.id, { status: "completed", percentComplete: 100, completedAt: new Date() }, options(2));
    assert.ok(completed); assert.equal((await getUserTask(viewer, task.id))?.status, "completed");
    assert.equal((await getUserTask(viewer, task.id))?.revision, 3);
    const results = await Promise.all([
      updateTask(task.id, { title: "Draft A" }, options(3)),
      updateTask(task.id, { title: "Draft B" }, options(3)),
    ]);
    assert.equal(results.filter(Boolean).length, 1, "Two writers cannot both win the same revision");
    assert.equal((await getTask(task.id))?.revision, 4);
    assert.equal(await updateTask(task.id, { title: "Stale" }, options(3)), null);
    await assert.rejects(() => updateTask(task.id, { title: "Missing CAS" }, options(undefined as unknown as number)), /expected task revision/);
    const copyIdentity = options(4, secondaryOwner);
    const copied = await forkTask(task.id, { id: randomUUID(), calendarID: share.id }, copyIdentity);
    assert.ok(copied); assert.notEqual(copied.id, task.id);
    assert.equal(copied.creatorID, secondaryOwner); assert.equal(copied.originCalendarID, share.id); assert.equal(copied.revision, 1);
    assert.equal(copied.status, "completed", "Fork starts with the source snapshot and an independent identity");
    assert.deepEqual(await getTaskForkReplay(task.id.toUpperCase(), share.id.toUpperCase(), copyIdentity),
      { kind: "committed", taskID: copied.id, revision: 1 }, "Exact actor-scoped fork receipt recovers its copy identity");
    const [copyReceipt] = await db.select().from(taskMutations).where(eq(taskMutations.mutationID, copyIdentity.mutationID));
    assert.deepEqual(copyReceipt.forkRequest, { sourceTaskID: task.id, targetCalendarID: share.id,
      expectedRevision: 4, expectedProviderReadRetiredGeneration: 0 });
    assert.equal(JSON.stringify(copyReceipt).includes("Rich description"), false, "Ledger retains no copied content");
    await assert.rejects(() => getTaskForkReplay(task.id, other.id, copyIdentity), DuplicateTaskMutationError);
    await assert.rejects(() => getTaskForkReplay(task.id, share.id, { ...copyIdentity, expectedRevision: 5 }), DuplicateTaskMutationError);
    await assert.rejects(() => getTaskForkReplay(task.id, share.id, { ...copyIdentity, expectedProviderReadRetiredGeneration: 1 }), DuplicateTaskMutationError);
    await assert.rejects(() => getTaskForkReplay(copied.id, share.id, copyIdentity), DuplicateTaskMutationError);
    assert.equal(await getTaskForkReplay(task.id, share.id, { ...copyIdentity, actorID: viewer }), null,
      "Another actor cannot recover the copy identity with the same mutation key");
    await assert.rejects(() => getTaskForkReplay(task.id, home.id, { ...copyIdentity, actorID: owner,
      mutationID: createIdentity.mutationID }), DuplicateTaskMutationError, "An identity from another operation cannot become a fork result");
    const detached = await unlinkTask(task.id, share.id, options(4, secondaryOwner));
    assert.ok(detached); assert.equal(detached.revision, 5); assert.equal(detached.deletedAt, null);
    assert.equal(await getUserTask(viewer, task.id), null);
    assert.ok(await getTask(task.id));
    assert.deepEqual(await getTaskForkReplay(task.id, share.id, copyIdentity), { kind: "committed", taskID: copied.id, revision: 1 },
      "Later source revisions and source access revocation do not invalidate an independent copy receipt");
    const rejectedIdentity = options(4, secondaryOwner);
    assert.equal(await forkTask(task.id, { id: randomUUID(), calendarID: share.id }, rejectedIdentity), null);
    assert.deepEqual(await getTaskForkReplay(task.id, share.id, rejectedIdentity), { kind: "not-committed" },
      "Stale source rejection certifies terminal noncommit under the same key lock");
    const [rejectedReceipt] = await db.select().from(taskMutations).where(eq(taskMutations.mutationID, rejectedIdentity.mutationID));
    assert.equal(rejectedReceipt.forkOutcome, "not-committed");
    await assert.rejects(() => forkTask(task.id, { id: randomUUID(), calendarID: share.id }, rejectedIdentity), DuplicateTaskMutationError,
      "A delayed original request cannot create a copy after the terminal proof");
    assert.ok(await forkTask(task.id, { id: randomUUID(), calendarID: share.id }, options(5, secondaryOwner)),
      "A deliberate fresh intent can copy a refreshed source after rejection");
    const terminalRaceIdentity = options(5, secondaryOwner), terminalRaceCopyID = randomUUID();
    const terminalRace = await Promise.allSettled([
      forkTask(task.id, { id: terminalRaceCopyID, calendarID: share.id }, terminalRaceIdentity),
      rejectTaskFork(task.id, share.id, terminalRaceIdentity),
    ]);
    assert.equal(terminalRace.filter(result => result.status === "fulfilled").length, 1,
      "Commit and terminal rejection serialize to one authoritative outcome");
    const rejectedRace = terminalRace.find(result => result.status === "rejected");
    assert.ok(rejectedRace?.status === "rejected" && rejectedRace.reason instanceof DuplicateTaskMutationError);
    const terminalRaceReceipt = await getTaskForkReplay(task.id, share.id, terminalRaceIdentity);
    assert.ok(terminalRaceReceipt);
    assert.equal(Boolean(await getTask(terminalRaceCopyID)), terminalRaceReceipt.kind === "committed",
      "A certified terminal noncommit can never coexist with a committed copy");
    await assert.rejects(() => forkTask(task.id, { id: randomUUID(), calendarID: share.id }, terminalRaceIdentity), DuplicateTaskMutationError);

    // Recheck authorization inside the mutation transaction, not just API preflight.
    await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, home.id), eq(calendarMembers.userID, owner)));
    await assert.rejects(() => updateTask(task.id, { title: "Revoked grant" }, options(5)), /not permitted/);
    await db.update(calendarMembers).set({ role: "owner" }).where(and(eq(calendarMembers.calendarID, home.id), eq(calendarMembers.userID, owner)));

    const mirror = await createCalendar({ creatorID: owner, name: "Provider", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({
      provider: "google", userID: owner, accountID: "fixture-account", calendarID: mirror.id,
      externalCalendarID: "same-remote-list", supportsEvents: false, supportsTasks: true,
    }).returning();
    const withProvider = await linkTask(task.id, mirror.id, options(5));
    assert.ok(withProvider); assert.equal(withProvider.revision, 6);
    const [createIntent] = await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, task.id), eq(taskOutbox.calendarID, mirror.id)));
    assert.equal(createIntent.action, "create"); assert.equal(createIntent.externalCalendarLinkID, source.id);
    assert.equal(createIntent.accountID, "fixture-account"); assert.equal(createIntent.revision, 6);
    assert.equal(createIntent.payload.task.title, withProvider.title);
    const claimed = await claimTaskOutbox(createIntent.id);
    assert.ok(claimed); assert.equal(claimed.reconciling, false);
    assert.equal(await claimTaskOutbox(createIntent.id), undefined, "Live lease cannot be claimed twice");
    assert.equal(await finishTaskOutbox(createIntent.id, randomUUID(), "completed"), false, "Wrong lease cannot ACK");
    await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, createIntent.id));
    const reclaimed = await claimTaskOutbox(createIntent.id);
    assert.ok(reclaimed); assert.equal(reclaimed.reconciling, true, "Expired CREATE is uncertain and must reconcile before another POST");
    assert.equal(await finishTaskOutbox(createIntent.id, claimed.leaseToken!, "completed"), false, "Old lease cannot ACK after reclaim");
    assert.ok(await finishTaskOutbox(createIntent.id, reclaimed.leaseToken!, "completed", null,
      { resultRef: { externalTaskId: "remote-id", etag: '"v1"' } }));
    await db.insert(externalTasks).values({ taskID: task.id, calendarID: mirror.id, provider: "google", externalCalendarID: source.externalCalendarID,
      externalCalendarLinkID: source.id, accountID: source.accountID, externalTaskID: "remote-id", etag: '"v1"',
      projectionBaseline: { title: withProvider.title }, acceptedRevision: 6 });
    const saved = await updateTask(task.id, { description: "Latest canonical content" }, options(6));
    assert.ok(saved); assert.equal(saved.revision, 7);
    const updateIntent = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, task.id), eq(taskOutbox.revision, 7))))[0];
    assert.equal(updateIntent.predecessorID, createIntent.id);
    assert.equal(updateIntent.externalTaskID, "remote-id"); assert.equal(updateIntent.expectedEtag, '"v1"');
    assert.deepEqual(updateIntent.payload.projectionBaseline, { title: withProvider.title });
    assert.equal((await getDueTaskOutboxIDs()).some((r) => r.id === updateIntent.id), true);
    const updateClaim = await claimTaskOutbox(updateIntent.id); assert.ok(updateClaim);
    assert.deepEqual(await getTaskOutboxExpectedRef(updateClaim), { externalTaskId: "remote-id", etag: '"v1"' });
    assert.ok(await finishTaskOutbox(updateIntent.id, updateClaim.leaseToken!, "completed", null,
      { resultRef: { externalTaskId: "remote-id", etag: '"v2"' } }));

    // A stale provider preflight cannot commit local content or consume mutation ID.
    const staleProof = { calendarID: mirror.id, externalCalendarLinkID: source.id, provider: source.provider,
      userID: owner, accountID: source.accountID, externalCalendarID: source.externalCalendarID, providerAccessRevision: 999 };
    const failedIdentity = options(7);
    await assert.rejects(() => updateTask(task.id, { title: "Must roll back" }, { ...failedIdentity, preparedDestinations: [staleProof] }), /destination changed/);
    assert.equal((await getTask(task.id))?.revision, 7); assert.notEqual((await getTask(task.id))?.title, "Must roll back");
    assert.equal((await db.select().from(taskMutations).where(eq(taskMutations.mutationID, failedIdentity.mutationID))).length, 0);

    // Secondary calendar removal keeps canonical task identity/home. Home removal
    // globally tombstones even if a provider mirror still survives, with DELETE evidence.
    await removeCalendar(other.id);
    assert.ok(await getTask(task.id));
    await removeCalendar(home.id);
    const tombstone = await getTaskSnapshot(task.id); assert.ok(tombstone?.deletedAt);
    assert.equal(tombstone?.originCalendarID, null); assert.equal(tombstone?.calendarID, null);
    assert.equal(tombstone?.revision, 8); assert.equal(await getTask(task.id), null);
    const [deleteIntent] = await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, task.id), eq(taskOutbox.action, "delete")));
    assert.equal(deleteIntent.calendarID, mirror.id); assert.equal(deleteIntent.externalTaskID, "remote-id");
    assert.equal(deleteIntent.predecessorID, updateIntent.id);
    await removeCalendar(mirror.id);
    assert.ok((await getTaskSnapshot(task.id))?.deletedAt, "Orphan tombstone is retained, not FK-cascaded");
    const persistedDelete = await getTaskOutbox(deleteIntent.id);
    assert.equal(persistedDelete?.status, "blocked"); assert.equal(persistedDelete?.externalTaskID, "remote-id");
    assert.equal(persistedDelete?.expectedEtag, '"v1"', "Captured evidence survives mapping removal");

    const secondaryHome = await createCalendar({ creatorID: owner, name: "Native", color: "#112233" });
    const secondary = await createCalendar({ creatorID: owner, name: "Secondary", color: "#112233" });
    const native = await createTask({ id: randomUUID(), creatorID: owner, calendarID: secondaryHome.id, title: "Keep alive" });
    await linkTask(native.id, secondary.id, options(1));
    await removeCalendar(secondary.id);
    const survived = await getTaskSnapshot(native.id); assert.ok(survived); assert.equal(survived.deletedAt, null);
    assert.equal(survived.originCalendarID, secondaryHome.id); assert.equal(survived.revision, 3);
    assert.deepEqual(survived.calendars, [secondaryHome.id]);
    const deleted = await removeTask(native.id, options(3)); assert.ok(deleted?.deletedAt); assert.equal(deleted.revision, 4);
    assert.equal(await removeTask(native.id, options(3)), null);
    assert.equal((await db.select().from(calendarTasks).where(eq(calendarTasks.taskID, native.id))).length, 1,
      "Tombstone retains readable membership and durable identity");

    const survivingMirror = await createCalendar({ creatorID: owner, name: "Surviving account", color: "#112233" });
    const [foreignSource] = await db.insert(externalCalendars).values({
      provider: "google", userID: owner, accountID: "foreign-owner-account", calendarID: survivingMirror.id,
      externalCalendarID: "foreign-list", supportsEvents: false, supportsTasks: true,
    }).returning();
    await db.update(calendarMembers).set({ role: "editor" }).where(and(eq(calendarMembers.calendarID, share.id), eq(calendarMembers.userID, owner)));
    const foreignCreator = await createTask({ id: randomUUID(), creatorID: owner, calendarID: share.id, title: "Foreign creator, removed home" });
    const purgedCreator = await createTask({ id: randomUUID(), creatorID: secondaryOwner, calendarID: share.id, title: "Removed creator" });
    for (const sourceTask of [foreignCreator, purgedCreator]) {
      await linkTask(sourceTask.id, survivingMirror.id, options(1));
      await db.insert(externalTasks).values({ taskID: sourceTask.id, calendarID: survivingMirror.id, provider: "google",
        externalCalendarID: "foreign-list", externalCalendarLinkID: foreignSource.id, accountID: foreignSource.accountID,
        externalTaskID: `remote-${sourceTask.id}`, etag: '"foreign-v1"' });
    }
    await deleteUserWithCalendarRevisions(secondaryOwner);
    assert.ok((await getTaskSnapshot(foreignCreator.id))?.deletedAt, "Removing home owner tombstones another creator's shared task");
    assert.equal((await getTaskSnapshot(foreignCreator.id))?.originCalendarID, null);
    assert.equal(await getTaskSnapshot(purgedCreator.id), null, "Creator removal retains existing account-purge policy");
    for (const taskID of [foreignCreator.id, purgedCreator.id]) {
      const deletion = (await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, taskID), eq(taskOutbox.action, "delete"))))[0];
      assert.ok(deletion); assert.equal(deletion.userID, owner);
      assert.equal(deletion.externalTaskID, `remote-${taskID}`, "Foreign provider DELETE evidence survives creator/home owner removal");
    }

    const safeHome = await createCalendar({ creatorID: owner, name: "Readable home", color: "#112233" });
    const retiredMirror = await createCalendar({ creatorID: owner, name: "Retired read projection", color: "#112233" });
    const forkTarget = await createCalendar({ creatorID: viewer, name: "Viewer's writable target", color: "#112233" });
    const [retiredSource] = await db.insert(externalCalendars).values({ provider: "caldav", userID: owner,
      accountID: "retired-account", calendarID: retiredMirror.id, externalCalendarID: "retired-collection",
      supportsTasks: true, providerAccessRole: "caldav:read=yes;freebusy=yes" }).returning();
    await db.insert(calendarMembers).values({ userID: viewer, calendarID: retiredMirror.id, role: "viewer" });
    const privateTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: safeHome.id, title: "Canonical stays private" });
    await linkTask(privateTask.id, retiredMirror.id, options(1));
    assert.ok(await getUserTask(viewer, privateTask.id));
    await db.update(externalCalendars).set({ providerAccessRole: "caldav:read=no;freebusy=yes" }).where(eq(externalCalendars.id, retiredSource.id));
    assert.equal(await getUserTask(viewer, privateTask.id), null, "Retired source cannot grant canonical content through its secondary membership");
    assert.equal((await getUserTasks(viewer)).some(task => task.id === privateTask.id), false);
    assert.equal((await getUserTask(owner, privateTask.id))?.title, "Canonical stays private", "Other readable links preserve canonical content");
    await assert.rejects(() => forkTask(privateTask.id, { id: randomUUID(), calendarID: forkTarget.id }, options(2, viewer)), /not accessible/);
    await assert.rejects(() => linkTask(privateTask.id, forkTarget.id, options(2, viewer)), /not accessible/);
    await db.update(externalCalendars).set({ providerAccessRole: "caldav:read=yes;freebusy=yes", disabled: true }).where(eq(externalCalendars.id, retiredSource.id));
    assert.equal(await getUserTask(viewer, privateTask.id), null, "Disabled source cannot grant canonical reads");

    const recoveryHome = await createCalendar({ creatorID: owner, name: "Read recovery", color: "#112233" });
    const recoveryTask = await createTask({ id: randomUUID(), creatorID: owner, calendarID: recoveryHome.id, title: "Original native content" });
    const [recoverySource] = await db.insert(externalCalendars).values({ provider: "caldav", userID: owner,
      accountID: "recovery-account", calendarID: recoveryHome.id, externalCalendarID: "recovery-collection",
      supportsTasks: true, providerAccessRevision: 2, providerAccessRole: "caldav:read=yes;freebusy=yes" }).returning();
    await db.insert(externalTasks).values({ provider: "caldav", taskID: recoveryTask.id, calendarID: recoveryHome.id,
      externalCalendarID: recoverySource.externalCalendarID, externalTaskID: "recovery.ics",
      externalCalendarLinkID: recoverySource.id, accountID: recoverySource.accountID,
      providerAccessRevision: 0, etag: null, projectionBaseline: null });
    await db.update(tasks).set({ title: "Private task", description: null, revision: 2, providerReadRetiredGeneration: 1 }).where(eq(tasks.id, recoveryTask.id));
    await db.insert(calendarMembers).values({ userID: viewer, calendarID: recoveryHome.id, role: "viewer" });
    const beforeRehydrate = await getUserTask(owner, recoveryTask.id);
    assert.ok(beforeRehydrate); assert.equal(beforeRehydrate.canEdit, false);
    assert.equal(beforeRehydrate.canShareContent, false);
    assert.equal(beforeRehydrate.canDelete, true, "Safe local deletion depends on home rights, not a writable redacted body");
    await assert.rejects(() => updateTask(recoveryTask.id, { status: "completed" }, { ...options(2), expectedProviderReadRetiredGeneration: 1 }),
      /Refresh the task home/, "Restored read grant alone cannot send the privacy placeholder back to its native home");
    const viewerRecoveryOptions = { ...options(2, viewer), expectedProviderReadRetiredGeneration: 1 };
    await assert.rejects(() => linkTask(recoveryTask.id, forkTarget.id, viewerRecoveryOptions), /Refresh the task home/);
    await assert.rejects(() => forkTask(recoveryTask.id, { id: randomUUID(), calendarID: forkTarget.id },
      { ...viewerRecoveryOptions, mutationID: randomUUID() }), /Refresh the task home/);
    assert.equal((await getTask(recoveryTask.id))?.revision, 2);
    // Observation blocked by a current pending intent may update its remote
    // validator, but cannot certify that canonical private content was restored.
    const blockedRecoveryID = randomUUID();
    const baseIntent = { actorID: owner, mutationID: randomUUID(), position: 0, taskID: recoveryTask.id,
      revision: 2, calendarID: recoveryHome.id, externalCalendarLinkID: recoverySource.id, provider: "caldav",
      userID: owner, accountID: recoverySource.accountID, externalCalendarID: recoverySource.externalCalendarID,
      providerAccessRevision: 2, retiredGeneration: 1, action: "update" as const,
      payload: { task: taskOutboxSnapshot(beforeRehydrate, [recoveryHome.id]) } };
    await db.insert(taskOutbox).values({ ...baseIntent, id: blockedRecoveryID, status: "blocked", uncertain: true });
    const restoredValues = { title: "Recovered native title", description: "Recovered notes", status: "needs-action" as const,
      start: null, due: null, isAllDay: false, completedAt: null, percentComplete: 0, priority: 0,
      recurrence: null, relatedTo: null, sequence: 1, url: null };
    const recoveryScope = { sourceID: recoverySource.id, accountID: recoverySource.accountID, providerAccessRevision: 2 };
    await upsertExternalTask("caldav", owner, recoveryHome.id, recoverySource.externalCalendarID, "recovery.ics", restoredValues,
      '"fresh-home"', "recovery-uid", undefined, recoveryScope, { title: restoredValues.title });
    assert.equal((await getUserTask(owner, recoveryTask.id))?.canEdit, false, "Blocked observation is not canonical rehydration proof");
    assert.equal((await getTask(recoveryTask.id))?.title, "Private task");
    await db.update(taskOutbox).set({ status: "not-needed", uncertain: false }).where(eq(taskOutbox.id, blockedRecoveryID));
    await upsertExternalTask("caldav", owner, recoveryHome.id, recoverySource.externalCalendarID, "recovery.ics", restoredValues,
      '"fresh-home"', "recovery-uid", undefined, recoveryScope, { title: restoredValues.title });
    const rehydrated = await getUserTask(owner, recoveryTask.id); assert.ok(rehydrated);
    assert.equal(rehydrated.title, restoredValues.title); assert.equal(rehydrated.canEdit, true);
    assert.equal(rehydrated.canShareContent, true);
    assert.equal(rehydrated.revision, 3, "Same-ETag authorized pull must still restore a previously unaccepted origin snapshot");
    const sharedRecovered = await getUserTask(viewer, recoveryTask.id); assert.ok(sharedRecovered);
    assert.equal(sharedRecovered.canEdit, false); assert.equal(sharedRecovered.canShareContent, true);
    const recoveredFork = await forkTask(recoveryTask.id, { id: randomUUID(), calendarID: forkTarget.id },
      { ...options(3, viewer), expectedProviderReadRetiredGeneration: 1 });
    assert.equal(recoveredFork?.title, restoredValues.title, "Readonly home membership can share a restored real snapshot");
    assert.ok(await updateTask(recoveryTask.id, { status: "completed", percentComplete: 100 },
      { ...options(3), expectedProviderReadRetiredGeneration: 1 }));

    const queueTask = await db.transaction(async tx => {
      await lockCalendarLifecycle(tx, [recoveryHome.id], "shared");
      return createTaskInTransaction(tx, { id: randomUUID(), creatorID: owner, calendarID: recoveryHome.id, title: "Queue evidence" });
    });
    const wireQueue = taskOutboxSnapshot(queueTask, queueTask.calendars);
    const queueBase = { ...baseIntent, taskID: queueTask.id, revision: 1, retiredGeneration: 0, providerAccessRevision: 0,
      payload: { task: wireQueue, projectionBaseline: { title: "Old accepted baseline" } } };
    const provenID = randomUUID(), skippedID = randomUUID(), successorID = randomUUID();
    await db.insert(taskOutbox).values([
      { ...queueBase, id: provenID, mutationID: randomUUID(), status: "completed", resultRef: { externalTaskId: "paired-address", etag: '"paired-v2"' }, remoteSnapshot: { title: "Accepted predecessor" } },
      { ...queueBase, id: skippedID, mutationID: randomUUID(), status: "not-needed", predecessorID: provenID },
      { ...queueBase, id: successorID, mutationID: randomUUID(), predecessorID: skippedID, action: "delete" },
    ]);
    assert.deepEqual(await getTaskOutboxPredecessorEvidence((await getTaskOutbox(successorID))!), {
      ref: { externalTaskId: "paired-address", etag: '"paired-v2"' }, projectionBaseline: { title: "Accepted predecessor" },
    }, "Skipped operation cannot mix a new validator with an older projection baseline");
    await db.delete(taskOutbox).where(eq(taskOutbox.taskID, queueTask.id));
    for (const status of ["blocked", "not-written", "retry", "pending"] as const) {
      const staleID = randomUUID();
      await db.insert(taskOutbox).values({ ...queueBase, id: staleID, mutationID: randomUUID(), action: "create", status, uncertain: false });
      const prepared = await db.transaction(async tx => {
        await lockCalendarLifecycle(tx, [recoveryHome.id], "shared");
        await tx.select().from(tasks).where(eq(tasks.id, queueTask.id)).for("update");
        const writes = await prepareTaskOutboxInTransaction(tx, wireQueue, [{ calendarID: recoveryHome.id, action: "update" }],
          { actorID: owner, mutationID: randomUUID() });
        assert.equal(writes[0].action, "create", `A proven stale ${status} CREATE cannot turn fresh recovery into an addressless UPDATE`);
        await appendTaskOutbox(tx, wireQueue, writes);
        return writes;
      });
      assert.equal((await getTaskOutbox(staleID))?.status, "cancelled");
      assert.equal((await getTaskOutbox(prepared[0].id))?.predecessorID, null, `Fresh generation has no stale ${status} barrier`);
      await db.delete(taskOutbox).where(eq(taskOutbox.taskID, queueTask.id));
    }
    const staleCreateID = randomUUID(), staleSuccessorID = randomUUID();
    await db.insert(taskOutbox).values([
      { ...queueBase, id: staleCreateID, mutationID: randomUUID(), action: "create", status: "blocked", uncertain: false },
      { ...queueBase, id: staleSuccessorID, mutationID: randomUUID(), revision: 2, action: "update", status: "pending", attempts: 0, uncertain: false, predecessorID: staleCreateID },
    ]);
    const [freshSuccessor] = await db.transaction(async tx => {
      await lockCalendarLifecycle(tx, [recoveryHome.id], "shared");
      await tx.select().from(tasks).where(eq(tasks.id, queueTask.id)).for("update");
      const writes = await prepareTaskOutboxInTransaction(tx, wireQueue, [{ calendarID: recoveryHome.id, action: "update" }],
        { actorID: owner, mutationID: randomUUID() });
      await appendTaskOutbox(tx, wireQueue, writes);
      return writes;
    });
    assert.equal((await getTaskOutbox(staleCreateID))?.status, "cancelled");
    assert.equal((await getTaskOutbox(staleSuccessorID))?.status, "cancelled", "Never-attempted obsolete successors do not inherit a cancelled barrier");
    assert.equal((await getTaskOutbox(freshSuccessor.id))?.predecessorID, null);
    assert.ok(await claimTaskOutbox(freshSuccessor.id), "Fresh work can run after an entirely proven-not-written obsolete chain");
    await db.delete(taskOutbox).where(eq(taskOutbox.taskID, queueTask.id));
    const unknownID = randomUUID();
    await db.insert(taskOutbox).values({ ...queueBase, id: unknownID, mutationID: randomUUID(), action: "create", status: "blocked", uncertain: true });
    const blocked = await db.transaction(async tx => {
      await lockCalendarLifecycle(tx, [recoveryHome.id], "shared");
      await tx.select().from(tasks).where(eq(tasks.id, queueTask.id)).for("update");
      const writes = await prepareTaskOutboxInTransaction(tx, wireQueue, [{ calendarID: recoveryHome.id, action: "update" }],
        { actorID: owner, mutationID: randomUUID() });
      assert.equal(writes[0].action, "update", "An uncertain prior CREATE must never cause another CREATE");
      await appendTaskOutbox(tx, wireQueue, writes);
      return writes;
    });
    assert.equal((await getTaskOutbox(unknownID))?.status, "blocked");
    assert.equal((await getTaskOutbox(blocked[0].id))?.predecessorID, unknownID);
    console.log("Shared task membership, origin authority, CAS, durable delivery and lifecycle self-check: OK");
  } finally {
    await db.delete(taskOutbox).where(inUserIDs(taskOutbox.actorID, [owner, secondaryOwner, viewer]));
    await db.delete(user).where(inUserIDs(user.id, [owner, secondaryOwner, viewer]));
  }
}
function inUserIDs(column: typeof user.id | typeof taskOutbox.actorID, ids: string[]) { return sql`${column} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`; }
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
