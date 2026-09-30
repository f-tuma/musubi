import { lockCalendarLifecycle, lockUserLifecycle } from "./calendar-lifecycle";
import { randomUUID } from "node:crypto";
import { appendTaskOutbox, prepareTaskOutboxInTransaction, taskOutboxSnapshot } from "./task-outbox";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "..";
import {
	calendarEvents,
	calendarInvites,
	calendarMembers,
	calendarTasks,
	calendars,
	events,
	eventOutbox,
	externalCalendars,
	tasks,
	taskOutbox,
	memberTokens,
	type NewCalendar,
} from "../schema";
import { NotFoundError } from "@musubi/types";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createCalendar(calendar: NewCalendar) {
	return db.transaction(async (tx) => {
		await lockUserLifecycle(tx, [calendar.creatorID], "shared");
		const [result] = await tx
			.insert(calendars)
			.values(calendar)
			.onConflictDoNothing()
			.returning();
		await tx.insert(calendarMembers).values({
			userID: result.creatorID,
			calendarID: result.id,
			role: "owner",
		});
		return result;
	});
}

// Invite tokens are the calendar_invites uuid. Guard the shape first — a raw
// string against a uuid column is a Postgres error (500), not a miss (404).
export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCalendarIDFromToken(token: string) {
	if (!UUID_RE.test(token)) throw new NotFoundError("Invite not found...");

	const [result] = await db
		.select()
		.from(calendarInvites)
		.where(
			and(
				eq(calendarInvites.id, token),
				// null expiresAt = never expires; expired rows also get purged hourly —
				// the gt() covers the window in between.
				or(
					isNull(calendarInvites.expiresAt),
					gt(calendarInvites.expiresAt, new Date()),
				),
			),
		);

	if (!result) throw new NotFoundError("Invite not found...");
	if (result.maxUses !== null && result.uses >= result.maxUses) {
		throw new NotFoundError("Invite not found..."); // exhausted = gone, same as expired
	}

	return result.calendarID;
}

// Validate, join, and consume under one row lock so concurrent accepts cannot
// exceed maxUses. Existing members do not burn another use.
export async function joinCalendarFromInvite(userID: string, token: string) {
	if (!UUID_RE.test(token)) throw new NotFoundError("Invite not found...");

	return db.transaction(async (tx) => {
		const [invite] = await tx
			.select()
			.from(calendarInvites)
			.where(eq(calendarInvites.id, token))
			.for("update");
		if (
			!invite ||
			(invite.expiresAt !== null && invite.expiresAt <= new Date()) ||
			(invite.maxUses !== null && invite.uses >= invite.maxUses)
		) {
			throw new NotFoundError("Invite not found...");
		}

		const added = await tx
			.insert(calendarMembers)
			.values({ userID, calendarID: invite.calendarID, role: "viewer" })
			.onConflictDoNothing()
			.returning();
		if (added.length > 0) {
			await tx
				.update(calendarInvites)
				.set({ uses: sql`${calendarInvites.uses} + 1` })
				.where(eq(calendarInvites.id, token));
		}
		return { calendarID: invite.calendarID, added };
	});
}

export async function getCalendar(id: string) {
	const [result] = await db.select().from(calendars).where(eq(calendars.id, id));

	if (!result) {
		throw new NotFoundError("Calendar not found...");
	}

	return result;
}

/** Lock the union once before removing multiple calendars; sequential subsets
 * could invert event-row order across different accounts sharing events. */
export async function lockCalendarRemovalEvents(tx: DbTransaction, calendarIDs: string[]) {
  if (!calendarIDs.length) return;
  await tx.select({ id: events.id }).from(events).where(or(
    inArray(events.originCalendarID, calendarIDs),
    sql`${events.id} in (select ${calendarEvents.eventID} from ${calendarEvents} where ${inArray(calendarEvents.calendarID, calendarIDs)})`,
  )).orderBy(events.id).for("update");
  // Complete union once, in the same global event -> task -> link/map order.
  await tx.select({ id: tasks.id }).from(tasks).where(or(
    inArray(tasks.originCalendarID, calendarIDs),
    sql`${tasks.id} in (select ${calendarTasks.taskID} from ${calendarTasks} where ${inArray(calendarTasks.calendarID, calendarIDs)})`,
  )).orderBy(tasks.id).for("update");
}

