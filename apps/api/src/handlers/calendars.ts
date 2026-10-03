import { validateCalendarImportDates } from "../sync/adapters/caldav_recurrence_dates";
import { eventMutationIdentity } from "./event_mutation";
import { committedFailure } from "./event_commit";
import type { Request, Response } from "express";
import ICAL from "ical.js";
import { randomUUID } from "crypto";
import {
	createCalendar,
	createEvent,
	getCalendar,
	getCalendarEvents,
	getCalendarIDFromToken,
	getCalendarMembers,
	getExternalLinkForCalendar,
	getUserRoleForCalendar,
	getUsersCalendars,
	importExternalCalendar,
	joinCalendarFromInvite,
	type NewCalendar,
	removeCalendar,
	removeCalendarMember,
	setCalendarMemberRole,
	transferCalendarOwnership,
	updateCalendar,
} from "@musubi/db";
import { toVevent, veventToFields } from "../sync/adapters/caldav";
import {
	BadRequestError,
	type Calendar,
	CalendarSchema,
	calendarSupportsTaskLinks,
	EventSchema,
	EventWriteError,
	ForbiddenError,
	NotFoundError,
	type User,
} from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import { assertCan } from "../permissions";
import { getAdapter, prepareEventWrites } from "../sync/engine";
import { buildInvitePreview } from "../invite_preview";
import { assertOAuthEventWriteGrant } from "../sync/event_write";
import { ProviderAuthError } from "../sync/errors";

// External mirror? Then only the person whose provider account backs it may
// change/delete it — and the change must land on the provider FIRST (throwing
// aborts the local write, keeping Musubi and the provider consistent).
async function pushExternal(
	userID: string,
	calendarID: string,
	action: (
		adapter: NonNullable<ReturnType<typeof getAdapter>>,
		link: NonNullable<Awaited<ReturnType<typeof getExternalLinkForCalendar>>>,
	) => Promise<void>,
) {
	const link = await getExternalLinkForCalendar(calendarID);
	if (!link) return;
	if (link.userID !== userID) {
		throw new ForbiddenError(
			"Only the owner of the connected account can change this calendar.",
		);
	}
	const adapter = getAdapter(link.provider);
	if (!adapter)
		throw new BadRequestError(`Unknown provider "${link.provider}".`);
	try {
		await action(adapter, link);
	} catch (e: any) {
		throw new BadRequestError(
			e?.message ?? "The provider rejected the change.",
		);
	}
}

async function createCalendarAtDestination(
	user: User,
	input: { accountId?: string; color: string; name: string; provider?: string },
) {
	if (Boolean(input.provider) !== Boolean(input.accountId)) {
		throw new BadRequestError(
			"Calendar destination requires both provider and accountId.",
		);
	}

	if (input.provider && input.accountId) {
		const adapter = getAdapter(input.provider);
		if (!adapter)
			throw new BadRequestError(`Unknown provider "${input.provider}".`);
		if (input.provider === "google" || input.provider === "microsoft") {
			await assertOAuthEventWriteGrant(user.id, input.provider, input.accountId);
		}
		const accounts = await adapter.listAccounts(user.id);
		const account = accounts.find((a) => a.id === input.accountId);
		if (!account)
			throw new ForbiddenError("That account isn't connected to your user.");

		let externalId: string;
		try {
			({ externalId } = await adapter.createCalendar(user.id, account.id, {
				name: input.name,
				color: input.color,
			}));
		} catch (error: unknown) {
			if (error instanceof EventWriteError || error instanceof ProviderAuthError) throw error;
			throw new BadRequestError(
				error instanceof Error
					? error.message
					: "The provider rejected the new calendar.",
			);
		}
		const created = await importExternalCalendar(
			input.provider,
			user.id,
			account.id,
			account.label,
			{ externalId, name: input.name, color: input.color },
		);
		const link = await getExternalLinkForCalendar(created.id);
		return {
			...created,
			role: "owner",
			members: [{ id: user.id, name: user.name, email: user.email }],
			provider: link?.provider ?? input.provider,
			accountId: link?.accountID ?? account.id,
			accountLabel: link?.accountLabel ?? account.label,
			serverUrl: link?.serverUrl ?? null,
		};
	}

	const newCalendar: NewCalendar = {
		name: input.name,
		color: input.color,
		creatorID: user.id,
	};
	const result = await createCalendar(newCalendar);
	return {
		...result,
		role: "owner",
		members: [{ id: user.id, name: user.name, email: user.email }],
	};
}

