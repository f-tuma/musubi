import { and, eq, sql } from "drizzle-orm";
import { db } from "..";
import { calendarMembers, externalCalendars } from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { redactGoogleCalendarMirror } from "./external-access-redaction";
export type CaldavReadAccess = { read: boolean | null; readFreeBusy: boolean | null };
const flag = (value: boolean | null) => value === true ? "yes" : value === false ? "no" : "unknown";
export function caldavReadRole(evidence: CaldavReadAccess) { return `caldav:read=${flag(evidence.read)};freebusy=${flag(evidence.readFreeBusy)}`; }
export function caldavHasRead(role: string | null): boolean | null { return role?.startsWith("caldav:read=yes;") ? true : role?.startsWith("caldav:read=no;") ? false : null; }
/** Collection discovery invalidates stale imported detail, not child write ACLs. */
export async function reconcileCaldavReadAccess(userID: string, accountID: string, calendarID: string, evidence: CaldavReadAccess, readOnly: boolean) {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "exclusive");
    const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.provider, "caldav"), eq(externalCalendars.userID, userID), eq(externalCalendars.accountID, accountID), eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.disabled, false))).for("update");
    const [member] = await tx.select().from(calendarMembers).where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID))).for("update");
    if (!source || !member) throw new Error("CalDAV read source changed.");
    const role = readOnly ? "viewer" : "owner", accessRole = caldavReadRole(evidence);
    if (source.providerAccessRole === accessRole && member.role === role) return false;
    if (member.role !== role) await tx.update(calendarMembers).set({ role }).where(eq(calendarMembers.id, member.id));
    await tx.update(externalCalendars).set({ providerAccessRole: accessRole, providerAccessRevision: sql`${externalCalendars.providerAccessRevision} + 1`, sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`, checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1`, cursor: null, readCoverage: null }).where(eq(externalCalendars.id, source.id));
    return evidence.read === false && caldavHasRead(source.providerAccessRole) !== false
      ? redactGoogleCalendarMirror(tx, calendarID, userID, source.id, "caldav") : [calendarID];
  });
}
