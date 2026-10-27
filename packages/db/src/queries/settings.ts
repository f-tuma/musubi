import { and, eq, sql } from "drizzle-orm";
import {
  DEFAULT_REMINDER_RULE,
  isSilentRule,
  SILENT_REMINDER_RULE,
} from "@musubi/types";
import { db, NewSettings, userSettings } from "..";

type SettingsValues = Omit<
  NewSettings,
  "id" | "createdAt" | "revision" | "updatedAt"
>;

/**
 * Keep `notificationsOnByDefault` and `defaultReminder` telling the same story.
 *
 * They are the same setting seen by two generations of client: older mobile
 * builds know only the boolean, everything since knows the rule. Whichever one
 * a request carries decides, and the other follows — otherwise an old phone
 * switching reminders off would leave the rule happily firing.
 *
 * Turning the boolean back ON restores the standard rule only if the current
 * one is silent; a user who chose "an hour before" must not be reset to ten
 * minutes by a client that cannot even see the difference.
 */
export function alignReminderDefaults<T extends Partial<SettingsValues>>(
  values: T,
  current?: { defaultReminder?: NewSettings["defaultReminder"] },
): T {
  if (values.defaultReminder !== undefined) {
    return { ...values, notificationsOnByDefault: !isSilentRule(values.defaultReminder) };
  }

  if (values.notificationsOnByDefault === undefined) return values;

  if (!values.notificationsOnByDefault) {
    return { ...values, defaultReminder: SILENT_REMINDER_RULE };
  }

  const existing = current?.defaultReminder;
  return existing && !isSilentRule(existing)
    ? values
    : { ...values, defaultReminder: DEFAULT_REMINDER_RULE };
}

export async function getUserSettings(userID: string) {
  let [result] = await db.select().from(userSettings).where(eq(userSettings.id, userID));

  if (!result) {
    const [inserted] = await db
      .insert(userSettings)
      .values({ id: userID })
      .onConflictDoNothing({ target: userSettings.id })
      .returning();
    if (inserted) return inserted;

    // Another request inserted the one-per-user row after our select.
    [result] = await db.select().from(userSettings).where(eq(userSettings.id, userID));
  }

  return result;
}

/** Establish a first-view baseline once, after the caller has validated news. */
export async function initializeProjectNewsReadMarker(userID: string, marker: string) {
  const [initialized] = await db
    .update(userSettings)
    .set({
      lastSeenProjectNews: marker,
      revision: sql`${userSettings.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(userSettings.id, userID), eq(userSettings.lastSeenProjectNews, "")))
    .returning();
  if (initialized) return { initialized: true, settings: initialized };

  return { initialized: false, settings: await getUserSettings(userID) };
}

function advanceProjectNewsReadMarker(values: Partial<SettingsValues>) {
  if (values.lastSeenProjectNews === undefined) return {};
  return {
    // Client markers compare strings. C collation keeps that ordering
    // independent of the host database's locale, including numeric suffixes.
    lastSeenProjectNews: sql`greatest(${userSettings.lastSeenProjectNews} collate "C", ${values.lastSeenProjectNews})`,
  };
}

export async function saveUserSettings(userID: string, values: SettingsValues) {
  const settings = alignReminderDefaults(values, await getUserSettings(userID));
  // Settings may be saved before any GET materializes the row. One upsert makes
  // concurrent first-save/first-read requests converge on the same user row.
  const [saved] = await db
    .insert(userSettings)
    .values({ ...settings, id: userID })
    .onConflictDoUpdate({
      target: userSettings.id,
      set: {
        ...settings,
        ...advanceProjectNewsReadMarker(settings),
        revision: sql`${userSettings.revision} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return saved;
}

export async function patchUserSettings(
  userID: string,
  baseRevision: number,
  values: Partial<SettingsValues>,
) {
  const patch = alignReminderDefaults(values, await getUserSettings(userID));
  const [saved] = await db
    .update(userSettings)
    .set({
      ...patch,
      ...advanceProjectNewsReadMarker(patch),
      revision: sql`${userSettings.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userSettings.id, userID),
        eq(userSettings.revision, baseRevision),
      ),
    )
    .returning();

  if (saved) {
    return { conflict: false as const, settings: saved };
  }

  return {
    conflict: true as const,
    settings: await getUserSettings(userID),
  };
}