/** Caller holds the full calendar lifecycle removal set and the complete
 * canonical event -> task row-lock union. Home removal globally tombstones;
 * secondary removal only versions membership. Retain all delivery addresses. */
export async function removeCalendarTasksInTransaction(
  tx: DbTransaction,
  calendarID: string,
  removingCalendarIDs: readonly string[] = [calendarID],
) {
	const affectedTasks = await tx.select().from(tasks).where(or(
		eq(tasks.originCalendarID, calendarID),
		sql`${tasks.id} in (select ${calendarTasks.taskID} from ${calendarTasks} where ${calendarTasks.calendarID} = ${calendarID})`,
	)).orderBy(tasks.id).for("update");
	for (const task of affectedTasks) {
		const [changed] = await tx.update(tasks).set({
			revision: task.revision + 1,
			...(task.originCalendarID === calendarID && !task.deletedAt ? { deletedAt: new Date() } : {}),
		}).where(eq(tasks.id, task.id)).returning();
		if (task.originCalendarID === calendarID && !task.deletedAt) {
			const links = await tx.select().from(calendarTasks).where(eq(calendarTasks.taskID, task.id));
			const surviving = links.map((link) => link.calendarID).filter((id) => !removingCalendarIDs.includes(id));
			const wire = taskOutboxSnapshot(changed, surviving);
			const intents = await prepareTaskOutboxInTransaction(tx, wire,
				surviving.map((id) => ({ calendarID: id, action: "delete" })),
				{ actorID: task.creatorID, mutationID: randomUUID() }, undefined, true);
			await appendTaskOutbox(tx, wire, intents);
		}
	}
	// Keep immutable task delivery evidence after disconnect. In-flight responses
	// lose their lease and cannot resurrect mappings; uncertain effects stay visible.
	await tx.update(taskOutbox).set({
		status: "blocked", errorCode: "destination-disconnected",
		leaseToken: null, leaseUntil: null, updatedAt: new Date(),
		uncertain: sql`${taskOutbox.uncertain} or ${taskOutbox.status} = 'attempting'`,
	}).where(and(eq(taskOutbox.calendarID, calendarID),
		sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`));
}

// Internal transaction-aware form used when calendar removal is one step in a
// larger local invariant (for example disabling an external mirror).
export async function removeCalendarInTransaction(
	tx: DbTransaction,
	calendarID: string,
) {
	// Caller holds exclusive lifecycle fences for the complete removal set.
	// Lock every affected event BEFORE cascade link/mapping rows. Origin SET NULL
	// and surviving link removal are real changes even when content is unchanged.
	const affected = await tx
		.select({ event: events })
		.from(events)
		.where(
			or(
				eq(events.originCalendarID, calendarID),
				sql`${events.id} in (select ${calendarEvents.eventID} from ${calendarEvents} where ${calendarEvents.calendarID} = ${calendarID})`,
			),
		)
		.orderBy(events.id)
		.for("update");
	for (const { event } of affected) {
		await tx
			.update(events)
			.set({
				revision: sql`${events.revision} + 1`,
				...(event.originCalendarID === calendarID && !event.deletedAt
					? { deletedAt: new Date() }
					: {}),
			})
			.where(eq(events.id, event.id));
	}
	await removeCalendarTasksInTransaction(tx, calendarID);
	const eIDs = affected.map(({ event }) => ({ eventID: event.id }));
	await tx.update(eventOutbox).set({
		status: "cancelled", errorCode: "destination-disconnected",
		leaseToken: null, leaseUntil: null, updatedAt: new Date(),
		uncertain: sql`${eventOutbox.uncertain} or ${eventOutbox.status} = 'attempting'`,
	}).where(and(eq(eventOutbox.calendarID, calendarID),
		sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`));
	const [result] = await tx
		.delete(calendars)
		.where(eq(calendars.id, calendarID))
		.returning();

	const stillLinked =
		eIDs.length === 0
			? []
			: await tx
					.select({ eventID: calendarEvents.eventID })
					.from(calendarEvents)
					.where(
						inArray(
							calendarEvents.eventID,
							eIDs.map((e) => e.eventID),
						),
					);

	const orphanedEvents = eIDs.filter(
		(candidate) =>
			!stillLinked.some((linked) => linked.eventID === candidate.eventID),
	);

	if (orphanedEvents.length > 0) {
		await tx.delete(events).where(
			inArray(
				events.id,
				orphanedEvents.map((e) => e.eventID),
			),
		);
	}

	return result;
}