export async function handlerCreateCalendar(req: Request, res: Response) {
	let calendar: Calendar;
	try {
		calendar = CalendarSchema.parse(req.body);
	} catch {
		throw new BadRequestError("Request is missing valid calendar data...");
	}

	const result = await createCalendarAtDestination(req.user!, {
		accountId: calendar.accountId ?? undefined,
		color: calendar.color,
		name: calendar.name,
		provider: calendar.provider ?? undefined,
	});
	res.status(201).json(result);
}

export async function handlerRemoveCalendar(req: Request, res: Response) {
	let calendar: Calendar;
	try {
		calendar = CalendarSchema.parse(req.body);
	} catch {
		throw new BadRequestError("Request is missing valid calendar data...");
	}
	const members = await getCalendarMembers(calendar.id);
	await assertCan(req.user!.id, calendar.id, "deleteCalendar");
	const existing = await getCalendar(calendar.id);
	if (existing.isDefault) {
		throw new BadRequestError("Your personal calendar can't be deleted.");
	}
	// External mirror → delete on the provider first; failure aborts the local delete.
	await pushExternal(req.user!.id, calendar.id, (adapter, link) =>
		adapter.deleteCalendar(
			link.userID,
			link.accountID,
			link.externalCalendarID,
		),
	);
	const removedCalendar = await removeCalendar(calendar.id);

	if (removedCalendar) {
		const result = { ...removedCalendar, members: [] };

		const memberIDSeen = new Set<string>();

		for (const member of members) {
			if (!memberIDSeen.has(member.userID)) {
				memberIDSeen.add(member.userID);
			}
		}

		notifyCalendarMembers([...memberIDSeen], "calendar_removed", result);

		return res.status(200).json(result);
	}
	throw new NotFoundError("Calendar not found...");
}

export async function handlerUpdateCalendar(req: Request, res: Response) {
	let calendar: Calendar;
	try {
		calendar = CalendarSchema.parse(req.body);
	} catch {
		throw new BadRequestError("Request missing valid calendar data...");
	}

	await assertCan(req.user!.id, calendar.id, "editCalendar");
	// External mirror → rename/recolor on the provider first; failure aborts the local write.
	await pushExternal(req.user!.id, calendar.id, (adapter, link) =>
		adapter.updateCalendar(
			link.userID,
			link.accountID,
			link.externalCalendarID,
			{ name: calendar.name, color: calendar.color },
		),
	);
	// isDefault is server-managed — never writable from the client.
	const { isDefault: _ignored, ...editable } = calendar;
	const updatedCalendar = await updateCalendar({
		...editable,
		creatorID: req.user!.id,
	});

	if (updatedCalendar) {
		const result = { ...updatedCalendar, members: calendar.members };

		const memberIDSeen = new Set<string>();

		const members = await getCalendarMembers(calendar.id);

		for (const member of members) {
			if (!memberIDSeen.has(member.userID)) {
				memberIDSeen.add(member.userID);
			}
		}

		notifyCalendarMembers([...memberIDSeen], "calendar_updated", result);

		return res.status(200).json(result);
	}
	throw new NotFoundError("Calendar not found...");
}

export async function handlerGetCalendars(req: Request, res: Response) {
	const calendars = await getUsersCalendars(req.user!.id!);
	const result: Calendar[] = [];

	for (const calendar of calendars) {
		const members: User[] = [];
		const users = await getCalendarMembers(calendar.calendarID);
		for (const user of users) {
			members.push({
				id: user.user.id,
				name: user.user.name,
				email: user.user.email,
			});
		}
		const link = await getExternalLinkForCalendar(calendar.calendarID);
		const ownsExternalAccount = link?.userID === req.user!.id;
		result.push({
			...calendar.calendars,
			members: members,
			role: calendar.role, // the requesting user's role on this calendar
			provider: link?.provider ?? null,
			accountId: link?.accountID ?? null,
			accountLabel: link?.accountLabel ?? null,
			serverUrl: link?.serverUrl ?? null, // caldav only — client uses it to spot iCloud
			// Only the account owner can repair OAuth. Other Musubi members may see
			// the shared mirror, but must not be prompted to link their own Google.
			syncStatus:
				ownsExternalAccount &&
				(link?.syncStatus === "active" ||
					link?.syncStatus === "reconnect_required")
					? link.syncStatus
					: null,
			syncErrorCode: ownsExternalAccount ? (link?.syncErrorCode ?? null) : null,
			providerDefaultCalendar: link?.providerDefaultCalendar ?? null,
			supportsTasks: link?.supportsTasks ?? true,
			supportsTaskLinks: calendarSupportsTaskLinks({ provider: link?.provider, supportsTasks: link?.supportsTasks }),
			supportsEvents: link?.supportsEvents ?? true,
		});
	}

	res.status(200).json(result);
}

