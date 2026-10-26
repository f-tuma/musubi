import assert from "node:assert/strict";
import { createServer } from "node:http";
import { config } from "@musubi/config";
import { googleRsvpMethods } from "./google_rsvp_delivery";
import type { GoogleRsvpEvidence } from "./google_rsvp";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const before = { id: "event/id", etag: '\"v1\"', status: "confirmed", summary: "Meeting", start: { date: "2026-09-08" }, end: { date: "2026-09-09" }, organizer: { email: "host@example.test" }, attendees: [{ email: "guest@example.test", self: true, responseStatus: "needsAction", comment: "keep" }, { email: "other@example.test", responseStatus: "accepted" }], conferenceData: { conferenceId: "keep" }, reminders: { useDefault: true } };
  let remote: typeof before & { recurringEventId?: string; originalStartTime?: { date: string } } = structuredClone(before), mode = "normal", patches = 0, reads = 0, tokens = 0, started = false;
  let primary: any = { id: "guest@example.test", primary: true, accessRole: "owner" };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-rsvp-token");
    if (req.url === "/calendar/v3/users/me/calendarList/primary") {
      if (mode === "redirect") { res.writeHead(302, { location: "/leak" }); res.end(); return; }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(primary)); return;
    }
    assert.ok(req.url?.startsWith("/calendar/v3/calendars/guest%40example.test/events/event%2Fid"));
    if (req.method === "GET") {
      reads++;
      if (mode === "partial") res.writeHead(206, { "content-range": "bytes 0-10/500" });
      res.end(JSON.stringify(remote)); return;
    }
    assert.equal(req.method, "PATCH"); patches++;
    assert.equal(req.url, "/calendar/v3/calendars/guest%40example.test/events/event%2Fid?sendUpdates=all&conferenceDataVersion=1");
    assert.equal(req.headers["if-match"], before.etag);
    let body = ""; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { attendeesOmitted: true, attendees: [{ email: "guest@example.test", responseStatus: "accepted" }] });
    if (mode === "race") { remote.summary = "Concurrent"; remote.etag = '\"raced\"'; }
    if (remote.etag !== req.headers["if-match"]) { res.writeHead(412); res.end(); return; }
    if (mode === "unapplied") { res.writeHead(503); res.end(); return; }
    remote.attendees[0]!.responseStatus = "accepted"; remote.etag = '\"v2\"';
    if (mode === "changed-after") remote.conferenceData.conferenceId = "changed";
    if (mode === "lost") { req.socket.destroy(); return; }
    if (mode === "applied-503") { res.writeHead(503); res.end(); return; }
    res.writeHead(200); res.end(JSON.stringify({ id: remote.id, attendeesOmitted: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(init?.redirect, "error");
    return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init).then(async result => {
      if (mode === "body-error" && init?.method === "PATCH") {
        await result.body?.cancel();
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("successful body stream lost")); } }), { status: 200 });
      }
      return result;
    });
  };
  const savedFlag = config.api.providerRsvpEditsEnabled;
  const adapter = googleRsvpMethods(async (user, account) => { assert.equal(user, "user"); assert.equal(account, "account"); tokens++; return "synthetic-rsvp-token"; });
  const ref = { externalEventId: before.id, etag: before.etag };
  const read = () => adapter.readRsvp!("user", "account", "guest@example.test", ref, "accepted");
  const write = (evidence: GoogleRsvpEvidence) => adapter.writeRsvp!("user", "account", "guest@example.test", evidence, { sendUpdates: "all", observeOnly: started }, undefined, async () => { assert.equal(started, false); started = true; });
  try {
    config.api.providerRsvpEditsEnabled = false;
    await assert.rejects(read); assert.equal(tokens, 0); assert.equal(reads, 0);
    config.api.providerRsvpEditsEnabled = true;
    for (const scenario of ["normal", "body-error", "lost", "applied-503", "unapplied", "race", "changed-after"]) {
      mode = "normal"; remote = structuredClone(before); patches = 0; started = false;
      const evidence = await read(); mode = scenario;
      if (scenario === "normal" || scenario === "body-error") {
        assert.deepEqual(await write(evidence), { etag: '\"v2\"', recovered: false, notificationDelivery: "unknown" });
        assert.deepEqual(await write(evidence), { etag: '\"v2\"', recovered: true, notificationDelivery: "unknown" });
        assert.equal(patches, 1);
      } else {
        await assert.rejects(() => write(evidence)); assert.equal(patches, 1);
        mode = "normal";
        if (scenario === "lost" || scenario === "applied-503") { assert.equal((await write(evidence)).recovered, true); assert.equal(patches, 1); }
        else if (scenario === "unapplied") { await assert.rejects(() => write(evidence)); assert.equal(patches, 1); }
        else { await assert.rejects(() => write(evidence)); assert.equal(patches, 1); }
      }
    }
    for (const scenario of ["normal", "lost", "applied-503", "race", "changed-after"]) {
      mode = "normal"; patches = 0; started = false;
      remote = { ...structuredClone(before), recurringEventId: "master", originalStartTime: { date: "2026-09-07" } };
      const occurrence = { externalSeriesID: "master", originalStart: { kind: "date" as const, value: "2026-09-07" } };
      await assert.rejects(read); assert.equal(patches, 0);
      const evidence = await adapter.readRsvp!("user", "account", "guest@example.test", ref, "accepted", undefined, occurrence);
      assert.deepEqual(evidence.occurrence, occurrence);
      await assert.rejects(() => write({ ...evidence, occurrence: undefined }));
      await assert.rejects(() => write({ ...evidence, occurrence: { ...occurrence, externalSeriesID: "other" } }));
      assert.equal(patches, 0);
      mode = scenario;
      if (scenario === "normal") await write(evidence);
      else await assert.rejects(() => write(evidence));
      assert.equal(patches, 1);
      mode = "normal";
      if (["normal", "lost", "applied-503"].includes(scenario)) {
        assert.equal((await write(evidence)).recovered, true);
        const preview = await adapter.readRsvpResolution!("user", "account", "guest@example.test", ref, "declined", undefined, occurrence);
        assert.equal(preview.baseline.etag, remote.etag);
        assert.deepEqual(preview.occurrence, occurrence);
        remote.originalStartTime = { date: "2026-09-06" };
        await assert.rejects(() => write(evidence));
      } else await assert.rejects(() => write(evidence));
      assert.equal(patches, 1);
    }
    mode = "normal"; remote = structuredClone(before); patches = 0; started = false;
    const evidence = await read();
    remote.attendees[1]!.responseStatus = "declined"; // Even a broken unchanged ETag cannot hide native drift.
    await assert.rejects(() => write(evidence)); assert.equal(patches, 0);
    remote = structuredClone(before);
    for (const invalid of [{ ...primary, primary: false }, { ...primary, accessRole: "writer" }, { ...primary, id: "other@example.test" }, {}]) {
      const saved = primary; primary = invalid; await assert.rejects(read); primary = saved;
    }
    for (const scenario of ["redirect", "partial"]) { mode = scenario; await assert.rejects(read); }
    mode = "normal";
    const failing = googleRsvpMethods(async () => { throw new Error("OAuth grant unavailable"); });
    const previousReads = reads;
    await assert.rejects(() => failing.readRsvp!("user", "account", "guest@example.test", ref, "accepted")); assert.equal(reads, previousReads);
    config.api.providerRsvpEditsEnabled = false;
    const previousTokens = tokens;
    await assert.rejects(() => write(evidence)); assert.equal(tokens, previousTokens); assert.equal(patches, 0);
    console.log("Google RSVP fake HTTP: primary identity, flag, exact conditional PATCH, recovery and preservation refusals: OK");
  } finally { config.api.providerRsvpEditsEnabled = savedFlag; globalThis.fetch = realFetch; await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