export async function removeCalendar(calendarID: string) {
	return db.transaction(async (tx) => {
		await lockCalendarLifecycle(tx, [calendarID], "exclusive");
		return removeCalendarInTransaction(tx, calendarID);
	});
}

export async function updateCalendar(calendar: NewCalendar) {
	const [result] = await db
		.update(calendars)
		.set(calendar)
		.where(eq(calendars.id, calendar.id!))
		.returning();
	return result;
}

export async function getUsersCalendars(userID: string) {
	const result = await db.query.calendarMembers.findMany({
		where: eq(calendarMembers.userID, userID),
		with: {
			calendars: true,
		},
	});

	return result;
}

export async function getCalendarMembers(calendarID: string) {
	const result = await db.query.calendarMembers.findMany({
		where: eq(calendarMembers.calendarID, calendarID),
		with: {
			user: true,
		},
	});

	// Owner first everywhere members are shown; name as a stable tiebreaker.
	const rank: Record<string, number> = { owner: 0, editor: 1, viewer: 2 };
	result.sort(
		(a, b) =>
			(rank[a.role] ?? 9) - (rank[b.role] ?? 9) ||
			a.user.name.localeCompare(b.user.name),
	);

	return result;
}

export async function getCalendarEvents(calendarID: string) {
	const result = await db.query.calendarEvents.findMany({
		where: eq(calendarEvents.calendarID, calendarID),
		with: {
			events: true,
		},
	});

	return result;
}

// The user's role on a calendar (owner | editor | viewer), or null if not a member.
export async function getUserRoleForCalendar(
	userID: string,
	calendarID: string,
): Promise<string | null> {
	const [row] = await db
		.select({ role: calendarMembers.role })
		.from(calendarMembers)
		.where(
			and(
				eq(calendarMembers.userID, userID),
				eq(calendarMembers.calendarID, calendarID),
			),
		);
	return row?.role ?? null;
}

export async function addCalendarMember(userID: string, calendarID: string) {
	const result = await db
		.insert(calendarMembers)
		.values({ userID, calendarID, role: "viewer" }) // new members start read-only
		.onConflictDoNothing()
		.returning();

	return result;
}

// Low-level role update for provider sync. User-facing member management uses
// setCalendarMemberRole()/transferCalendarOwnership() so owner invariants lock.
export async function setMemberRole(
	userID: string,
	calendarID: string,
	role: string,
) {
	const [result] = await db
		.update(calendarMembers)
		.set({ role })
		.where(
			and(
				eq(calendarMembers.userID, userID),
				eq(calendarMembers.calendarID, calendarID),
			),
		)
		.returning();

	return result;
}

export type SetCalendarMemberRoleResult =
	| { status: "updated"; member: typeof calendarMembers.$inferSelect }
	| { status: "calendar_not_found" }
	| { status: "not_owner" }
	| { status: "owner" }
	| { status: "member_not_found" };

// User-facing role changes serialize with ownership transfers. The sync engine
// uses setMemberRole() directly because provider read-only mirrors intentionally
// allow their creator membership to be "viewer".
export async function setCalendarMemberRole(
	actingUserID: string,
	userID: string,
	calendarID: string,
	role: "viewer" | "editor",
): Promise<SetCalendarMemberRoleResult> {
	return db.transaction(async (tx) => {
		const [calendar] = await tx
			.select({ creatorID: calendars.creatorID })
			.from(calendars)
			.where(eq(calendars.id, calendarID))
			.for("update");
		if (!calendar) return { status: "calendar_not_found" };
		if (calendar.creatorID !== actingUserID) return { status: "not_owner" };
		if (calendar.creatorID === userID) return { status: "owner" };

		const [member] = await tx
			.update(calendarMembers)
			.set({ role })
			.where(
				and(
					eq(calendarMembers.userID, userID),
					eq(calendarMembers.calendarID, calendarID),
				),
			)
			.returning();

		return member
			? { status: "updated", member }
			: { status: "member_not_found" };
	});
}