export async function handlerGetCalendarFromToken(req: Request, res: Response) {
	const calendarID = await getCalendarIDFromToken(req.params.token as string);
	const calendar = await getCalendar(calendarID);
	const members = await getCalendarMembers(calendarID);
	const events = await getCalendarEvents(calendarID);

	res.status(200).json(buildInvitePreview(calendar, members, events));
}

type CalendarDetailDependencies = {
	getUserRoleForCalendar: typeof getUserRoleForCalendar;
	getCalendar: typeof getCalendar;
	getCalendarMembers: typeof getCalendarMembers;
};

const calendarDetailDependencies: CalendarDetailDependencies = {
	getUserRoleForCalendar,
	getCalendar,
	getCalendarMembers,
};

// Load a calendar detail only after proving the caller belongs to it. Keep this
// authorization before both data reads: the response contains member emails,
// and an authenticated non-member must not be able to enumerate either the
// calendar or its membership by UUID.
export async function getCalendarDetailsForUser(
	userID: string,
	calendarID: string,
	dependencies: CalendarDetailDependencies = calendarDetailDependencies,
) {
	const role = await dependencies.getUserRoleForCalendar(userID, calendarID);
	if (!role) throw new ForbiddenError("You're not a member of this calendar.");

	const result = await dependencies.getCalendar(calendarID);
	if (!result) throw new NotFoundError("Calendar not found...");

	const members = await dependencies.getCalendarMembers(calendarID);
	return {
		...result,
		members: members.map((u) => ({
			name: u.user.name,
			email: u.user.email,
			id: u.user.id,
		})),
	};
}

export async function handlerGetCalendar(req: Request, res: Response) {
	const result = await getCalendarDetailsForUser(
		req.user!.id,
		req.params.id as string,
	);
	res.status(200).json(result);
}

// Import a whole .ics file as a new calendar. Body is raw iCalendar text
// (route-level express.text — the global JSON parser's 512 KB cap doesn't fit
// real calendars); calendar details and optional account destination ride in
// the query string.
export async function handlerImportCalendar(req: Request, res: Response) {
	const mutationIdentity = eventMutationIdentity(req);
	const ics = req.body;
	if (typeof ics !== "string" || !ics.trim())
		throw new BadRequestError("Request body must be an iCalendar file...");

	let vcal: ICAL.Component;
	try {
		validateCalendarImportDates(ics);
		vcal = new ICAL.Component(ICAL.parse(ics));
	} catch {
		throw new BadRequestError("That file isn't valid iCalendar data...");
	}

	const vevents = vcal.getAllSubcomponents("vevent");
	assertImportEventLimit(vevents.length);

	const name =
		(req.query.name as string) ||
		(vcal.getFirstPropertyValue("x-wr-calname") as string | null) ||
		"Imported calendar";
	const color = (req.query.color as string) || "#7a9e7e";
	const provider =
		typeof req.query.provider === "string" ? req.query.provider : undefined;
	const accountId =
		typeof req.query.accountId === "string" ? req.query.accountId : undefined;

	// Detached import fidelity remains K11. Inspect every accepted master before
	// creating a destination, so known unsupported content cannot partially import.
	let fields: NonNullable<ReturnType<typeof veventToFields>>[];
	try {
		fields = vevents.filter((event) => !event.getFirstPropertyValue("recurrence-id"))
			.map(veventToFields).filter((event) => event !== null);
	} catch { throw new BadRequestError("That file contains unsupported or invalid recurrence dates."); }
	if (provider === "microsoft" && fields.some((event) => event.recurrence)) {
		throw new EventWriteError("recurrence", "unsupported",
			"Outlook recurring import is not supported yet. No calendar or events were created.");
	}
	const created = await createCalendarAtDestination(req.user!, { accountId, color, name, provider });
	const importedEvents = fields.map((event) => EventSchema.parse({
		...event, id: randomUUID(), creatorID: req.user!.id, organizer: req.user!.id,
		color, isCanceled: false, originCalendarID: created.id, calendars: [created.id],
	}));
	let deliver: Awaited<ReturnType<typeof prepareEventWrites>>;
	try {
		deliver = await prepareEventWrites(importedEvents.map((event) => ({
			event, calendarIDs: [created.id], action: "create",
		})), mutationIdentity);
	} catch (error) {
		if (error instanceof EventWriteError) {
			throw new EventWriteError(error.capability, error.reason,
				`The new calendar was created, but event writing is ${error.reason}. No events were imported; the calendar remains empty.`);
		}
		throw error;
	}
	const committed: import("@musubi/types").Event[] = [];
	try {
		for (const event of importedEvents) {
			const saved = await createEvent(event, [created.id], deliver.outbox);
			committed.push({ ...saved, calendars: [created.id] });
		}
		await deliver(undefined, new Map(committed.map((event) => [event.id, event.revision!])));
	} catch (error) {
		if (!committed.length) throw error;
		const failure = committedFailure(error, committed);
		return res.status(failure.status).json({ ...failure.body, calendar: created, imported: committed.length });
	}
	res.status(201).json({ ...created, imported: importedEvents.length });
}

