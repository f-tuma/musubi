import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { account, CALENDAR_SCOPE, claimEventOutbox, commitEventDeliveryResolution, createEvent, db, eventOutbox, getEvent, importExternalCalendar, importExternalEvent, patchEventAndCalendarLinks, requestEventDeliveryRetry, user } from '@musubi/db';
import { EventSchema } from '@musubi/types';
import { microsoftAdapter } from './adapters/microsoft';
import { prepareEventDeliveryResolution } from './event_resolution';
import { prepareEventWrites } from './engine';
import { deliverEventOutbox } from './event_delivery';

async function main() {
  assert.equal(process.env.ENVIRONMENT, 'test');
  const owner = `outlook-delete-${randomUUID()}`, originalFetch = globalThis.fetch;
  type Native = ReturnType<typeof nativeEvent>;
  function nativeEvent(id: string) {
    return { id, '@odata.etag': 'W/"version-1"', subject: 'Disposable personal event', type: 'singleInstance', isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, attendees: [] as unknown[], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, isAllDay: false, start: { dateTime: '2026-09-28T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-28T11:00:00', timeZone: 'UTC' }, body: { contentType: 'text', content: '' }, location: { displayName: '' } };
  }
  const remote = new Map<string, Native>();
  let deletes = 0, mode = 'normal';
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = (async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.microsoft.com', 'fixture cannot access real providers');
    if (url.pathname === '/v1.0/me') return response({ id: 'me', mail: 'owner@example.test' });
    if (url.pathname === '/v1.0/me/calendars/remote-calendar') return response({ id: 'remote-calendar', canEdit: true, owner: { address: 'owner@example.test' } });
    assert.match(url.pathname, /^\/v1\.0\/me\/calendars\/remote-calendar\/events\/[^/]+$/);
    const id = url.pathname.substring(url.pathname.lastIndexOf('/') + 1), native = remote.get(id);
    if (!options.method || options.method === 'GET') return response(native ?? {}, native ? 200 : 404);
    assert.equal(options.method, 'DELETE'); deletes++;
    assert.equal(new Headers(options.headers).get('If-Match'), native?.['@odata.etag']);
    if (mode !== 'lost-retained' && mode !== 'retained') remote.delete(id);
    if (mode.startsWith('lost-')) throw new TypeError('Simulated lost response');
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  try {
    await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: 'microsoft', accountId: owner, accessToken: 'fixture-token', refreshToken: 'fixture-refresh', scope: CALENDAR_SCOPE.microsoft, accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
    const calendar = await importExternalCalendar('microsoft', owner, owner, 'fixture', { externalId: 'remote-calendar', name: 'Outlook fixture', color: '#123456' });
    async function seed() {
      const native = nativeEvent(randomUUID()); remote.set(native.id, native);
      const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: '', title: native.subject, start: '2026-09-28T10:00:00Z', end: '2026-09-28T11:00:00Z', isAllDay: false, isCanceled: false, color: '#123456', originCalendarID: calendar.id, calendars: [calendar.id] });
      await createEvent(event, event.calendars);
      await importExternalEvent('microsoft', event.id, calendar.id, 'remote-calendar', native.id, native['@odata.etag']);
      return { event: { ...(await getEvent(event.id)), calendars: [calendar.id] }, native };
    }
    async function enqueue(item: Awaited<ReturnType<typeof seed>>) {
      const prepared = await prepareEventWrites([{ action: 'delete', calendarIDs: [calendar.id], event: item.event }], { actorID: owner, mutationID: randomUUID() });
      await patchEventAndCalendarLinks(item.event.id, item.event.revision!, { calendars: [] }, true, prepared.outbox);
      return prepared.outbox[0]!.id!;
    }
    const run = (id: string) => deliverEventOutbox(id, () => microsoftAdapter);
    const due = (id: string) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, id));
    async function resolve(item: Awaited<ReturnType<typeof seed>>, id: string) {
      const { preview, proof } = await prepareEventDeliveryResolution(owner, item.event.id, id, () => microsoftAdapter);
      assert.equal(preview.canResolve, true); assert.equal(preview.action, 'delete');
      return commitEventDeliveryResolution(owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: preview.remote !== null, expectedRemoteEtag: preview.remoteEtag });
    }

    const success = await seed(), successID = await enqueue(success);
    assert.equal((await run(successID))?.status, 'completed');
    assert.equal(remote.has(success.native.id), false); assert.equal(deletes, 1);

    const stale = await seed(); stale.native['@odata.etag'] = 'W/"changed-before-save"';
    await assert.rejects(() => enqueue(stale), /provider-conflict/);
    assert.equal((await getEvent(stale.event.id)).revision, stale.event.revision, 'refusal precedes local deletion');
    const meeting = await seed(); meeting.native.attendees = [{}];
    await assert.rejects(() => enqueue(meeting), /Delete meetings/);
    assert.equal((await getEvent(meeting.event.id)).revision, meeting.event.revision);
    const race = await seed(), raceID = await enqueue(race);
    race.native['@odata.etag'] = 'W/"changed-after-admission"';
    const beforeRace = deletes;
    assert.equal((await run(raceID))?.status, 'conflict');
    assert.equal(deletes, beforeRace, 'worker checks the version again before DELETE');

    const lost = await seed(), lostID = await enqueue(lost); mode = 'lost-accepted';
    assert.equal((await run(lostID))?.status, 'unconfirmed');
    const afterLost = deletes; mode = 'normal'; await due(lostID);
    assert.equal((await run(lostID))?.status, 'completed');
    assert.equal(deletes, afterLost, 'lost success is recovered by a read');

    const retained = await seed(), retainedID = await enqueue(retained); mode = 'lost-retained';
    assert.equal((await run(retainedID))?.status, 'unconfirmed');
    const afterRetained = deletes; mode = 'normal';
    await requestEventDeliveryRetry(owner, retained.event.id, retainedID);
    await due(retainedID);
    assert.equal((await run(retainedID))?.status, 'unconfirmed');
    assert.equal(deletes, afterRetained, 'unchanged version never authorizes an automatic resend');
    await assert.rejects(() => requestEventDeliveryRetry(owner, retained.event.id, retainedID), (error: any) => error.code === 'delivery-conflict-unresolved');
    assert.equal(deletes, afterRetained, 'a saved remote comparison requires explicit resolution');
    const confirmedID = await resolve(retained, retainedID);
    assert.equal((await run(confirmedID))?.status, 'completed');
    assert.equal(deletes, afterRetained + 1, 'a fresh explicit comparison authorizes one new attempt');

    const crash = await seed(), crashID = await enqueue(crash);
    assert.ok(await claimEventOutbox(crashID));
    await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, crashID));
    const beforeCrashRecovery = deletes;
    assert.equal((await run(crashID))?.status, 'unconfirmed');
    assert.equal(deletes, beforeCrashRecovery, 'restart after durable claim cannot send blindly');
    const crashResolution = await resolve(crash, crashID); mode = 'lost-retained';
    assert.equal((await run(crashResolution))?.status, 'unconfirmed');
    const afterResolution = deletes; mode = 'normal'; await due(crashResolution);
    assert.equal((await run(crashResolution))?.status, 'unconfirmed');
    assert.equal(deletes, afterResolution, 'the explicit resolution bypass is first attempt only');

    const crashedResolution = await resolve(crash, crashResolution);
    assert.ok(await claimEventOutbox(crashedResolution));
    await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, crashedResolution));
    assert.equal((await run(crashedResolution))?.status, 'unconfirmed');
    assert.equal(deletes, afterResolution, 'an explicit resolution interrupted by restart is read-only too');
    console.log('Outlook guarded delete DB flow: admission, stale versions, lost response, read-only retry, crash recovery and explicit new intent: OK');
  } finally { globalThis.fetch = originalFetch; await db.delete(user).where(eq(user.id, owner)); }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