export type TransferCalendarOwnershipResult =
	| { status: "updated"; calendar: typeof calendars.$inferSelect }
	| { status: "calendar_not_found" }
	| { status: "not_owner" }
	| { status: "default_calendar" }
	| { status: "external_calendar" }
	| { status: "member_not_found" };

export async function transferCalendarOwnership(
	calendarID: string,
	currentOwnerID: string,
	targetUserID: string,
): Promise<TransferCalendarOwnershipResult> {
	return db.transaction(async (tx) => {
    await lockUserLifecycle(tx, [currentOwnerID, targetUserID], "shared");
    await lockCalendarLifecycle(tx, [calendarID], "shared");
		// Serialize transfers for this calendar. Without the row lock, two requests
		// can both observe the same owner and leave multiple memberships as owner.
		const [calendar] = await tx
			.select()
			.from(calendars)
			.where(eq(calendars.id, calendarID))
			.for("update");

		if (!calendar) return { status: "calendar_not_found" };
		if (calendar.creatorID !== currentOwnerID) return { status: "not_owner" };
		if (calendar.isDefault) return { status: "default_calendar" };

		// A mirror stays bound to the user/account that owns its provider
		// credentials. Transferring only creatorID would create a fake owner who
		// cannot perform the provider-side half of calendar mutations.
		const [externalLink] = await tx
			.select({ id: externalCalendars.id })
			.from(externalCalendars)
			.where(eq(externalCalendars.calendarID, calendarID));
		if (externalLink) return { status: "external_calendar" };

		const members = await tx
			.select({ userID: calendarMembers.userID })
			.from(calendarMembers)
			.where(
				and(
					eq(calendarMembers.calendarID, calendarID),
					inArray(calendarMembers.userID, [currentOwnerID, targetUserID]),
				),
			)
			.for("update");

		if (!members.some((member) => member.userID === targetUserID)) {
			return { status: "member_not_found" };
		}
		if (!members.some((member) => member.userID === currentOwnerID)) {
			throw new Error("Calendar owner is missing their membership row.");
		}

		await tx
			.update(calendarMembers)
			.set({ role: "owner" })
			.where(
				and(
					eq(calendarMembers.userID, targetUserID),
					eq(calendarMembers.calendarID, calendarID),
				),
			);
		await tx
			.update(calendarMembers)
			.set({ role: "editor" })
			.where(
				and(
					eq(calendarMembers.userID, currentOwnerID),
					eq(calendarMembers.calendarID, calendarID),
				),
			);
		const [updatedCalendar] = await tx
			.update(calendars)
			.set({ creatorID: targetUserID })
			.where(eq(calendars.id, calendarID))
			.returning();
		if (!updatedCalendar) {
			throw new Error("Calendar disappeared during ownership transfer.");
		}

		return { status: "updated", calendar: updatedCalendar };
	});
}

export type RemoveCalendarMemberResult =
	| { status: "removed"; member: typeof calendarMembers.$inferSelect }
	| { status: "calendar_not_found" }
	| { status: "not_owner" }
	| { status: "owner" }
	| { status: "member_not_found" };

export async function removeCalendarMember(
	userID: string,
	calendarID: string,
	actingUserID?: string,
): Promise<RemoveCalendarMemberResult> {
	return db.transaction(async (tx) => {
		const [calendar] = await tx
			.select({ creatorID: calendars.creatorID })
			.from(calendars)
			.where(eq(calendars.id, calendarID))
			.for("update");
		if (!calendar) return { status: "calendar_not_found" };
		if (actingUserID && calendar.creatorID !== actingUserID) {
			return { status: "not_owner" };
		}
		if (calendar.creatorID === userID) return { status: "owner" };

		const [member] = await tx
			.delete(calendarMembers)
			.where(
				and(
					eq(calendarMembers.userID, userID),
					eq(calendarMembers.calendarID, calendarID),
				),
			)
			.returning();

		if (member) {
			const [remainingMembership] = await tx
				.select({ calendarID: calendarMembers.calendarID })
				.from(calendarMembers)
				.where(eq(calendarMembers.userID, userID))
				.limit(1);
			if (!remainingMembership) {
				await tx.delete(memberTokens).where(eq(memberTokens.userID, userID));
			}
		}

		return member
			? { status: "removed", member }
			: { status: "member_not_found" };
	});
}
