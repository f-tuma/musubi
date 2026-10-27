import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createPatchSettingsHandler, createSaveSettingsHandler } from "./settings";

const settings = {
  calendarOrder: [],
  createdAt: new Date("2026-07-26T10:00:00.000Z"),
  dateFormat: "dmy",
  defaultCalendarView: "month",
  id: "user-1",
  defaultReminder: {
    minutesBefore: 10,
    allDay: { daysBefore: 1, atMinute: 1080 },
  },
  lastSeenAnnouncement: "",
  lastSeenProjectNews: "",
  notificationEmails: { eventChanged: true, pollDecided: true },
  notificationsOnByDefault: true,
  onboarded: true,
  revision: 4,
  tabBarLabels: true,
  theme: "system",
  timeFormat: "24h",
  timezone: "Europe/Prague",
  updatedAt: new Date("2026-07-26T11:00:00.000Z"),
  weekStartsOn: "monday",
};

function responseRecorder() {
  let statusCode = 0;
  let payload: unknown;
  const response = {
    json(body: unknown) {
      payload = body;
      return response;
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
  } as unknown as Response;

  return {
    response,
    result: () => ({ payload, statusCode }),
  };
}

async function run() {
  const news = [{ id: "2026-10-27", title: "Release available", body: "https://github.com/f-tuma/musubi/releases", minVersion: null }];
  for (const scenario of [
    { marker: "2026-10-27", canonical: "2026-10-01", expected: "2026-10-27" },
    { marker: "2099-12-31-9", canonical: "2026-10-01", expected: undefined },
    { marker: "0000-00-00", canonical: "", expected: undefined },
  ]) for (const explicit of [false, true]) {
    let sent: { lastSeenAnnouncement?: string; lastSeenProjectNews?: string; theme?: string } | undefined;
    const handler = createPatchSettingsHandler({
      getSettings: async () => ({ ...settings, lastSeenProjectNews: scenario.canonical }),
      readNews: async () => news,
      patch: async (_owner, revision, patch) => { assert.equal(revision, 4); sent = patch; return { conflict: false, settings }; },
      notify: () => undefined,
    });
    await handler({ user: { id: settings.id }, body: { baseRevision: 4, patch: {
      lastSeenAnnouncement: scenario.marker, theme: "dark",
      ...(explicit ? { lastSeenProjectNews: scenario.marker } : {}),
    } } } as Request, responseRecorder().response);
    assert.equal(sent?.lastSeenAnnouncement, scenario.marker);
    assert.equal(sent?.lastSeenProjectNews, scenario.expected);
    assert.equal(sent?.theme, "dark");
  }
  for (const explicit of [false, true]) {
    let sent: unknown;
    const handler = createSaveSettingsHandler({
      getSettings: async () => ({ ...settings, lastSeenProjectNews: "2026-10-27" }),
      readNews: async () => news,
      save: async (_owner, values) => { sent = values; return settings; },
      notify: () => undefined,
    });
    const { lastSeenProjectNews: _omitted, ...oldDocument } = settings;
    await handler({ user: { id: settings.id }, body: {
      ...oldDocument, lastSeenAnnouncement: "2099-12-31-9",
      ...(explicit ? { lastSeenProjectNews: "2099-12-31-9" } : {}),
    } } as Request, responseRecorder().response);
    assert.equal(Object.prototype.hasOwnProperty.call(sent, "lastSeenProjectNews"), false, "A full PUT holding an old server's response cannot import an unknown local marker");
  }
  {
    const { response, result } = responseRecorder();
    const handler = createPatchSettingsHandler({
      notify: () => undefined,
      patch: async () => ({ conflict: true, settings }),
    });
    await handler(
      {
        body: { baseRevision: 3, patch: { theme: "dark" } },
        requestId: "settings-conflict",
        user: { id: "user-1" },
      } as Request,
      response,
    );

    assert.equal(result().statusCode, 409);
    assert.deepEqual(result().payload, {
      current: {
        revision: 4,
        updatedAt: settings.updatedAt,
        value: {
          calendarOrder: [],
          dateFormat: "dmy",
          defaultCalendarView: "month",
          defaultReminder: settings.defaultReminder,
          lastSeenAnnouncement: settings.lastSeenAnnouncement,
          lastSeenProjectNews: settings.lastSeenProjectNews,
          notificationEmails: settings.notificationEmails,
          notificationsOnByDefault: true,
          onboarded: true,
          tabBarLabels: true,
          theme: "system",
          timeFormat: "24h",
          timezone: "Europe/Prague",
          weekStartsOn: "monday",
        },
      },
      error: "SettingsConflict",
      message: "Settings changed on another device.",
      requestId: "settings-conflict",
    });
  }

  {
    const notifications: unknown[] = [];
    const { response, result } = responseRecorder();
    const handler = createPatchSettingsHandler({
      notify: (...args) => {
        notifications.push(args);
      },
      patch: async () => ({
        conflict: false,
        settings: { ...settings, revision: 5, theme: "dark" },
      }),
    });
    await handler(
      {
        body: { baseRevision: 4, patch: { theme: "dark" } },
        requestId: "settings-saved",
        user: { id: "user-1" },
      } as Request,
      response,
    );

    assert.equal(result().statusCode, 200);
    assert.equal((result().payload as { revision: number }).revision, 5);
    assert.deepEqual(notifications, [
      [["user-1"], "settings_updated", { revision: 5 }],
    ]);
  }

  await assert.rejects(
    () =>
      createPatchSettingsHandler()(
        {
          body: {
            baseRevision: 4,
            patch: { unknownSetting: true },
          },
          user: { id: "user-1" },
        } as Request,
        responseRecorder().response,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Request is missing a valid settings patch.",
  );
}

void run();
