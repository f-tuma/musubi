import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { SettingsSchema } from "@musubi/types";
import {
  db,
  getUserSettings,
  initializeProjectNewsReadMarker,
  patchUserSettings,
  saveUserSettings,
  user,
  userSettings,
} from "..";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use only a disposable migrated test PostgreSQL database.");
  const owners = Array.from({ length: 3 }, () => `project-news-${randomUUID()}`);
  await db.insert(user).values(owners.map(id => ({ id, name: id, email: `${id}@example.test` })));
  const [owner, baselineRaceOwner, writeRaceOwner] = owners;
  try {
    const [before] = await db.insert(userSettings).values({
      id: owner,
      lastSeenAnnouncement: "2099-12-31-9",
      theme: "dark",
      revision: 7,
      updatedAt: new Date("2000-01-01T00:00:00Z"),
    }).returning();
    const first = await initializeProjectNewsReadMarker(owner, "2026-10-27");
    assert.equal(first.initialized, true);
    assert.equal(first.settings.lastSeenProjectNews, "2026-10-27");
    assert.equal(first.settings.revision, before.revision + 1);
    assert.ok(first.settings.updatedAt > before.updatedAt);
    assert.equal(first.settings.lastSeenAnnouncement, before.lastSeenAnnouncement,
      "Initial project baseline never reuses or changes a server-local marker");
    assert.equal(first.settings.theme, before.theme);

    const repeated = await initializeProjectNewsReadMarker(owner, "2026-10-30");
    assert.equal(repeated.initialized, false);
    assert.deepEqual(repeated.settings, first.settings,
      "Later GETs cannot silently skip newly published news or change the settings revision");

    // Parse a real old-client full document: omission must survive parsing and
    // the production upsert, while its legacy marker remains an ordinary field.
    const oldPut = SettingsSchema.parse({
      notificationsOnByDefault: false,
      defaultCalendarView: "day",
      weekStartsOn: "monday",
      timeFormat: "24h",
      dateFormat: "dmy",
      theme: "dark",
      lastSeenAnnouncement: "0000-00-00",
    });
    assert.equal(Object.hasOwn(oldPut, "lastSeenProjectNews"), false);
    const savedOldPut = await saveUserSettings(owner, oldPut);
    assert.equal(savedOldPut.lastSeenProjectNews, first.settings.lastSeenProjectNews,
      "An old full PUT cannot reset independently stored project read state");
    assert.equal(savedOldPut.lastSeenAnnouncement, "0000-00-00");
    assert.equal(savedOldPut.defaultCalendarView, "day");

    const advanced = await saveUserSettings(owner, { lastSeenProjectNews: "2026-10-27-9" });
    assert.equal(advanced.lastSeenProjectNews, "2026-10-27-9");
    const delayedPut = await saveUserSettings(owner, {
      lastSeenProjectNews: "2026-10-27-10",
      lastSeenAnnouncement: "2026-10-01",
    });
    assert.equal(delayedPut.lastSeenProjectNews, advanced.lastSeenProjectNews,
      "Canonical PUT updates preserve client lexical order across suffix digit boundaries");
    assert.equal(delayedPut.lastSeenAnnouncement, "2026-10-01",
      "Monotonic project read state does not change legacy settings assignment");
    const delayedPatch = await patchUserSettings(owner, delayedPut.revision, {
      lastSeenProjectNews: "0000-00-00",
      theme: "light",
      lastSeenAnnouncement: "",
    });
    assert.equal(delayedPatch.conflict, false);
    assert.equal(delayedPatch.settings.lastSeenProjectNews, advanced.lastSeenProjectNews,
      "A delayed canonical PATCH cannot roll read state backwards");
    assert.equal(delayedPatch.settings.lastSeenAnnouncement, "");
    assert.equal(delayedPatch.settings.theme, "light");
    const newerPatch = await patchUserSettings(owner, delayedPatch.settings.revision, {
      lastSeenProjectNews: "2026-10-27-90",
    });
    assert.equal(newerPatch.conflict, false);
    assert.equal(newerPatch.settings.lastSeenProjectNews, "2026-10-27-90");
    const stalePatch = await patchUserSettings(owner, delayedPatch.settings.revision, {
      lastSeenProjectNews: "2026-11-01",
    });
    assert.equal(stalePatch.conflict, true);
    assert.deepEqual(stalePatch.settings, newerPatch.settings,
      "Canonical marker updates retain the existing settings revision fence");

    const raceBefore = await getUserSettings(baselineRaceOwner);
    const baselineResults = await Promise.all([
      initializeProjectNewsReadMarker(baselineRaceOwner, "2026-10-27"),
      initializeProjectNewsReadMarker(baselineRaceOwner, "2026-10-28"),
    ]);
    assert.equal(baselineResults.filter(result => result.initialized).length, 1,
      "Concurrent first views establish exactly one baseline");
    const winningBaseline = baselineResults.find(result => result.initialized)!;
    const afterBaselineRace = await getUserSettings(baselineRaceOwner);
    assert.deepEqual(afterBaselineRace, winningBaseline.settings);
    assert.equal(afterBaselineRace.revision, raceBefore.revision + 1);

    await getUserSettings(writeRaceOwner);
    await Promise.all([
      initializeProjectNewsReadMarker(writeRaceOwner, "2026-10-27"),
      saveUserSettings(writeRaceOwner, { lastSeenProjectNews: "2026-10-30" }),
    ]);
    assert.equal((await getUserSettings(writeRaceOwner)).lastSeenProjectNews, "2026-10-30",
      "A first-view baseline racing a confirmed read never overwrites the newer read");
    console.log("Project-news baseline, concurrent initialization and settings read-state compatibility: OK");
  } finally {
    try { await db.delete(user).where(inArray(user.id, owners)); }
    finally { await db.$client.end(); }
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
