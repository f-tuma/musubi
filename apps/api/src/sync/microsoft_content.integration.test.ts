import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { account, CALENDAR_SCOPE, createEvent, db, eventOutbox, getEvent, getExternalEvent, importExternalCalendar, importExternalEvent, patchEventAndCalendarLinks, user } from '@musubi/db';
import { EventSchema } from '@musubi/types';
import { microsoftAdapter } from './adapters/microsoft';
import { prepareEventDeliveryResolution } from './event_resolution';
import { prepareEventWrites } from './engine';
import { deliverEventOutbox } from './event_delivery';

async function main() {
  assert.equal(process.env.ENVIRONMENT, 'test');
  const owner = `outlook-content-${randomUUID()}`;
  const originalFetch = globalThis.fetch;
  let patches = 0, version = 1, mode = 'normal';
  const native = { id: 'remote-event', '@odata.etag': 'W/"version-1"', subject: 'Before', type: 'singleInstance', isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, isAllDay: false, start: { dateTime: '2026-09-28T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-28T11:00:00', timeZone: 'UTC' }, body: { contentType: 'text', content: 'Keep notes' }, location: { displayName: 'Keep room' } };
  const bump = () => { native['@odata.etag'] = `W/"version-${++version}"`; };
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  globalThis.fetch = (async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.microsoft.com', 'fixture cannot access real providers');
    if (url.pathname === '/v1.0/me') return response({ id: 'me', mail: 'owner@example.test' });
    if (url.pathname === '/v1.0/me/calendars/remote-calendar') return response({ id: 'remote-calendar', canEdit: true, owner: { address: 'owner@example.test' } });
    assert.equal(url.pathname, '/v1.0/me/calendars/remote-calendar/events/remote-event');
    if (!options.method || options.method === 'GET') return response(native);
    assert.equal(options.method, 'PATCH', 'DELETE must never reach transport');
    patches++;
    if (mode === 'race') { native.subject = 'Concurrent Outlook edit'; bump(); }
    if ((options.headers as Record<string, string>)['If-Match'] !== native['@odata.etag']) return response({}, 412);
    Object.assign(native, JSON.parse(String(options.body))); bump();
    if (mode === 'lost') throw new TypeError('Simulated lost response');
    return response(native);
  }) as typeof fetch;
  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
  try {
    await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: 'microsoft', accountId: owner, accessToken: 'fixture-token', refreshToken: 'fixture-refresh', scope: CALENDAR_SCOPE.microsoft, accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
    const calendar = await importExternalCalendar('microsoft', owner, owner, 'fixture', { externalId: 'remote-calendar', name: 'Outlook fixture', color: '#123456' });
    const initial = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: '', title: 'Before', description: 'Keep notes', location: 'Keep room', start: '2026-09-28T10:00:00Z', end: '2026-09-28T11:00:00Z', isAllDay: false, isCanceled: false, color: '#123456', originCalendarID: calendar.id, calendars: [calendar.id] });
    await createEvent(initial, initial.calendars);
    await importExternalEvent('microsoft', initial.id, calendar.id, 'remote-calendar', native.id, native['@odata.etag']);
    const current = async () => ({ ...(await getEvent(initial.id)), calendars: [calendar.id] });
    async function prepare(title: string) {
      const previous = await current();
      return prepareEventWrites([{ action: 'update', calendarIDs: [calendar.id], event: { ...previous, title }, previous, patch: { title } }], { actorID: owner, mutationID: randomUUID() });
    }
    async function enqueue(title: string) {
      const previous = await current(); const prepared = await prepare(title);
      await patchEventAndCalendarLinks(initial.id, previous.revision!, { title }, false, prepared.outbox);
      return prepared.outbox[0]!.id!;
    }
    const success = await enqueue('Updated in Musubi');
    assert.equal((await deliverEventOutbox(success, () => microsoftAdapter))?.status, 'completed');
    assert.equal(native.subject, 'Updated in Musubi');
    assert.equal(native.body.content, 'Keep notes'); assert.equal(native.location.displayName, 'Keep room');
    assert.equal((await getExternalEvent('microsoft', initial.id, 'remote-calendar', calendar.id))?.etag, native['@odata.etag']);
    // All preflight refusals must precede any local patch or outbox admission.
    const before = await current();
    await assert.rejects(() => prepareEventWrites([{ action: 'update', calendarIDs: [calendar.id], event: { ...before, start: new Date() }, previous: before, patch: { start: new Date() } }]), /Make other changes in Outlook/);
    native['@odata.etag'] = 'W/"concurrent-before-save"';
    await assert.rejects(() => prepare('Should not be saved'), /provider-conflict/);
    await assert.rejects(() => prepareEventWrites([{ action: 'delete', calendarIDs: [calendar.id], event: before }]), /provider-conflict/);
    assert.equal((await getEvent(initial.id)).revision, before.revision);
    native['@odata.etag'] = (await getExternalEvent('microsoft', initial.id, 'remote-calendar', calendar.id))!.etag!;
    const lost = await enqueue('Accepted but response lost'); mode = 'lost';
    assert.equal((await deliverEventOutbox(lost, () => microsoftAdapter))?.status, 'unconfirmed');
    const afterLost = patches; mode = 'normal';
    await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, lost));
    assert.equal((await deliverEventOutbox(lost, () => microsoftAdapter))?.status, 'completed');
    assert.equal(patches, afterLost, 'recovery observes accepted content instead of resending');
    const race = await enqueue('Must not overwrite'); mode = 'race';
    assert.equal((await deliverEventOutbox(race, () => microsoftAdapter))?.status, 'conflict');
    assert.equal(native.subject, 'Concurrent Outlook edit');
    mode = 'normal';
    const resolution = await prepareEventDeliveryResolution(owner, initial.id, race, () => microsoftAdapter);
    assert.equal(resolution.preview.reason, null, 'an explicit conflict preview accepts Graph PATCH versions');
    console.log('Outlook content DB flow: admission, exact mapping, stale deletion/time refusals, stale preflight, lost response reconciliation and concurrent-write conflict passed.');
  } finally { globalThis.fetch = originalFetch; await db.delete(user).where(eq(user.id, owner)); }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
