import assert from "node:assert/strict";
import { SettingsPatchSchema, SettingsSchema } from "./settings";

// A phone updates from a store; a self-hosted server updates when its admin
// gets round to it. So a client newer than its server is the ordinary case, and
// what the patch schema does with a field it has never heard of decides whether
// that user can change their settings at all.

{
  // The case that broke in the wild: the app had learned about `timezone`, the
  // server had not, and `.strict()` refused the whole patch — so the theme
  // change went down with it and nothing was saved.
  const parsed = SettingsPatchSchema.safeParse({
    theme: "dark",
    somethingThisServerHasNeverHeardOf: "value",
  });

  assert.equal(parsed.success, true, "an unknown field must not sink the patch");
  assert.deepEqual(
    parsed.data,
    { theme: "dark" },
    "the unknown field is stripped, the known one applied",
  );
}

{
  // Stripping must not turn nothing into success. A patch of only unknown
  // fields has nothing to apply, and answering 200 would claim otherwise.
  const parsed = SettingsPatchSchema.safeParse({ onlyUnknown: true });
  assert.equal(parsed.success, false);
}

{
  // Still a schema: a known field with the wrong shape is an error, not a
  // silent strip. Leniency is about fields from the future, not bad data.
  assert.equal(SettingsPatchSchema.safeParse({ theme: "chartreuse" }).success, false);
  assert.equal(SettingsPatchSchema.safeParse({ weekStartsOn: 3 }).success, false);
  assert.equal(SettingsPatchSchema.safeParse({}).success, false, "empty is empty");
}

{
  // And the fields that caused this still work when the server does know them.
  const parsed = SettingsPatchSchema.safeParse({ timezone: "Europe/Prague" });
  assert.equal(parsed.success, true);
  assert.equal(SettingsPatchSchema.safeParse({ timezone: "Mars/Olympus" }).success, false);
}

{
  // Značka poslední viděné zprávy. Volitelná ze stejného důvodu jako `onboarded`:
  // starší klient, který uloží celý dokument, ji nesmí shodit zpátky.
  assert.equal(
    SettingsPatchSchema.parse({ lastSeenAnnouncement: "2026-08-29" })
      .lastSeenAnnouncement,
    "2026-08-29",
  );

  // Patch jen s touto značkou je platný patch (není prázdný).
  assert.doesNotThrow(() =>
    SettingsPatchSchema.parse({ lastSeenAnnouncement: "2026-08-29-2" }),
  );

  // Nový uživatel: prázdný řetězec je platná hodnota "nikdy nic neviděl".
  assert.equal(
    SettingsPatchSchema.parse({ lastSeenAnnouncement: "" }).lastSeenAnnouncement,
    "",
  );
}

{
  const lastSeenProjectNews = "2026-10-27";
  assert.deepEqual(SettingsPatchSchema.parse({ lastSeenProjectNews }), {
    lastSeenProjectNews,
  });
  assert.equal(SettingsPatchSchema.parse({ lastSeenProjectNews: "" }).lastSeenProjectNews, "");
  assert.equal(SettingsPatchSchema.safeParse({ lastSeenProjectNews: "x".repeat(65) }).success, false);

  const oldClientSettings = {
    notificationsOnByDefault: true,
    defaultCalendarView: "week",
    weekStartsOn: "monday",
    timeFormat: "24h",
    dateFormat: "dmy",
    lastSeenAnnouncement: "2099-12-31-9",
  };
  const oldPut = SettingsSchema.parse(oldClientSettings);
  assert.equal(Object.hasOwn(oldPut, "lastSeenProjectNews"), false,
    "an older client's full PUT must omit the new marker instead of supplying a default");
  assert.equal(oldPut.lastSeenAnnouncement, oldClientSettings.lastSeenAnnouncement,
    "server-local and project read markers stay independent");
  assert.equal(SettingsSchema.parse({ ...oldClientSettings, lastSeenProjectNews }).lastSeenProjectNews, lastSeenProjectNews);
}

console.log("settings.test.ts ok");
