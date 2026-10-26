import { withSyncReadTransaction } from "./read-work-transaction";
import type { SyncReadWorkExecution } from "./read-work-transaction";
import { and, eq, sql } from "drizzle-orm";
import { db } from "..";
import { calendarMembers, externalCalendars } from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { redactGoogleCalendarMirror } from "./external-access-redaction";
export type MicrosoftCalendarAccess = { canEdit: boolean | null; canViewPrivateItems: boolean | null };
const flag = (value: boolean | null) => value === true ? "yes" : value === false ? "no" : "unknown";
export function microsoftAccessRole(value: MicrosoftCalendarAccess) { return `microsoft:private=${flag(value.canViewPrivateItems)};edit=${flag(value.canEdit)}`; }
export function microsoftPrivateAccess(role: string | null): boolean | null { return role?.startsWith("microsoft:private=yes;") ? true : role?.startsWith("microsoft:private=no;") ? false : null; }
export function hasFullProviderReadAccess(provider: string, role: string | null) { return provider === "caldav" ? role !== null && role.startsWith("caldav:read=") && !role.startsWith("caldav:read=no;") : provider === "microsoft" ? microsoftPrivateAccess(role) === true : ["owner", "writer"].includes(role ?? ""); }
/** Successful discovery records write and private-read evidence independently.
 * Only explicit loss of private reads retires content; write loss is not privacy.
 */
export async function reconcileMicrosoftCalendarAccess(userID: string, accountID: string, calendarID: string, evidence: MicrosoftCalendarAccess, readWork?: SyncReadWorkExecution) {
  const accessRole = microsoftAccessRole(evidence);
  return withSyncReadTransaction(readWork, async tx => {
    await lockCalendarLifecycle(tx, [calendarID], "exclusive");
    const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.provider, "microsoft"), eq(externalCalendars.userID, userID), eq(externalCalendars.accountID, accountID), eq(externalCalendars.calendarID, calendarID), eq(externalCalendars.disabled, false), eq(externalCalendars.supportsEvents, true))).for("update");
    const [member] = await tx.select().from(calendarMembers).where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID))).for("update");
    if (!source || !member) throw new Error("Microsoft access source changed.");
    const role = evidence.canEdit === true ? "owner" : "viewer";
    if (source.providerAccessRole === accessRole && member.role === role) return false;
    if (member.role !== role) await tx.update(calendarMembers).set({ role }).where(eq(calendarMembers.id, member.id));
    await tx.update(externalCalendars).set({ providerAccessRole: accessRole, providerAccessRevision: sql`${externalCalendars.providerAccessRevision} + 1`, sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`, checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1`, cursor: null, readCoverage: null }).where(eq(externalCalendars.id, source.id));
    return evidence.canViewPrivateItems === false && microsoftPrivateAccess(source.providerAccessRole) !== false
      ? redactGoogleCalendarMirror(tx, calendarID, userID, source.id, "microsoft") : [calendarID];
  });
}