export function assertImportEventLimit(count: number) {
	if (count > 10_000) {
		throw new BadRequestError(
			"An iCalendar import may contain at most 10,000 events.",
		);
	}
}

// One-shot .ics snapshot of a whole calendar. Any member may export — they can
// already see every event. Reuses the CalDAV adapter's VEVENT serializer, so
// recurrence (RRULE + EXDATE) and all-day semantics round-trip identically.
export async function handlerExportCalendar(req: Request, res: Response) {
	const calendarID = req.params.id as string;
	if (!(await getUserRoleForCalendar(req.user!.id, calendarID))) {
		throw new ForbiddenError("You can't access this calendar.");
	}
	const calendar = await getCalendar(calendarID);
	const rows = await getCalendarEvents(calendarID);

	const vcal = new ICAL.Component("vcalendar");
	vcal.updatePropertyWithValue("version", "2.0");
	vcal.updatePropertyWithValue("prodid", "-//Musubi//EN");
	vcal.updatePropertyWithValue("x-wr-calname", calendar.name);
	for (const row of rows) {
		if (!row.events.deletedAt) vcal.addSubcomponent(toVevent(row.events));
	}

	const filename = `${calendar.name.replace(/[^\w.-]+/g, "_") || "calendar"}.ics`;
	res.setHeader("Content-Type", "text/calendar; charset=utf-8");
	res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
	res.status(200).send(vcal.toString());
}

export async function handlerJoinCalendar(req: Request, res: Response) {
	const calendarID = req.params.calendarId as string;
	// Membership is granted by invite only — a bare calendar id is NOT enough
	// (ids leak via shared events' `calendars` arrays).
	const token = req.body?.token as string | undefined;
	if (!token) {
		throw new ForbiddenError(
			"A valid invite is required to join this calendar.",
		);
	}
	const result = await joinCalendarFromInvite(req.user!.id, token);
	if (result.calendarID !== calendarID) {
		throw new ForbiddenError(
			"A valid invite is required to join this calendar.",
		);
	}

	res.status(200).json(result.added);
}

export async function handlerLeaveCalendar(req: Request, res: Response) {
	const calendarID = req.params.calendarId as string;
	const removal = await removeCalendarMember(req.user!.id, calendarID);
	if (removal.status === "calendar_not_found") {
		throw new NotFoundError("Calendar not found...");
	}
	if (removal.status === "owner") {
		// Would orphan the calendar — transfer ownership (setMemberRole "owner") or delete it.
		throw new BadRequestError(
			"The owner can't leave. Transfer ownership or delete the calendar.",
		);
	}
	if (removal.status === "member_not_found") {
		throw new NotFoundError("Member not found on this calendar...");
	}
	// Tell the leaver's other devices to drop the calendar (mirrors kick below).
	notifyCalendarMembers([req.user!.id], "calendar_removed", { id: calendarID });

	res.sendStatus(200);
}

