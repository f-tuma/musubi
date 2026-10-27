import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { AnnouncementsResponseSchema } from "@musubi/types";
import { createGetAnnouncementsHandler } from "./announcements";
import { ProjectNewsUnavailable } from "../project-news";

function recorder() {
  let status = 0, body: unknown;
  const response = { status(code: number) { status = code; return response; }, json(value: unknown) { body = value; return response; } };
  return { response: response as unknown as Response, result: () => ({ status, body }) };
}
const request = { user: { id: "news-user" } } as Request;
const items = ["2026-10-27", "2026-10-26"].map(id => ({ id, title: id, body: "Project news", minVersion: null }));
async function run() {
  {
    const r = recorder();
    await createGetAnnouncementsHandler({
      getSettings: async () => ({ lastSeenProjectNews: "2026-10-26" }), read: async () => items,
      initialize: async () => { assert.fail("Existing source marker cannot be reinitialized"); },
    })(request, r.response);
    assert.equal(r.result().status, 200);
    assert.deepEqual(AnnouncementsResponseSchema.parse(r.result().body), { announcements: [items[0]], isAdmin: false });
  }
  {
    const r = recorder(); let initialized = 0;
    await createGetAnnouncementsHandler({
      getSettings: async () => ({ lastSeenProjectNews: "", lastSeenAnnouncement: "2099-12-31-9" }), read: async () => items,
      initialize: async (user, marker) => { assert.equal(user, request.user!.id); assert.equal(marker, "2026-10-27"); initialized++; return { initialized: true, settings: { lastSeenProjectNews: marker } }; },
    })(request, r.response);
    assert.equal(initialized, 1);
    assert.deepEqual(AnnouncementsResponseSchema.parse(r.result().body), { announcements: [], isAdmin: false, markTo: "2026-10-27" });
  }
  {
    const r = recorder();
    await createGetAnnouncementsHandler({
      getSettings: async () => ({ lastSeenProjectNews: "" }), read: async () => { throw new ProjectNewsUnavailable(); },
      initialize: async () => { assert.fail("Failed source fetch cannot mark news read"); },
    })(request, r.response);
    assert.equal(r.result().status, 503);
    assert.equal(Object.prototype.hasOwnProperty.call(r.result().body, "markTo"), false);
  }
  console.log("Project news compatibility handler tests passed");
}
void run();