export async function handlerKickMember(req: Request, res: Response) {
	const calendarID = req.params.calendarId as string;
	const targetUserID = req.params.userId as string;

	await assertCan(req.user!.id, calendarID, "manageMembers");

	const removal = await removeCalendarMember(
		targetUserID,
		calendarID,
		req.user!.id,
	);
	if (removal.status === "calendar_not_found") {
		throw new NotFoundError("Calendar not found...");
	}
	if (removal.status === "not_owner") {
		throw new ForbiddenError("Only the owner can remove members.");
	}
	if (removal.status === "owner") {
		throw new BadRequestError("The calendar owner can't be removed.");
	}
	if (removal.status === "member_not_found") {
		throw new NotFoundError("Member not found on this calendar...");
	}
	// Tell the removed user's client to drop the calendar.
	notifyCalendarMembers([targetUserID], "calendar_removed", { id: calendarID });

	res.sendStatus(200);
}

export async function handlerGetCalendarMembers(req: Request, res: Response) {
	const calendarID = req.params.calendarId as string;
	// Any member can see who's in the calendar; only owners change roles (setMemberRole).
	const role = await getUserRoleForCalendar(req.user!.id, calendarID);
	if (!role) throw new ForbiddenError("You're not a member of this calendar.");
	const members = await getCalendarMembers(calendarID);
	// No email — members only need to recognize each other, not contact-scrape.
	res.status(200).json(
		members.map((m) => ({
			id: m.user.id,
			name: m.user.name,
			image: m.user.image,
			role: m.role,
		})),
	);
}

export async function handlerSetMemberRole(req: Request, res: Response) {
	const calendarID = req.params.calendarId as string;
	const targetUserID = req.params.userId as string;
	const role = req.body?.role;

	if (role !== "viewer" && role !== "editor" && role !== "owner") {
		throw new BadRequestError("Role must be 'viewer', 'editor' or 'owner'.");
	}
	await assertCan(req.user!.id, calendarID, "manageMembers");

	const calendar = await getCalendar(calendarID);
	if (!calendar) throw new NotFoundError("Calendar not found...");
	if (targetUserID === calendar.creatorID) {
		throw new BadRequestError("The calendar owner's role can't be changed.");
	}

	if (role === "owner") {
		// Ownership transfer: only the current owner may hand it off. They step
		// down to editor; creatorID moves so owner-guards keep working. The query
		// locks the calendar and commits all three writes as one transaction.
		if (req.user!.id !== calendar.creatorID) {
			throw new ForbiddenError("Only the owner can transfer ownership.");
		}
		if (calendar.isDefault) {
			throw new BadRequestError(
				"Your personal calendar's ownership can't be transferred.",
			);
		}
		const transfer = await transferCalendarOwnership(
			calendarID,
			req.user!.id,
			targetUserID,
		);
		if (transfer.status === "calendar_not_found") {
			throw new NotFoundError("Calendar not found...");
		}
		if (transfer.status === "not_owner") {
			throw new ForbiddenError("Only the owner can transfer ownership.");
		}
		if (transfer.status === "default_calendar") {
			throw new BadRequestError(
				"Your personal calendar's ownership can't be transferred.",
			);
		}
		if (transfer.status === "external_calendar") {
			throw new BadRequestError(
				"A connected provider calendar's ownership can't be transferred.",
			);
		}
		if (transfer.status === "member_not_found") {
			throw new NotFoundError("Member not found on this calendar...");
		}
		// Role is per-user → personalized payloads, so open clients update live.
		notifyCalendarMembers([targetUserID], "calendar_updated", {
			...transfer.calendar,
			role: "owner",
		});
		notifyCalendarMembers([req.user!.id], "calendar_updated", {
			...transfer.calendar,
			role: "editor",
		});
		return res.status(200).json({ id: targetUserID, role: "owner" });
	}

	const roleUpdate = await setCalendarMemberRole(
		req.user!.id,
		targetUserID,
		calendarID,
		role,
	);
	if (roleUpdate.status === "calendar_not_found") {
		throw new NotFoundError("Calendar not found...");
	}
	if (roleUpdate.status === "not_owner") {
		throw new ForbiddenError("Only the owner can change member roles.");
	}
	if (roleUpdate.status === "owner") {
		throw new BadRequestError("The calendar owner's role can't be changed.");
	}
	if (roleUpdate.status === "member_not_found") {
		throw new NotFoundError("Member not found on this calendar...");
	}

	// Tell the affected user right away — no reload needed to gain/lose edit UI.
	notifyCalendarMembers([targetUserID], "calendar_updated", {
		...calendar,
		role,
	});

	res.status(200).json({ id: targetUserID, role: roleUpdate.member.role });
}
