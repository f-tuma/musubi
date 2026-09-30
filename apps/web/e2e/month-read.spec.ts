import { setTestTheme } from "./theme";
import AxeBuilder from "@axe-core/playwright";
import { PRODUCT_VERSION, type Calendar } from "@musubi/types";
import {
	expect,
	test,
	type BrowserContext,
	type Locator,
	type Page,
	type Route,
} from "@playwright/test";

async function chooseTimeZone(control: Locator, zone: string) {
  await control.click();
  await control.page().getByRole("textbox", { name: "Search Event time zone" }).fill(zone.replaceAll("_", " "));
  await control.page().getByRole("option", { name: zone.replaceAll("_", " "), exact: true }).click();
}

// Geometry assertions and synthetic pointer coordinates require the final layout.
// Keep real motion enabled; wait only for finite transitions already in flight.
async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  });
}

async function expectOrganizerPaintedAbovePopover(editor: Locator) {
  // A modal can receive keyboard input even while an inert popover paints
  // over it. Include that surface in the paint-order probe, then restore it.
  await expect.poll(() => editor.evaluate(node => {
      const surfaces = [...document.querySelectorAll<HTMLElement>('[data-ui="popover-content"]')];
      const previous = surfaces.map(surface => surface.style.pointerEvents);
      try {
        surfaces.forEach(surface => { surface.style.pointerEvents = "auto"; });
        const rect = node.getBoundingClientRect();
        return [[rect.left + 24, rect.top + rect.height * 0.25], [rect.right - 24, rect.top + rect.height * 0.5], [rect.right - 24, rect.bottom - 30]].every(([x, y]) => node.contains(document.elementFromPoint(x, y)));
      } finally { surfaces.forEach((surface, index) => { surface.style.pointerEvents = previous[index]; }); }
    })).toBe(true);
}

const session = {
	session: {
		createdAt: "2026-07-26T14:00:00.000Z",
		expiresAt: "2026-07-27T14:00:00.000Z",
		id: "session-web-qa",
		token: "redacted",
		updatedAt: "2026-07-26T14:00:00.000Z",
		userId: "user-web-qa",
	},
	user: {
		createdAt: "2026-07-26T14:00:00.000Z",
		email: "web-qa@example.invalid",
		emailVerified: true,
		id: "user-web-qa",
		// A profile photo, so the sidebar has one to lose.
		image:
			"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
		name: "Web QA",
		updatedAt: "2026-07-26T14:00:00.000Z",
	},
};

const calendars: Calendar[] = [
	{
		color: "#b3492f",
		creatorID: "user-web-qa",
		id: "personal",
		isDefault: true,
		members: [],
		name: "Personal",
		role: "owner",
	},
	{
		color: "#d6b76b",
		creatorID: "user-web-qa",
		id: "studio",
		members: [],
		name: "Studio",
		role: "owner",
	},
	{
		color: "#365a92",
		creatorID: "user-web-qa",
		id: "family",
		members: [],
		name: "Family",
		role: "editor",
	},
];

/**
 * A crowded account. Twenty calendars is where lists stop being short enough to
 * lay out however they like: Page settings and every calendar picker have to
 * stay inside their box.
 */
const manyCalendars = [
	...calendars,
	...Array.from({ length: 17 }, (_, index) => ({
		color: ["#b3492f", "#d6b76b", "#365a92", "#7a9e7e", "#8a6fa8"][index % 5]!,
		creatorID: "user-web-qa",
		id: `bulk-${index}`,
		members: [],
		name: `Calendar number ${index + 4}`,
		role: "owner",
	})),
];

async function chooseSelectOption(page: Page, label: string, option: string) {
	await page.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

async function openCreateEvent(page: Page) {
	await page
		.getByRole("button", { name: "Create event, meeting or task", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Event", exact: true }).click();
}

function event(
	id: string,
	title: string,
	calendarId: string,
	color: string,
	start: string,
	end: string,
	extra: Record<string, unknown> = {},
) {
	return {
		revision: 1,
		calendars: [calendarId],
		color,
		creatorID: "user-web-qa",
		end,
		hasAttendees: false,
		id,
		isAllDay: false,
		isCanceled: false,
		organizer: "web-qa@example.invalid",
		originCalendarID: calendarId,
		start,
		title,
		...extra,
		recurrence: (extra.recurrence as string | undefined) ?? null,
	};
}

const events = {
	deletedIds: [],
	events: [
		event(
			"weekly-review",
			"Weekly review",
			"personal",
			"#b3492f",
			"2026-07-06T09:00:00.000Z",
			"2026-07-06T10:00:00.000Z",
			{ recurrence: "FREQ=WEEKLY;BYDAY=MO" },
		),
		event(
			"client-call",
			"Client call",
			"studio",
			"#d6b76b",
			"2026-07-08T12:30:00.000Z",
			"2026-07-08T13:30:00.000Z",
		),
		event(
			"studio-retreat",
			"Studio retreat",
			"studio",
			"#d6b76b",
			"2026-07-06T00:00:00.000Z",
			"2026-07-10T00:00:00.000Z",
			{ isAllDay: true, location: "Kokořínsko" },
		),
		event(
			"family-holiday",
			"Family holiday",
			"family",
			"#365a92",
			"2026-07-17T00:00:00.000Z",
			"2026-07-22T00:00:00.000Z",
			{ isAllDay: true },
		),
		event(
			"project-check-in",
			"Project check-in",
			"personal",
			"#b3492f",
			"2026-07-23T07:30:00.000Z",
			"2026-07-23T08:30:00.000Z",
		),
		event(
			"overlap-call",
			"Partner call",
			"studio",
			"#d6b76b",
			"2026-07-23T08:00:00.000Z",
			"2026-07-23T09:00:00.000Z",
		),
		event(
			"client-presentation",
			"Client presentation",
			"studio",
			"#d6b76b",
			"2026-07-24T11:00:00.000Z",
			"2026-07-24T12:00:00.000Z",
		),
		event(
			"theatre-night",
			"Theatre night",
			"family",
			"#365a92",
			"2026-07-25T17:00:00.000Z",
			"2026-07-25T20:00:00.000Z",
		),
		event(
			"design-review",
			"Design review",
			"family",
			"#365a92",
			"2026-08-06T14:00:00.000Z",
			"2026-08-06T15:00:00.000Z",
			{ hasAttendees: true, location: "Studio B" },
		),
		event(
			"studio-open-day",
			"Studio open day",
			"studio",
			"#d6b76b",
			"2026-08-14T00:00:00.000Z",
			"2026-08-14T00:00:00.000Z",
			{ isAllDay: true },
		),
	],
	serverTime: "2026-07-26T14:00:00.000Z",
};

const settings = {
	dateFormat: "dmy",
	defaultCalendarView: "month",
	notificationsOnByDefault: true,
	onboarded: true,
	theme: "system",
	timeFormat: "24h",
	weekStartsOn: "monday",
};

const DEFAULT_PAGE_ID = "11111111-1111-4111-8111-111111111111";

const defaultPage = {
	config: {
		calendarVisibility: { hiddenCalendarIds: [], mode: "all" },
		filters: [],
		schemaVersion: 1,
		view: { configVersion: 1, id: "month", showAdjacentDays: true },
	},
	createdAt: "2026-07-01T00:00:00.000Z",
	id: DEFAULT_PAGE_ID,
	isDefault: true,
	name: "My calendar",
	position: 0,
	revision: 1,
	updatedAt: "2026-07-01T00:00:00.000Z",
};

function respond(route: Route, body: unknown, status = 200) {
	return route.fulfill({
		body: JSON.stringify(body),
		contentType: "application/json",
		headers: { "x-request-id": "playwright-fixture" },
		status,
	});
}

/** Page visibility is edited with the Page's other saved settings. */
async function openPageFilters(page: Page) {
	await page.getByRole("button", { name: "Edit My calendar" }).click();
	const dialog = page.getByRole("dialog", { name: "Page settings" });
	await expect(dialog).toBeVisible();
	const filters = dialog.getByRole("group", { name: "Calendars shown on this page" });
	return { dialog, filters };
}

async function setCalendarVisibility(
	page: Page,
	calendar: string,
	visible: boolean,
) {
	const { dialog, filters } = await openPageFilters(page);
	const button = filters.getByRole("button", { name: calendar });
	if ((await button.getAttribute("aria-pressed")) !== String(visible)) {
		await button.click();
	}
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toBeHidden();
}

async function expectCalendarVisibility(
	page: Page,
	calendar: string,
	visible: boolean,
) {
	const { dialog, filters } = await openPageFilters(page);
	await expect(filters.getByRole("button", { name: calendar })).toHaveAttribute(
		"aria-pressed",
		String(visible),
	);
	await dialog.getByRole("button", { name: "Close page settings" }).click();
}

/**
 * Wait for anything moving to stop.
 *
 * A colour-contrast check on a half-faded element is a coin toss: axe reads the
 * computed background through it and flags not just that element but everything
 * visible underneath. One toast caught mid-fade produced sixty-four violations
 * across a dialog that was fine.
 *
 * Looping animations (spinners) are skipped — they never finish, and waiting on
 * one would hang the suite. A stuck animation degrades to scanning anyway
 * rather than failing, because this is a guard, not an assertion.
 */
async function settleAnimations(page: Page) {
	await page
		.waitForFunction(
			() =>
				document
					.getAnimations()
					.filter(
						(animation) =>
							animation.effect?.getComputedTiming().iterations !== Infinity,
					)
					.every((animation) => animation.playState !== "running"),
			undefined,
			{ timeout: 2_000 },
		)
		.catch(() => undefined);
}

async function expectNoAccessibilityViolations(page: Page) {
	await settleAnimations(page);
	let results;
	try {
		results = await new AxeBuilder({ page }).analyze();
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes("Execution context was destroyed")
		) {
			throw error;
		}
		await page.waitForLoadState("domcontentloaded");
		results = await new AxeBuilder({ page }).analyze();
	}
	expect(results.violations).toEqual([]);
}

function pragueTime(value: string) {
	return new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		hourCycle: "h23",
		minute: "2-digit",
		timeZone: "Europe/Prague",
	}).format(new Date(value));
}

// Takes a Page or a whole BrowserContext: the mock is nothing but route handlers
// over one closure of state, so registering it on a context gives every page in it
// the SAME backend — which is what a two-session test needs.
async function mockAuthenticatedReads(
	page: Page | BrowserContext,
	eventResponse: typeof events = events,
	calendarResponse: typeof calendars = calendars,
	failWritesForCalendarId?: string,
	bypassMobileBlocker = true,
) {
	if (bypassMobileBlocker) {
		await page.addInitScript(() =>
			sessionStorage.setItem("musubi-mobile-web-test-bypass", "true"),
		);
	}

	let authenticated = true;
	let settingsState = { ...settings };
	let settingsRevision = 1;
	let calendarState = calendarResponse.map((calendar) => ({
		...calendar,
	}));
	let eventState = {
		...eventResponse,
		events: eventResponse.events.map((item) => ({ ...item })),
	};
	let attendeeState = [
		{ id: "guest-1", image: null, name: "Guest One", status: "going" },
	];

	await page.route("**/api/auth/get-session", (route) =>
		respond(route, authenticated ? session : null),
	);
	await page.route("**/api/v1/announcements", (route) =>
		respond(route, { announcements: [], isAdmin: false }),
	);
	await page.route("**/api/v1/tasks", (route) => respond(route, { tasks: [] }));
	await page.route("**/api/v1/event-deliveries", route => respond(route, { items: [], nextCursor: null }));
	await page.route("**/api/auth/sign-out", (route) => {
		authenticated = false;
		return respond(route, { success: true });
	});
	await page.route("**/api/v1/calendars", async (route) => {
		const method = route.request().method();
		if (method === "GET") return respond(route, calendarState);

		const body = route.request().postDataJSON() as (typeof calendars)[number];
		if (method === "POST") {
			const created = {
				...body,
				creatorID: session.user.id,
				id: `calendar-${calendarState.length + 1}`,
				members: [],
				role: "owner",
			};
			calendarState = [...calendarState, created];
			return respond(route, created, 201);
		}
		if (method === "PUT") {
			calendarState = calendarState.map((calendar) =>
				calendar.id === body.id ? { ...calendar, ...body } : calendar,
			);
			return respond(
				route,
				calendarState.find((calendar) => calendar.id === body.id),
			);
		}
		if (method === "DELETE") {
			calendarState = calendarState.filter((calendar) => calendar.id !== body.id);
			return respond(route, { ...body, members: [] });
		}
		return respond(route, calendarState);
	});
	// Asked for on every load since reminders landed. Unmocked they 500 against
	// the dev server, and a test that only asserts "no console errors" then fails
	// for a reason that has nothing to do with what it is testing.
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			// No VAPID keys: the "notify me when this browser is closed" toggle
			// stays hidden, which is the state most tests should see.
			pushPublicKey: null,
			socials: [],
			socialsWeb: [],
			syncProviders: ["google"],
		}),
	);
	await page.route("**/api/v1/reminders", (route) =>
		respond(route, {
			calendars: { work: { allDay: null, minutesBefore: 60 } },
			default: {
				allDay: { atMinute: 1080, daysBefore: 1 },
				minutesBefore: 10,
			},
			events: {},
		}),
	);
	await page.route("**/api/v1/reminders/**", (route) =>
		route.fulfill({ body: "", status: 204 }),
	);
	await page.route("**/api/v1/pages", (route) => respond(route, [defaultPage]));
	await page.route("**/api/v1/pages/*", (route) => {
		const body = route.request().postDataJSON() as {
			config: typeof defaultPage.config;
			name: string;
		};
		return respond(route, {
			...defaultPage,
			config: body.config,
			name: body.name,
			revision: defaultPage.revision + 1,
		});
	});
	// No federated servers by default; the federation test overrides this.
	await page.route("**/api/v1/federation/connections", (route) =>
		respond(route, []),
	);
	// Hold the SSE connection open like the real server so EventSource stays
	// connected instead of reconnect-looping against a closed mock.
	await page.route("**/api/stream?clientVersion=*", () => {
		// Intentionally never resolved; Playwright aborts it when the page closes.
		return new Promise<void>(() => {});
	});
	await page.route("**/api/v1/calendars/*/export", (route) =>
		route.fulfill({
			body: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
			contentType: "text/calendar",
			status: 200,
		}),
	);
	await page.route("**/api/v1/calendars/import?*", (route) => {
		const url = new URL(route.request().url());
		const imported = {
			color: url.searchParams.get("color") ?? "#7a9e7e",
			creatorID: session.user.id,
			id: "imported-calendar",
			imported: 1,
			members: [],
			name: url.searchParams.get("name") ?? "Imported calendar",
			role: "owner",
		};
		calendarState = [...calendarState, imported];
		return respond(route, imported, 201);
	});
	await page.route(/\/api\/v1\/events(?:\?.*)?$/, async (route) => {
		const method = route.request().method();

		if (method === "GET") {
			const url = new URL(route.request().url());
			const start = url.searchParams.get("start");
			const end = url.searchParams.get("end");
			if (!start || !end) return respond(route, eventState);
			const startTime = new Date(start).getTime();
			const endTime = new Date(end).getTime();
			return respond(route, {
				...eventState,
				events: eventState.events.filter(
					(event) =>
						event.recurrence ||
						(new Date(event.start).getTime() < endTime &&
							new Date(event.end).getTime() > startTime),
				),
			});
		}

		const request = route.request().postDataJSON();
		const previous = eventState.events.find((item) => item.id === request.id);
		if (
			["PATCH", "DELETE"].includes(method) &&
			previous?.revision !== request.expectedRevision
		)
			return respond(
				route,
				{
					error:
						"This event changed after editing began. Your draft was kept. Refresh and reconcile before saving again.",
					code: "event-revision-conflict",
					localCommitted: false,
					current: previous,
					currentRevision: previous?.revision,
				},
				409,
			);
		const body = (
			method === "PATCH"
				? { ...previous, ...request.patch, revision: previous!.revision + 1 }
				: { ...request, revision: 1 }
		) as (typeof events.events)[number];
		const homeCalendarId = body.originCalendarID ?? body.calendars?.[0];

		if (failWritesForCalendarId && homeCalendarId === failWritesForCalendarId) {
			return route.fulfill({
				body: JSON.stringify({
					error: "ProviderUnavailable",
					message: "Provider unavailable",
					requestId: "provider-write-failed",
				}),
				contentType: "application/json",
				headers: { "x-request-id": "provider-write-failed" },
				status: 502,
			});
		}

		if (method === "POST") {
			eventState = {
				...eventState,
				events: [...eventState.events, body],
			};
			return respond(route, body, 201);
		}

		if (method === "PUT" || method === "PATCH") {
			eventState = {
				...eventState,
				events: eventState.events.map((item) =>
					item.id === body.id ? body : item,
				),
			};
			return respond(route, body);
		}

		if (method === "DELETE") {
			eventState = {
				...eventState,
				events: eventState.events.filter((item) => item.id !== body.id),
			};
			return respond(route, {
				calendars: [],
				id: body.id,
				removed: true,
			});
		}

		return route.abort();
	});
	await page.route("**/api/v1/events/*/attendees", (route) =>
		respond(route, attendeeState),
	);
	await page.route("**/api/v1/events/*/attendance", (route) => {
		const { status } = route.request().postDataJSON() as { status: string };
		attendeeState = attendeeState.filter((item) => item.id !== session.user.id);
		if (status !== "none") {
			attendeeState.push({
				id: session.user.id,
				image: null,
				name: session.user.name,
				status,
			});
		}
		return respond(route, attendeeState);
	});
	await page.route("**/api/v1/events/*/link", (route) => {
		const eventId = route.request().url().split("/").at(-2)!;
		const { calendarID } = route.request().postDataJSON() as {
			calendarID: string;
		};
		const linked = eventState.events.find((item) => item.id === eventId)!;
		const result = {
			...linked,
			calendars: [...linked.calendars, calendarID],
		};
		eventState = {
			...eventState,
			events: eventState.events.map((item) =>
				item.id === eventId ? result : item,
			),
		};
		return respond(route, result);
	});
	await page.route("**/api/v1/events/*/fork", (route) => {
		const eventId = route.request().url().split("/").at(-2)!;
		const { calendarID } = route.request().postDataJSON() as {
			calendarID: string;
		};
		const source = eventState.events.find((item) => item.id === eventId)!;
		const forked = {
			...source,
			calendars: [calendarID],
			id: `${eventId}-fork`,
			originCalendarID: calendarID,
		};
		eventState = {
			...eventState,
			events: [...eventState.events, forked],
		};
		return respond(route, forked, 201);
	});
	await page.route("**/api/v1/users/settings", (route) =>
		respond(route, settingsState),
	);
	await page.route("**/api/v1/users/settings/document", (route) =>
		respond(route, {
			revision: settingsRevision,
			updatedAt: "2026-07-26T14:00:00.000Z",
			value: settingsState,
		}),
	);
	await page.route("**/api/v1/users/me/settings", (route) => {
		const body = route.request().postDataJSON() as {
			baseRevision: number;
			patch: Partial<typeof settings>;
		};
		if (body.baseRevision !== settingsRevision) {
			return respond(
				route,
				{
					current: {
						revision: settingsRevision,
						updatedAt: "2026-07-26T14:00:00.000Z",
						value: settingsState,
					},
					error: "SettingsConflict",
					message: "Settings changed on another device.",
				},
				409,
			);
		}
		settingsRevision += 1;
		settingsState = { ...settingsState, ...body.patch };
		return respond(route, {
			revision: settingsRevision,
			updatedAt: "2026-07-26T14:01:00.000Z",
			value: settingsState,
		});
	});
}

test("redirects an anonymous Month request to sign in", async ({ page }) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));

	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await expect(page).toHaveURL(/\/login\?redirect=/);
	await expect(
		page.getByRole("heading", { name: "Sign in" }),
	).toBeVisible();

	await expectNoAccessibilityViolations(page);
});

test("opens a calendar for a bare /app request", async ({ page }) => {
	// The URL the marketing site links to. It matches the layout and no child,
	// so without an index route a signed-in visitor gets an empty outlet.
	await mockAuthenticatedReads(page);

	await page.goto("/app");

	await expect(page).toHaveURL(/\/app\/p\/[^/]+\/month\?date=/);
	await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
});

test("keeps sign in clear and keyboard-usable on a narrow screen", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 720 });
	await page.route("**/api/auth/get-session", (route) => respond(route, null));

	await page.goto("/login");
	await page.waitForLoadState("networkidle");

	const email = page.getByRole("textbox", { name: "Email" });
	await expect(email).toBeFocused();
	await email.fill("not-an-email");
	await page.getByLabel("Passphrase").fill("long-enough");
	await page.getByRole("button", { exact: true, name: "Continue" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Enter a valid email address.",
	);

	const createAccount = page.getByRole("button", { name: "Create one" });
	await createAccount.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Create your account" }),
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();

	const hasHorizontalOverflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	expect(hasHorizontalOverflow).toBe(false);
	await expectNoAccessibilityViolations(page);
});

test("renders an accessible route state for an unknown page", async ({
	page,
}) => {
	await page.goto("/this-page-does-not-exist");

	await expect(
		page.getByRole("heading", {
			name: "Page not found",
		}),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "Open Musubi" })).toBeVisible();
	await expect(page.getByRole("main")).toHaveAttribute("id", "main-content");
	await expectNoAccessibilityViolations(page);
});

test("reads, filters and signs out of the authenticated Month", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);

	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Studio retreat/ })).toHaveCount(
		5,
	);
	await expect(page.getByRole("button", { name: /Family holiday/ })).toHaveCount(
		6,
	);
	await expect(page.getByRole("button", { name: /Weekly review/ })).toHaveCount(
		5,
	);

	await page
		.getByRole("button", { name: /Studio retreat/ })
		.first()
		.click();
	await expect(
		page.getByText(/Monday, July 6, 2026.*Friday, July 10, 2026/),
	).toBeVisible();
	await page.keyboard.press("Escape");

	await setCalendarVisibility(page, "Studio", false);
	await expect(page.getByRole("button", { name: /Studio retreat/ })).toHaveCount(
		0,
	);

	await openCreateEvent(page);
	await expect(page.getByRole("dialog", { name: "Create event" })).toBeVisible();
	await expect(page.getByRole("menu", { name: "Create", exact: true })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Event title" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Create event, meeting or task", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: "Event", exact: true }).press("Enter");
	await expect(page.getByRole("textbox", { name: "Event title" })).toBeFocused();
	await page.keyboard.press("Escape");

	await expectNoAccessibilityViolations(page);

	// The profile row carries the photo, not just an initial: the session's
	// `image` used to be dropped on the way from the session to the sidebar.
	await expect(page.locator('img[src^="data:image/gif"]')).toBeVisible();

	await page.getByRole("button", { name: "User menu for Web QA" }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login/);
});

test("keeps an empty Month canvas quiet", async ({ page }) => {
	await mockAuthenticatedReads(page, {
		...events,
		events: [],
	});

	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
	await expect(page.getByText("Nothing is scheduled")).toHaveCount(0);
	await expect(page.getByText("No events match")).toHaveCount(0);

	await page.keyboard.press("n");
	await expect(page.getByText("August 2026")).toBeVisible();
	await expect(page.getByText("Nothing is scheduled")).toHaveCount(0);

	await expectNoAccessibilityViolations(page);
});

test("keeps a compact Month fixed and folds excess events into More", async ({
	page,
}) => {
	await page.setViewportSize({ width: 800, height: 720 });
	const crowdedEvents = Array.from({ length: 5 }, (_, index) =>
		event(
			`crowded-${index}`,
			`Crowded event ${index + 1}`,
			"personal",
			"#b3492f",
			`2026-07-23T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
			`2026-07-23T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
		),
	);
	await mockAuthenticatedReads(page, {
		...events,
		events: crowdedEvents,
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const area = page.locator("[data-calendar-area]");
	const month = page.getByRole("grid", { name: "July 2026 calendar" });
	const crowdedDay = page.locator('[data-day-key="2026-07-23"]');
	await expect(month).toHaveAttribute("data-event-capacity", "2");
	await expect(crowdedDay.locator("[data-event-id]")).toHaveCount(1);
	await crowdedDay.getByRole("button", { name: "+4 more" }).click();
	const overflowDialog = page.getByRole("dialog", {
		name: "Thursday, July 23, 2026 events",
	});
	await expect(overflowDialog).toBeVisible();
	await expect(overflowDialog.locator("[data-event-id]")).toHaveCount(5);
	await overflowDialog.evaluate(async (element) => {
		await Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished),
		);
	});
	await expectNoAccessibilityViolations(page);
	await overflowDialog.getByRole("button", { name: /Crowded event 1/ }).click();
	await expect(
		page.getByRole("heading", { name: "Crowded event 1" }),
	).toBeVisible();
	expect(
		await area.evaluate((element) => element.scrollHeight - element.clientHeight),
	).toBeLessThanOrEqual(1);
});

test("reads, filters and continuously loads the authenticated Agenda", async ({
	page,
}) => {
	await page.clock.setFixedTime(new Date("2026-08-13T10:00:00Z"));
	await mockAuthenticatedReads(page);

	await page.goto("/app/p/my-calendar/agenda?date=2026-07-26");

	await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
	await expect(page.getByText("From Jul 26, 2026")).toBeVisible();
	await expect(
		page.getByRole("radio", { name: "Agenda", exact: true }),
	).toHaveAttribute("aria-checked", "true");
	// The DOM stays bounded even though Agenda is one continuous two-year
	// timeline. How many batches fit depends on the viewport, so this asserts
	// the bound rather than one exact batch.
	const initialDays = await page.locator("[data-agenda-date]").count();
	expect(initialDays).toBeGreaterThanOrEqual(14);
	expect(initialDays).toBeLessThanOrEqual(28);
	await expect(page.locator('[data-agenda-date="2026-07-26"]')).toHaveCount(0);
	// One occurrence per loaded week, and the one-offs exactly once each.
	expect(
		await page.getByRole("button", { name: /Weekly review/ }).count(),
	).toBeGreaterThanOrEqual(12);
	await expect(page.getByRole("button", { name: /Design review/ })).toHaveCount(
		1,
	);
	await expect(
		page.getByRole("button", { name: /Studio open day/ }),
	).toHaveCount(1);

	const tomorrowRow = page.locator('[data-agenda-date="2026-08-14"]');
	await expect(tomorrowRow).toContainText("Tomorrow");
	const todayHeights = await tomorrowRow.evaluate((row) => {
		const style = getComputedStyle(row);
		return {
			events: row.children[1]!.getBoundingClientRect().height,
			content: row.getBoundingClientRect().height
				- parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
				- parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
		};
	});
	// The date label must not inflate the event area; day padding is intentional.
	expect(todayHeights.content - todayHeights.events).toBeLessThanOrEqual(1);

	await page.getByRole("button", { name: /Design review/ }).click();
	// Scoped to the preview: the agenda row shows the location too.
	const agendaPreview = page.getByRole("dialog", { name: "Design review" });
	await expect(agendaPreview.getByText("Studio B")).toBeVisible();
	await expect(agendaPreview.getByText("16:00 – 17:00")).toBeVisible();
	await page.keyboard.press("Escape");

	await page
		.getByRole("region", { name: /From Jul 26, 2026 agenda/ })
		.evaluate((agenda) => {
			agenda.parentElement?.scrollTo({
				top: agenda.parentElement.scrollHeight,
			});
		});
	await expect
		.poll(() => page.locator("[data-agenda-date]").count())
		.toBeGreaterThan(initialDays);
	await expect(
		page.getByRole("button", { name: "Previous agenda start" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Next agenda start" }),
	).toHaveCount(0);
	await expect(page).toHaveURL(/[?&]date=2026-07-26/);

	await setCalendarVisibility(page, "Family", false);
	await expect(page.getByRole("button", { name: /Design review/ })).toHaveCount(
		0,
	);

	await expectNoAccessibilityViolations(page);
});

test("renders and navigates the authenticated Week time grid", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	// Pin "now" inside the displayed week so the current-time marker is
	// deterministic regardless of the real date.
	await page.clock.setFixedTime(new Date("2026-07-26T10:00:00"));

	await page.goto("/app/p/my-calendar/week?date=2026-07-26");

	await expect(page.getByText("Jul 20 – 26, 2026")).toBeVisible();
	await expect(
		page.getByRole("radio", { name: "Week", exact: true }),
	).toHaveAttribute("aria-checked", "true");
	await expect(page.locator("[data-time-grid-day]")).toHaveCount(7);
	await expect(
		page.getByRole("button", { name: /All-day event, Family holiday/ }),
	).toHaveCount(1);
	await expect(page.getByRole("button", { name: /Weekly review/ })).toHaveCount(
		1,
	);
	await expect(
		page.getByRole("button", { name: /Project check-in/ }),
	).toHaveCount(1);
	await expect(page.locator("[data-current-time]")).toHaveCount(1);

	await page.getByRole("button", { name: /Weekly review/ }).click();
	await expect(page.getByText("11:00 – 12:00")).toBeVisible();
	await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

	await page.keyboard.press("n");
	await expect(page).toHaveURL(/[?&]date=2026-08-02/);
	await expect(page.getByText("Jul 27 – Aug 2, 2026")).toBeVisible();

	await expectNoAccessibilityViolations(page);
});

test("lays overlapping events over each other, not into slivers", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1400 });
	// Two events that overlap, plus one that starts after the first has ended.
	await mockAuthenticatedReads(page, {
		...events,
		events: [
			event(
				"pp",
				"pp",
				"personal",
				"#b3492f",
				"2026-07-27T12:30:00.000Z",
				"2026-07-27T15:50:00.000Z",
			),
			event(
				"ppp",
				"ppp",
				"personal",
				"#b3492f",
				"2026-07-27T14:45:00.000Z",
				"2026-07-27T17:05:00.000Z",
			),
			event(
				"test",
				"TEST",
				"personal",
				"#b3492f",
				"2026-07-27T16:00:00.000Z",
				"2026-07-27T17:35:00.000Z",
			),
		],
	});
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-27`);

	const column = page.locator("[data-time-grid-column]").first();
	const columnBox = (await column.boundingBox())!;
	const box = async (id: string) =>
		(await page.locator(`[data-time-event="${id}"]`).boundingBox())!;
	const [pp, ppp, test] = await Promise.all([
		box("pp"),
		box("ppp"),
		box("test"),
	]);

	// The later event lies over the earlier one from about halfway across the
	// column, so what stays visible of the first is a readable strip and not the
	// hairline a fixed-pixel cascade leaves.
	expect(ppp.x - pp.x).toBeGreaterThan(columnBox.width * 0.4);
	// It reaches the column's edge, bar the inset every block keeps off the grid
	// line (COLUMN_RIGHT_INSET_PX in time-grid-math).
	expect(ppp.x + ppp.width).toBeGreaterThan(columnBox.x + columnBox.width - 14);
	// It is also marked as covering, which is what earns it the separating ring:
	// two events from one calendar are the same colour.
	await expect(page.locator('[data-time-event="ppp"]')).toHaveAttribute(
		"data-overlapping",
		"",
	);
	// An event that starts after the first one ends is not in its cluster, so it
	// goes back to the column's left edge.
	expect(Math.abs(test.x - pp.x)).toBeLessThan(2);
});

test("uses the shared time grid as a one-column Day", async ({ page }) => {
	await mockAuthenticatedReads(page);

	await page.goto("/app/p/my-calendar/day?date=2026-07-23");

	await expect(page.getByText("Thursday, July 23, 2026")).toBeVisible();
	await expect(
		page.getByRole("radio", { name: "Day", exact: true }),
	).toHaveAttribute("aria-checked", "true");
	await expect(page.locator("[data-time-grid-day]")).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: /Project check-in/ }),
	).toHaveCount(1);
	await expect(page.getByRole("button", { name: /Partner call/ })).toHaveCount(
		1,
	);

	await page.keyboard.press("n");
	await expect(page).toHaveURL(/[?&]date=2026-07-24/);
	await expect(page.getByText("Friday, July 24, 2026")).toBeVisible();
});

test("overlays Day event details without resizing the calendar", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await mockAuthenticatedReads(page);
	await page.goto("/app/p/my-calendar/day?date=2026-07-23");

	const calendarArea = page.locator("[data-calendar-area]");
	const trigger = page.getByRole("button", { name: /Project check-in/ });
	const areaBox = (await calendarArea.boundingBox())!;
	const triggerBox = (await trigger.boundingBox())!;
	await trigger.click();

	const details = page.getByRole("dialog", { name: "Project check-in" });
	await details.evaluate((element) =>
		Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished),
		),
	);
	const detailsBox = (await details.boundingBox())!;

	expect(detailsBox.x).toBe(740);
	expect(detailsBox.y).toBe(0);
	expect(detailsBox.width).toBe(540);
	expect(detailsBox.height).toBe(800);
	const dockedArea = (await calendarArea.boundingBox())!;
	expect(dockedArea.x).toBe(areaBox.x);
	expect(dockedArea.width).toBe(areaBox.width);
	expect(dockedArea.x + dockedArea.width).toBe(detailsBox.x + detailsBox.width);
	await expect(trigger).toBeVisible();
	await expect(page).toHaveURL(/day\?date=2026-07-23/);
	await details.getByRole("button", { name: "Close event details" }).click();
	await expect(details).toHaveCount(0);
	await expect(trigger).toBeFocused();
	expect(await calendarArea.boundingBox()).toEqual(areaBox);
	expect(await trigger.boundingBox()).toEqual(triggerBox);

});

test("creates across chosen calendars, then edits and deletes through confirmed API writes", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await openCreateEvent(page);
	await page.getByRole("textbox", { name: "Event title" }).fill("Release check");
	await page.getByRole("button", { name: /^Choose calendars/ }).click();
	await expect(
		page.getByRole("checkbox", { name: "Show event in Personal" }),
	).toBeChecked();
	await page.getByRole("radio", { name: "Studio as home calendar" }).click();
	await page.getByRole("checkbox", { name: "Show event in Family" }).check();
	const createRequest = page.waitForRequest(
		(request) =>
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/v1/events",
	);
	await page.getByRole("button", { name: "Create", exact: true }).click();
	const createdEvent = (await createRequest).postDataJSON() as {
		calendars: string[];
		originCalendarID: string;
	};
	expect(createdEvent.originCalendarID).toBe("studio");
	expect(createdEvent.calendars).toEqual(["studio", "family"]);

	await expect(page.getByRole("status")).toContainText("Event created.");
	await expect(
		page.getByRole("button", { name: /Release check/ }),
	).toBeVisible();

	await page.getByRole("button", { name: /Release check/ }).click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Event title" })
		.fill("Release readiness");
	await page.getByRole("button", { name: "Save" }).click();

	await expect(page.getByRole("status")).toContainText("Event updated.");
	await expect(
		page.getByRole("button", { name: /Release readiness/ }),
	).toBeVisible();

	await expect(page.getByRole("dialog", { name: "Release readiness" })).toBeVisible();
	await page.getByRole("button", { name: "More event actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await page.getByRole("button", { exact: true, name: "Delete" }).click();

	await expect(page.getByRole("status")).toContainText("Event deleted.");
	await expect(
		page.getByRole("button", { name: /Release readiness/ }),
	).toHaveCount(0);

	await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("creates an event with an exact custom recurrence rule", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(
		"/app/p/my-calendar/event/new?date=2026-07-08&returnDate=2026-07-08&view=month",
	);

	await page.getByRole("textbox", { name: "Event title" }).fill("Rotation");
	await page.getByRole("combobox", { name: "Repeat" }).click();
	await page.getByRole("option", { name: "Custom recurrence" }).click();
	await page.getByRole("spinbutton", { name: "Recurrence interval" }).fill("2");
	await page.getByRole("button", { name: "Monday" }).click();
	await page.getByRole("radio", { name: "After" }).click();
	await page.getByRole("spinbutton", { name: "Occurrence count" }).fill("5");
	await expectNoAccessibilityViolations(page);

	const createRequest = page.waitForRequest(
		(request) =>
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/v1/events",
	);
	await page.getByRole("button", { name: "Create", exact: true }).click();

	expect((await createRequest).postDataJSON().recurrence).toBe(
		"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5",
	);
});

test("chooses an event date from the calendar picker", async ({ page }) => {
	await mockAuthenticatedReads(page);
	const writes: Array<{ start: string }> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "POST") {
			writes.push(
				route.request().postDataJSON() as {
					start: string;
				},
			);
		}
		return route.fallback();
	});
	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await openCreateEvent(page);
	await page.getByRole("textbox", { name: "Event title" }).fill("Planning day");
	await page.getByRole("button", { name: /^Date:/ }).click();
	const picker = page.getByRole("dialog", { name: "Choose date" });
	await expect(picker).toBeVisible();
	await picker.evaluate(async (element) => {
		// Radix mounts the portal before the CSS animation is registered. Wait two
		// frames so Axe measures the settled UI rather than a translucent frame.
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		await Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished),
		);
	});
	await expectNoAccessibilityViolations(page);
	await picker
		.getByRole("gridcell", { name: "Thursday, July 30, 2026" })
		.click();
	await page.getByRole("button", { name: "Create", exact: true }).click();

	await expect(page.getByRole("status")).toContainText("Event created.");
	expect(writes[0]?.start.startsWith("2026-07-30")).toBe(true);
	await expect(
		page
			.locator('[data-day-key="2026-07-30"]')
			.getByRole("button", { name: /Planning day/ }),
	).toBeVisible();
});

test("chooses an event time and duration from the time pickers", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const writes: Array<{ end: string; start: string }> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "POST") {
			writes.push(
				route.request().postDataJSON() as {
					end: string;
					start: string;
				},
			);
		}
		return route.fallback();
	});
	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await openCreateEvent(page);
	await page
		.getByRole("textbox", { name: "Event title" })
		.fill("Portfolio review");

	const start = page.getByRole("combobox", { name: "Start time" });
	const end = page.getByRole("combobox", { name: "End time" });
	await start.click();
	await expectNoAccessibilityViolations(page);
	await page.getByRole("slider", { name: "Hour dial" }).press("Home");
	for (let step = 0; step < 13; step++) await page.getByRole("slider", { name: "Hour dial" }).press("ArrowRight");
	await page.getByRole("slider", { name: "Hour dial" }).press("Enter");
	await page.getByRole("slider", { name: "Minute dial" }).press("Home");
	for (let step = 0; step < 15; step++) await page.getByRole("slider", { name: "Minute dial" }).press("ArrowRight");
	await page.getByRole("slider", { name: "Minute dial" }).press("Enter");
	await expect(start).toHaveValue("13:15");
	await expect(end).toHaveValue("14:15");

	await end.click();
	await page.getByRole("slider", { name: "Hour dial" }).press("Home");
	await expect(page.getByRole("slider", { name: "Hour dial" })).toHaveAttribute("aria-valuenow", "13");
	await page.getByRole("slider", { name: "Hour dial" }).press("Enter");
	await page.getByRole("slider", { name: "Minute dial" }).press("End");
	for (let step = 0; step < 14; step++) await page.getByRole("slider", { name: "Minute dial" }).press("ArrowLeft");
	await page.getByRole("slider", { name: "Minute dial" }).press("Enter");
	await expect(end).toHaveValue("13:45");
	await page.getByRole("button", { name: "Create", exact: true }).click();

	await expect(page.getByRole("status")).toContainText("Event created.");
	expect(pragueTime(writes[0]!.start)).toBe("13:15");
	expect(
		new Date(writes[0]!.end).getTime() - new Date(writes[0]!.start).getTime(),
	).toBe(30 * 60 * 1_000);
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
	test(`creation Inspector keeps actions reachable while switching all-day at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 800 });
		await setTestTheme(page, theme);
		await mockAuthenticatedReads(page);
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
		await openCreateEvent(page);

		const panel = page.getByRole("dialog", { name: "Create event", exact: true });
		const title = panel.getByRole("textbox", { name: "Event title" });
		await expect(title).toBeFocused();
		await title.fill("All-day planning");
		await settleLayout(page);
		const before = (await panel.boundingBox())!;
		const submit = panel.getByRole("button", { name: "Create", exact: true });
		const actionsBefore = await submit.boundingBox();
		const allDay = panel.getByRole("switch", { name: "All day", exact: true });
		await allDay.check();
		await expect(allDay).toBeChecked();
		await expect(panel.getByRole("button", { name: /^Ends:/ })).toContainText("Monday, July 27, 2026");
		await expect(panel.getByRole("combobox", { name: "Start time" })).toHaveCount(0);
		await expect(title).toHaveValue("All-day planning");
		expect(await panel.boundingBox()).toEqual(before);
		expect(await submit.boundingBox()).toEqual(actionsBefore);
		await expect(submit).toBeInViewport();
		expect(before).toEqual({ x: Math.max(0, width - 540), y: 0, width: Math.min(540, width), height: 800 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await expectNoAccessibilityViolations(page);
		await page.screenshot({ path: testInfo.outputPath("create-inspector-all-day.png") });

		await allDay.uncheck();
		await expect(panel.getByRole("combobox", { name: "Start time" })).toBeVisible();
		await allDay.check();
		const write = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/events");
		await submit.click();
		expect((await write).postDataJSON()).toMatchObject({ title: "All-day planning", isAllDay: true, start: "2026-07-26T00:00:00.000Z", end: "2026-07-26T00:00:00.000Z" });
		await expect(panel).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Create event, meeting or task", exact: true })).toBeFocused();
	});
}

test("scrolls a long calendar list inside the creation Inspector", async ({ page }) => {
	await page.setViewportSize({ width: 1890, height: 962 });
	const manyCalendars = [
		...calendars,
		...Array.from({ length: 12 }, (_, index) => ({
			...calendars[0]!,
			color: index % 2 ? "#3f6f8f" : "#8b5f79",
			id: `project-${index}`,
			isDefault: false,
			name: `Project calendar ${index + 1}`,
		})),
	];
	await mockAuthenticatedReads(page, events, manyCalendars);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-08-11`);
	await openCreateEvent(page);
	await page.getByRole("button", { name: /Choose calendars/ }).click();

	const calendarList = page.getByRole("group", {
		name: "Calendars for this event",
	});
	await expect(calendarList).toBeVisible();
	// The form owns the scroller; calendar choices must not introduce another.
	const body = page.getByRole("dialog", { name: "Create event", exact: true }).locator('[data-editor-body]');
	const lastChoice = calendarList.getByRole("radio", { name: "Project calendar 12 as home calendar" });
	await lastChoice.scrollIntoViewIfNeeded();
	await expect(lastChoice).toBeInViewport();
	expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	await lastChoice.click();
	await expect(lastChoice).toBeChecked();

	const popoverBox = (await page
		.getByRole("dialog", { name: "Create event", exact: true })
		.boundingBox())!;
	const actionsBox = (await page
		.getByRole("button", { name: "Expand event editor" })
		.locator("xpath=..")
		.boundingBox())!;
	expect(actionsBox.y).toBeGreaterThanOrEqual(popoverBox.y);
	expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(
		popoverBox.y + popoverBox.height,
	);
});

test("keeps provider failures actionable without assuming a write succeeded", async ({
	page,
}) => {
	const providerCalendars = calendars.map((calendar) =>
		calendar.id === "studio" ? { ...calendar, provider: "google" } : calendar,
	);
	await mockAuthenticatedReads(page, events, providerCalendars, "studio");
	await page.goto("/app/p/my-calendar/month?date=2026-07-26");

	await openCreateEvent(page);
	await page
		.getByRole("textbox", { name: "Event title" })
		.fill("Provider check");
	await page.getByRole("button", { name: /^Choose calendars/ }).click();
	await page.getByRole("radio", { name: "Studio as home calendar" }).click();
	await page.getByRole("button", { name: "Create", exact: true }).click();

	await expect(page.getByRole("alert")).toContainText(
		"Google Calendar did not confirm this change",
	);
	await expect(page.getByRole("alert")).toContainText("provider-write-failed");
	await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(
		"Provider check",
	);
	await expectNoAccessibilityViolations(page);
});

test("handles attendance, linking, forking and recurring delete scopes", async ({
	page,
}) => {
	const runtimeErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));

	await mockAuthenticatedReads(page);
	await page.goto("/app/p/my-calendar/agenda?date=2026-07-26");

	await page.getByRole("button", { name: /Design review/ }).click();
	await page.locator("summary").filter({ hasText: "Attendees · 1" }).click();
	await expect(page.getByText("Guest One")).toBeVisible();
	await page.getByRole("button", { exact: true, name: "Answer" }).click();
	await page.getByRole("menuitem", { name: "Going" }).click();
	await expect(page.getByRole("button", { name: "Going" })).toBeVisible();

	await page.getByRole("button", { name: "More event actions" }).click();
	await page.getByRole("menuitem", { name: "Link to another calendar" }).click();
	await expect(
		page.getByRole("heading", { name: "Link to a calendar" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Link to Personal" }),
	).toBeFocused();
	await expectNoAccessibilityViolations(page);
	// Escape goes back one decision, not out of the event.
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "More event actions" }),
	).toBeFocused();
	await page.getByRole("button", { name: "More event actions" }).click();
	await page.getByRole("menuitem", { name: "Link to another calendar" }).click();
	await page.getByRole("button", { name: "Link to Personal" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Event linked to calendar.",
	);

	await page.getByRole("button", { name: /Design review/ }).click();
	await page.getByRole("button", { name: "More event actions" }).click();
	await page.getByRole("menuitem", { name: "Make a copy" }).click();
	await expect(
		page.getByRole("heading", { name: "Make an independent copy" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Make copy in Studio" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Independent event copy created.",
	);
	await expect(page.getByRole("button", { name: /Design review/ })).toHaveCount(
		2,
	);

	await page.goto("/app/p/my-calendar/week?date=2026-07-26");
	const recurringEvent = page
		.getByRole("button", { name: /Weekly review/ })
		.first();
	await recurringEvent.click();
	const deleteButton = page.getByRole("button", { name: "More event actions" });
	await deleteButton.click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const deleteDialog = page.getByRole("dialog", {
		name: "Delete recurring event",
	});
	await expect(deleteDialog).toBeVisible();
	await deleteDialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	await expect(
		deleteDialog.getByRole("button", { name: "This event", exact: true }),
	).toBeVisible();
	await expect(
		deleteDialog.getByRole("button", {
			name: "This and following events",
		}),
	).toBeVisible();
	await expect(
		deleteDialog.getByRole("button", { name: "Entire series" }),
	).toBeVisible();
	const deleteAccessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(deleteAccessibility.violations).toEqual([]);

	// The inspector stays mounted behind the modal. Escape resumes at the menu that held Delete.
	await page.keyboard.press("Escape");
	await expect(deleteDialog).toHaveCount(0);
	await expect(deleteButton).toBeFocused();
	const deletionRequest = page.waitForRequest(
		(request) =>
			request.url().endsWith("/api/v1/events") && request.method() === "PATCH",
	);
	await deleteButton.click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await page
		.getByRole("dialog", { name: "Delete recurring event" })
		.getByRole("button", { name: "This event", exact: true })
		.click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Occurrence removed.",
	);
	const { scopeEdit, ...update } = (await deletionRequest).postDataJSON();
	expect(scopeEdit).toEqual({ updates: [update], creates: [] });
	await expect(page.getByRole("button", { name: /Weekly review/ })).toHaveCount(
		0,
	);
	const undoRequest = page.waitForRequest(
		(request) =>
			request.url().endsWith("/api/v1/events") && request.method() === "PATCH",
	);
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	const { scopeEdit: undoIntent, ...undo } = (await undoRequest).postDataJSON();
	expect(undoIntent).toEqual({ updates: [undo], creates: [] });
	await expect(recurringEvent).toBeVisible();
	expect(runtimeErrors).toEqual([]);
});

test("exports and imports iCalendar files from calendar management", async ({
	page,
}) => {
	const runtimeErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));

	await mockAuthenticatedReads(page);
	await page.goto("/app/p/my-calendar/month?date=2026-07-26");
	await page.getByRole("button", { name: "Calendars" }).click();
	await expect(
		page.getByRole("heading", { level: 2, name: "Calendars" }),
	).toBeVisible();

	await page.getByRole("button", { name: "Export .ics" }).click();
	await chooseSelectOption(page, "Calendar to export", "Studio");
	const downloadPromise = page.waitForEvent("download");
	await page
		.getByRole("dialog", { name: "Export .ics" })
		.getByRole("button", { name: "Export", exact: true })
		.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("Studio.ics");

	await page.getByRole("button", { name: "Import .ics" }).click();
	await page.getByLabel("Calendar file").setInputFiles({
		buffer: Buffer.from(
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Roadmap\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
		),
		mimeType: "text/calendar",
		name: "roadmap.ics",
	});
	const importDialog = page.getByRole("dialog", { name: "Import .ics" });
	await importDialog.getByRole("textbox", { name: "Name" }).fill("Roadmap");
	await importDialog.getByRole("button", { name: "Import", exact: true }).click();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Imported 1 event into Roadmap.",
	);
	await page.getByRole("button", { name: "Close settings" }).click();
	await expectCalendarVisibility(page, "Roadmap", true);
	expect(runtimeErrors).toEqual([]);
});

test("saves revisioned settings and applies display preferences", async ({
	page,
}) => {
	const runtimeErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));

	await mockAuthenticatedReads(page);
	await page.goto("/app/p/my-calendar/week?date=2026-07-26");
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

	const settingsDialog = page.getByRole("dialog", { name: "Settings" });

	// One window for everything, one section at a time, reached through its tabs.
	const settingsNav = settingsDialog.getByRole("tablist", {
		name: "Settings sections",
	});
	await expect(settingsNav.getByRole("tab")).toHaveText([
		"General",
		"Calendars",
		"Connections",
		"Account",
		"About",
	]);
	await expect(
		settingsNav.getByRole("tab", { exact: true, name: "General" }),
	).toHaveAttribute("aria-selected", "true");

	// Timed and all-day events are asked about separately: an offset cannot
	// answer for a birthday, and the control must not pretend it can.
	// `SettingsSection` is a labelled <section>, which is a region.
	const remindersSection = settingsDialog.getByRole("region").filter({
		has: page.getByRole("heading", { exact: true, name: "Reminders" }),
	});
	await expect(
		remindersSection.getByRole("combobox", { name: "Timed events" }),
	).toHaveText("10 min");
	await expect(
		remindersSection.getByRole("combobox", { name: "All-day events" }),
	).toHaveText("Evening before");
	await chooseSelectOption(page, "Timed events", "30 min");
	await expect(
		remindersSection.getByRole("combobox", { name: "Timed events" }),
	).toHaveText("30 min");

	// Settings answers for events in general. What one calendar does is a fact
	// about that calendar, and is asked there.
	await expect(settingsDialog).not.toContainText("Reminders by calendar");

	await expect(
		settingsDialog.getByRole("radiogroup", { name: "Theme" }),
	).toBeVisible();
	const currentTimeFormat = settingsDialog.getByRole("radio", {
		name: "24 hour",
	});
	await currentTimeFormat.focus();
	await page.keyboard.press("ArrowRight");
	await expect(
		settingsDialog.getByRole("radio", { name: "12 hour" }),
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("status").filter({ hasText: "Settings saved." }),
	).toBeVisible();
	await expectNoAccessibilityViolations(page);
	await page.getByRole("button", { name: "Close settings" }).click();

	await expect(
		page.getByRole("button", { name: /Weekly review/ }),
	).toHaveAttribute("aria-label", /AM/);
	expect(runtimeErrors).toEqual([]);
});

test("recovers when settings fail to load", async ({ page }) => {
	await mockAuthenticatedReads(page);
	let attempts = 0;
	await page.route("**/api/v1/users/settings/document", async (route) => {
		attempts += 1;
		if (attempts === 1) {
			await route.fulfill({
				body: "Cannot GET /api/v1/users/settings/document",
				contentType: "text/plain",
				status: 404,
			});
			return;
		}
		await route.fallback();
	});

	await page.goto("/app/p/my-calendar/week?date=2026-07-26");
	await page.getByRole("button", { name: "Settings" }).click();

	// The HTTP status text never reaches the reader: "Not Found" named the
	// transport and told nobody what to do about it.
	await expect(page.getByRole("alert")).toContainText(
		"Settings could not be loaded.",
	);
	await expect(page.getByRole("alert")).not.toContainText("Not Found");
	await expect(page.getByText("Loading settings…")).toHaveCount(0);
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("keeps settings usable as a mobile sheet", async ({ page }) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("button", { name: "Settings" }).click();
	const sheet = page.getByRole("dialog", { name: "Settings" });
	await sheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);

	const box = (await sheet.boundingBox())!;
	expect(box.x).toBe(0);
	expect(Math.round(box.width)).toBe(390);
	// The settings window is a standing sheet: full height, so sections never resize it.
	expect(Math.round(box.height)).toBe(720);
	await expect(sheet.getByRole("heading", { name: "Appearance" })).toBeVisible();
	await sheet.getByRole("radio", { name: "Dark" }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(
		page.getByRole("status").filter({ hasText: "Settings saved." }),
	).toBeVisible();

	// At this width the window is list → detail: back to the sections, then
	// into Account, without the sheet changing size.
	await sheet.getByRole("button", { exact: true, name: "Settings" }).click();
	await sheet.getByRole("button", { exact: true, name: "Account" }).click();
	await expect(
		sheet.getByRole("heading", { level: 2, name: "Account" }),
	).toBeVisible();
	const after = (await sheet.boundingBox())!;
	expect(Math.round(after.height)).toBe(Math.round(box.height));
	await expect(sheet.getByRole("button", { name: /Display name/ })).toBeVisible();
	await expectNoAccessibilityViolations(page);
});

test("resolves the default page and switches between pages", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const workPageId = "22222222-2222-4222-8222-222222222222";
	await page.route("**/api/v1/pages", (route) =>
		respond(route, [
			defaultPage,
			{
				config: {
					calendarVisibility: { calendarIds: [], mode: "include" },
					filters: [],
					schemaVersion: 1,
					view: {
						configVersion: 1,
						density: "comfortable",
						id: "week",
						weekend: true,
					},
				},
				createdAt: "2026-07-01T00:00:00.000Z",
				id: workPageId,
				isDefault: false,
				name: "Work",
				position: 1,
				revision: 1,
				updatedAt: "2026-07-01T00:00:00.000Z",
			},
		]),
	);

	// The "default" sentinel redirects to the real default Page, keeping view/date.
	await page.goto("/app/p/default/month?date=2026-07-26");
	await expect(page).toHaveURL(new RegExp(`/app/p/${DEFAULT_PAGE_ID}/month`));
	await expect(page).toHaveURL(/[?&]date=2026-07-26/);

	// Both pages are listed; selecting one uses its saved view without losing date.
	await expect(
		page.getByRole("button", { exact: true, name: "My calendar" }),
	).toBeVisible();
	await page.getByRole("button", { exact: true, name: "Work" }).click();
	await expect(page).toHaveURL(new RegExp(`/app/p/${workPageId}/week`));
	await expect(page).toHaveURL(/[?&]date=2026-07-26/);
});

test("creates a page from the sidebar and deletes it again", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const workPageId = "22222222-2222-4222-8222-222222222222";
	const writes: Array<{ body?: unknown; method: string }> = [];
	let pageState: unknown[] = [defaultPage];

	await page.route("**/api/v1/pages", async (route) => {
		if (route.request().method() === "POST") {
			const body = route.request().postDataJSON() as {
				config: unknown;
				name: string;
			};
			writes.push({ body, method: "POST" });
			const created = {
				...defaultPage,
				config: body.config,
				id: workPageId,
				isDefault: false,
				name: body.name,
				position: 1,
			};
			pageState = [defaultPage, created];
			return respond(route, created, 201);
		}
		return respond(route, pageState);
	});
	await page.route(`**/api/v1/pages/${workPageId}`, async (route) => {
		if (route.request().method() !== "DELETE") return route.fallback();
		writes.push({ method: "DELETE" });
		pageState = [defaultPage];
		return respond(route, { id: workPageId });
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "New page" }).click();
	const newPage = page.getByRole("dialog");
	await newPage.getByLabel("Page name").fill("Work");
	await newPage.getByRole("radio", { name: "Briefcase" }).click();
	await newPage.getByRole("button", { name: "Create page" }).click();

	// The new page opens straight away, keeping the date.
	await expect(page).toHaveURL(new RegExp(`/app/p/${workPageId}/month`));
	await expect(page).toHaveURL(/[?&]date=2026-07-26/);
	await expect(
		page.getByRole("button", { exact: true, name: "Work" }),
	).toBeVisible();

	// Deleting the open page falls back to the default page.
	await page.getByRole("button", { name: "Edit Work" }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Delete page" })
		.click();
	// Soft-deleted with no restore endpoint, so this one asks before it goes.
	await page
		.getByRole("dialog", { name: "Delete “Work”?" })
		.getByRole("button", { name: "Delete page" })
		// The confirmation renders inside the settings dialog it guards, so the
		// trigger is in scope too; the confirm's own action is the later one.
		.last()
		.click();

	await expect(page).toHaveURL(new RegExp(`/app/p/${DEFAULT_PAGE_ID}/month`));
	await expect(
		page.getByRole("button", { exact: true, name: "Work" }),
	).toBeHidden();
	expect(writes.map((write) => write.method)).toEqual(["POST", "DELETE"]);
	// Started from what was on screen, as an explicit include list.
	expect(writes[0]!.body).toMatchObject({
		config: {
			calendarVisibility: {
				calendarIds: ["personal", "studio", "family"],
				mode: "include",
			},
			icon: "briefcase",
			view: { configVersion: 1, id: "month", showAdjacentDays: true },
		},
		name: "Work",
	});
});

test("moves and resizes an event by dragging it", async ({ page }) => {
	await mockAuthenticatedReads(page);
	const writes: Array<{ end: string; start: string }> = [];
	// Record the write, then let the shared mock apply it to its event state —
	// otherwise the refetch that follows would undo the move.
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON().patch as {
				end: string;
				start: string;
			};
			writes.push({ end: body.end, start: body.start });
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-23`);
	// "Project check-in" is 07:30–08:30 UTC on this day.
	const block = page.getByRole("button", { name: /Project check-in/ }).first();
	await expect(block).toBeVisible();
	const before = (await block.boundingBox())!;

	// A drag has to travel past the threshold, so step the pointer.
	await page.mouse.move(before.x + before.width / 2, before.y + 12);
	await page.mouse.down();
	await page.mouse.move(before.x + before.width / 2, before.y + 40, {
		steps: 6,
	});
	await page.mouse.up();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Event moved.",
	);
	expect(writes).toHaveLength(1);
	// Moved later in the day, and the duration is preserved.
	const moved = writes[0]!;
	expect(new Date(moved.start).getTime()).toBeGreaterThan(
		new Date("2026-07-23T07:30:00.000Z").getTime(),
	);
	expect(new Date(moved.end).getTime() - new Date(moved.start).getTime()).toBe(
		60 * 60_000,
	);

	// Resizing from the bottom edge changes only the end.
	const afterMove = (await block.boundingBox())!;
	await page.mouse.move(
		afterMove.x + afterMove.width / 2,
		afterMove.y + afterMove.height - 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		afterMove.x + afterMove.width / 2,
		afterMove.y + afterMove.height + 40,
		{ steps: 6 },
	);
	await page.mouse.up();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Event resized.",
	);
	expect(writes).toHaveLength(2);
	const resized = writes[1]!;
	expect(resized.start).toBeUndefined(); // PATCH must omit the unchanged start.
	expect(new Date(resized.end).getTime()).toBeGreaterThan(
		new Date(moved.end).getTime(),
	);
});

test("drags an empty interval to pre-fill quick create", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-30`);

	const column = page.locator("[data-time-grid-column]").first();
	await expect(column).toBeVisible();
	// The grid opens scrolled near the working day, which would put 02:00 above
	// the viewport.
	await page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(
			'[data-calendar-area]',
		);
		if (scroller) scroller.scrollTop = 0;
	});
	const bounds = (await column.boundingBox())!;
	// 64px per hour at comfortable density: 128px down is 02:00, dragging 96px
	// further selects three quarters of an hour past that.
	const from = bounds.y + 128;

	await page.mouse.move(bounds.x + bounds.width / 2, from);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2, from + 96, { steps: 8 });

	// The chosen interval is visible before the popover opens.
	await expect(page.getByText("02:00–03:30")).toBeVisible();
	await page.mouse.up();

	// Quick create opens with the dragged length, not a default hour.
	const start = page.getByLabel("Start time");
	const end = page.getByLabel("End time");
	await expect(start).toHaveValue("02:00");
	await expect(end).toHaveValue("03:30");
});

test("keeps the chosen interval visible while quick create is open", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-30`);
	const column = page.locator("[data-time-grid-column]").first();
	// Wait for the grid before scrolling it, or the scroll lands on nothing and
	// the click falls outside the columns.
	await expect(column).toBeVisible();
	await page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(
			'[data-calendar-area]',
		);
		if (scroller) scroller.scrollTop = 0;
	});

	const bounds = (await column.boundingBox())!;
	// A plain click, not a drag: the slot it picked should still be shown.
	await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + 192);

	await expect(page.getByLabel("Start time")).toHaveValue("03:00");
	await expect(page.getByText("03:00–04:00")).toBeVisible();

	// Dismissing the popover clears it again.
	await page.keyboard.press("Escape");
	await expect(page.getByText("03:00–04:00")).toHaveCount(0);
});

test("a background drag dismisses the old draft before a new gesture creates", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// One draft from a plain click.
	const firstCell = page.locator('[data-day-key="2026-07-07"]');
	const firstBox = (await firstCell.boundingBox())!;
	await page.mouse.click(
		firstBox.x + firstBox.width / 2,
		firstBox.y + firstBox.height - 6,
	);
	await expect(page.getByRole("dialog", { name: "Create event" })).toBeVisible();
	await expect(page.locator("[data-draft]")).toHaveCount(1);

	await settleLayout(page);
	// The first background gesture only dismisses the current panel.
	const from = page.locator('[data-day-key="2026-07-28"]');
	const to = page.locator('[data-day-key="2026-07-30"]');
	const fromBox = (await from.boundingBox())!;
	const toBox = (await to.boundingBox())!;
	await page.mouse.move(
		fromBox.x + fromBox.width / 2,
		fromBox.y + fromBox.height - 6,
	);
	await page.mouse.down();
	await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 6, {
		steps: 8,
	});
  await page.mouse.up();
  await expect(page.locator("[data-live]")).toHaveCount(0);
  await expect(page.locator("[data-draft]")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Create event" })).toHaveCount(0);
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height - 6);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 6, { steps: 8 });
  await expect(page.locator("[data-live]")).toHaveCount(3);
  await page.mouse.up();
	await expect(page.getByRole("dialog", { name: "Create event" })).toBeVisible();
	await expect(page.locator("[data-draft]")).toHaveCount(3);
	await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
		"Tuesday, July 28, 2026",
	);
});

test("keeps the event preview open while its text is being selected", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page
		.getByRole("button", { name: /Design review/ })
		.first()
		.click();
	const preview = page.locator('[data-event-preview]');
	await expect(preview).toBeVisible();
	await preview.evaluate((el) =>
		Promise.all(el.getAnimations().map((animation) => animation.finished)),
	);

	// Dragging across the title is how you copy it. Focus leaves the text as the
	// drag starts, which Radix reports as an interaction outside the layer — the
	// preview used to close on the way.
	const title = preview.getByRole("heading", { name: "Design review" });
	const box = (await title.boundingBox())!;
	await page.mouse.move(box.x + 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
		steps: 8,
	});
	await page.mouse.up();

	await expect(preview).toBeVisible();
	expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
		"Design review",
	);
	// The grid behind it stays unselectable, so a drag there is always a gesture
	// and never a stray selection — which Chromium would cancel the drag for.
	expect(
		await page.locator("[data-calendar-area]").evaluate((el) => {
			const style = getComputedStyle(el);
			return style.userSelect || style.getPropertyValue("-webkit-user-select");
		}),
	).toBe("none");
});

test("flicks sideways to change period, but a held drag still creates", async ({
	page,
}) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.locator("[data-calendar-area]")).toBeVisible();

	// Playwright's touchscreen only taps, so the gesture is dispatched directly.
	// pointerType is what separates a finger from the mouse here.
	const touchDrag = async (dx: number, dy = 0, holdMs = 0) => {
    await settleLayout(page);
    return page.evaluate(
			async ([shiftX, shiftY, hold]) => {
				const area = document.querySelector("[data-calendar-area]")!;
				const box = area.getBoundingClientRect();
				const from = {
					x: box.left + box.width / 2,
					y: box.top + box.height / 2,
				};
				const common = {
					bubbles: true,
					cancelable: true,
					pointerId: 7,
					pointerType: "touch",
				};
				const target = document.elementFromPoint(from.x, from.y) ?? area;
				target.dispatchEvent(
					new PointerEvent("pointerdown", {
						...common,
						clientX: from.x,
						clientY: from.y,
					}),
				);
				if (hold) await new Promise((done) => setTimeout(done, hold as number));
				for (const step of [0.5, 1]) {
					window.dispatchEvent(
						new PointerEvent("pointermove", {
							...common,
							clientX: from.x + (shiftX as number) * step,
							clientY: from.y + (shiftY as number) * step,
						}),
					);
				}
				window.dispatchEvent(
					new PointerEvent("pointerup", {
						...common,
						clientX: from.x + (shiftX as number),
						clientY: from.y + (shiftY as number),
					}),
				);
			},
			[dx, dy, holdMs] as const,
		);
  };

	// Flick left for the next period, right for the previous one.
	await touchDrag(-120);
	await expect(page).toHaveURL(/date=2026-08-01/);
	await settleLayout(page);
	await expect(page.locator("[data-live], [data-draft]")).toHaveCount(0);
	await touchDrag(120);
	await expect(page).toHaveURL(/date=2026-07-01/);

	// Scrolling must win when the gesture is mostly vertical.
	await touchDrag(20, 140);
	await expect(page).toHaveURL(/date=2026-07-01/);

	// Past the hold the same finger is dragging out a range, so it creates instead
	// of paging — one shared constant decides which, so neither can double-fire.
	await touchDrag(-120, 0, 350);
	await expect(page.locator("[data-draft]")).toHaveCount(3);
	await expect(page).toHaveURL(/date=2026-07-01/);
});

test("reorders pages by dragging a row, and by keyboard", async ({ page }) => {
	await mockAuthenticatedReads(page);
	const workPageId = "22222222-2222-4222-8222-222222222222";
	const writes: string[][] = [];
	let pageState = [
		defaultPage,
		{
			...defaultPage,
			id: workPageId,
			isDefault: false,
			name: "Work",
			position: 1,
		},
	];
	await page.route("**/api/v1/pages", (route) => respond(route, pageState));
	await page.route("**/api/v1/pages/reorder", async (route) => {
		const body = route.request().postDataJSON() as { pageIds: string[] };
		writes.push(body.pageIds);
		pageState = body.pageIds.map((id, position) => ({
			...pageState.find((page) => page.id === id)!,
			position,
		}));
		return respond(route, pageState);
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	const rows = page.locator('[data-page-row]');
	// Retrying assertion: the order is painted optimistically and then replaced by
	// the response, so a one-shot read can land between the two.
	const order = page.locator('[data-page-row] > button');
	await expect(rows).toHaveCount(2);
	await expect(order).toHaveText(["My calendar", "Work"]);

	// Management stays fixed below the Pages scroller; reveal the drag target
	// before taking viewport coordinates instead of pressing through its clip.
	await rows.nth(1).scrollIntoViewIfNeeded();
	await expect(rows.nth(0)).toBeInViewport({ ratio: 0.99 });
	await expect(rows.nth(1)).toBeInViewport({ ratio: 0.99 });
	// Drag the second row above the first.
	const first = (await rows.nth(0).boundingBox())!;
	const second = (await rows.nth(1).boundingBox())!;
	await page.mouse.move(
		second.x + second.width / 2,
		second.y + second.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(first.x + first.width / 2, first.y + 4, { steps: 6 });
	await page.mouse.up();

	// The write leaves on release; poll rather than reading the array straight away.
	await expect.poll(() => writes).toEqual([[workPageId, DEFAULT_PAGE_ID]]);
	await expect(order).toHaveText(["Work", "My calendar"]);
	// The release ended a drag, so it must not also have opened that page.
	await expect(page).toHaveURL(new RegExp(`/app/p/${DEFAULT_PAGE_ID}/month`));

	// Alt+arrows are the keyboard path to the same move (R10).
	await rows
		.nth(1)
		.getByRole("button", { exact: true, name: "My calendar" })
		.focus();
	await page.keyboard.press("Alt+ArrowUp");
	await expect.poll(() => writes[1]).toEqual([DEFAULT_PAGE_ID, workPageId]);
	await expect(order).toHaveText(["My calendar", "Work"]);
});

test("moves an event to another day in the month grid", async ({ page }) => {
	await mockAuthenticatedReads(page);
	const writes: Array<{ end: string; start: string }> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON().patch as {
				end: string;
				start: string;
			};
			writes.push({ end: body.end, start: body.start });
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	const chip = page.getByRole("button", { name: /Project check-in/ }).first();
	await expect(chip).toBeVisible();
	const from = (await chip.boundingBox())!;
	const target = page.locator('[data-day-key="2026-07-27"]');
	const to = (await target.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 8,
	});
	await expect(target).toHaveAttribute("data-drop-target", "");
	await page.mouse.up();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Event moved.",
	);
	expect(writes).toHaveLength(1);
	// The date moved by a day and the time of day is preserved.
	const moved = writes[0]!;
	expect(new Date(moved.start).toISOString()).toContain("2026-07-27");
	expect(new Date(moved.start).getUTCHours()).toBe(7);
	expect(new Date(moved.end).getTime() - new Date(moved.start).getTime()).toBe(
		60 * 60_000,
	);
});

test("moves an event with the keyboard", async ({ page }) => {
	await mockAuthenticatedReads(page);
	const writes: Array<{ end: string; start: string }> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON().patch as {
				end: string;
				start: string;
			};
			writes.push({ end: body.end, start: body.start });
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-23`);
	const block = page.getByRole("button", { name: /Project check-in/ }).first();
	await block.focus();

	// Alt+Down moves by one snap interval; the change is announced.
	await page.keyboard.press("Alt+ArrowDown");
	await expect(page.locator('[data-slot="toast-region"]')).toContainText("now ");
	expect(writes).toHaveLength(1);
	expect(
		new Date(writes[0]!.end).getTime() - new Date(writes[0]!.start).getTime(),
	).toBe(60 * 60_000);

	// Alt+Shift+Down lengthens it instead of moving it.
	await block.focus();
	await page.keyboard.press("Alt+Shift+ArrowDown");
	expect(writes).toHaveLength(2);
	expect(writes[1]!.start).toBeUndefined(); // Resizing only patches the end.
	expect(new Date(writes[1]!.end).getTime()).toBeGreaterThan(
		new Date(writes[0]!.end).getTime(),
	);
});

test("cancels a drag with Escape and leaves the event alone", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	let writes = 0;
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") writes += 1;
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-23`);
	const block = page.getByRole("button", { name: /Project check-in/ }).first();
	await expect(block).toBeVisible();
	const before = (await block.boundingBox())!;

	await page.mouse.move(before.x + before.width / 2, before.y + 12);
	await page.mouse.down();
	await page.mouse.move(before.x + before.width / 2, before.y + 60, {
		steps: 6,
	});
	await page.keyboard.press("Escape");
	await page.mouse.up();

	// Escape cancels the drag, not the screen: nothing is written and the block
	// returns to where it was.
	expect(writes).toBe(0);
	await expect(page.getByRole("dialog", { name: "Project check-in" })).toHaveCount(0);
	const after = (await block.boundingBox())!;
	expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});

test("changes time grid density from the page editor", async ({ page }) => {
	await mockAuthenticatedReads(page);
	let savedDensity: string | undefined;
	const weekPage = {
		...defaultPage,
		config: {
			...defaultPage.config,
			view: {
				configVersion: 1,
				density: "comfortable",
				id: "week",
				weekend: true,
			},
		},
	};
	await page.route("**/api/v1/pages", (route) => respond(route, [weekPage]));
	await page.route(`**/api/v1/pages/${DEFAULT_PAGE_ID}`, async (route) => {
		const body = route.request().postDataJSON() as {
			config: { view: { density?: string } };
		};
		savedDensity = body.config.view.density;
		return respond(route, { ...weekPage, config: body.config, revision: 2 });
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-26`);

	// The grid height is derived from the same geometry as the event maths, so a
	// density change has to move it.
	const canvas = page.locator("[data-time-grid-canvas]");
	await expect(canvas).toBeVisible();
	const canvasHeight = async () => (await canvas.boundingBox())?.height ?? 0;

	const comfortable = await canvasHeight();
	expect(comfortable).toBeGreaterThan(0);

	await page.getByRole("button", { name: "Edit My calendar" }).click();
	await chooseSelectOption(page, "Row height", "Compact");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Save", exact: true })
		.click();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Page saved.",
	);
	expect(savedDensity).toBe("compact");
	// Saved, so the grid geometry follows — the dialog previews nothing live.
	await expect(async () => {
		expect(await canvasHeight()).toBeLessThan(comfortable);
	}).toPass();
});

test("keeps transient views out of saved Page filters", async ({ page }) => {
	await mockAuthenticatedReads(page);
	let saved:
		| { config?: { calendarVisibility?: unknown; view?: unknown } }
		| undefined;
	const workPageId = "22222222-2222-4222-8222-222222222222";
	const workPage = {
		...defaultPage,
		config: {
			...defaultPage.config,
			icon: "briefcase" as const,
			view: {
				configVersion: 1 as const,
				density: "comfortable" as const,
				id: "week" as const,
				weekend: true,
			},
		},
		id: workPageId,
		isDefault: false,
		name: "Work",
		position: 1,
	};
	await page.route("**/api/v1/pages", (route) =>
		respond(route, [defaultPage, workPage]),
	);
	await page.route(`**/api/v1/pages/${DEFAULT_PAGE_ID}`, async (route) => {
		saved = route.request().postDataJSON() as typeof saved;
		return respond(route, {
			...defaultPage,
			config: saved?.config,
			revision: 2,
		});
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await setCalendarVisibility(page, "Studio", false);
	await page.getByRole("radio", { name: "Agenda" }).click();

	await page.getByRole("button", { exact: true, name: "Work" }).click();
	await expect(page).toHaveURL(`/app/p/${workPageId}/week?date=2026-07-26`);
	await page.getByRole("button", { exact: true, name: "My calendar" }).click();
	await expect(page).toHaveURL(
		`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`,
	);

	expect(saved?.config?.calendarVisibility).toEqual({
		hiddenCalendarIds: ["studio"],
		mode: "all",
	});
	expect(saved?.config?.view).toEqual({
		configVersion: 1,
		id: "month",
		showAdjacentDays: true,
	});
	await expect(
		page.getByRole("region", { name: "Unsaved Page changes" }),
	).toHaveCount(0);
});

test("edits and saves a page's calendar visibility", async ({ page }) => {
	await mockAuthenticatedReads(page);
	let saved: { config?: { calendarVisibility?: unknown } } | undefined;
	await page.route(`**/api/v1/pages/${DEFAULT_PAGE_ID}`, async (route) => {
		const body = route.request().postDataJSON() as {
			config?: { calendarVisibility?: unknown };
			name: string;
		};
		saved = body;
		return respond(route, {
			...defaultPage,
			config: body.config,
			name: body.name,
			revision: 2,
		});
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: "Filters" })).toHaveCount(0);

	await page.getByRole("button", { name: "Edit My calendar" }).click();
	const settings = page.getByRole("dialog");
	// A brand-new surface with a custom icon radiogroup — check it before saving.
	await expectNoAccessibilityViolations(page);
	await settings.getByRole("button", { name: "Studio" }).click();
	await settings.getByRole("button", { name: "Save", exact: true }).click();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Page saved.",
	);
	expect(saved?.config?.calendarVisibility).toEqual({
		hiddenCalendarIds: ["studio"],
		mode: "all",
	});
	// Reopening Page settings reflects the saved visibility.
	await expectCalendarVisibility(page, "Studio", false);
});

test("surfaces a page save conflict without overwriting", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.route(`**/api/v1/pages/${DEFAULT_PAGE_ID}`, (route) =>
		route.fulfill({
			body: JSON.stringify({
				current: { ...defaultPage, revision: 9 },
				error: "PAGE_CONFLICT",
				message: "Page changed on another device.",
				requestId: "page-conflict",
			}),
			contentType: "application/json",
			headers: { "x-request-id": "page-conflict" },
			status: 409,
		}),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Edit My calendar" }).click();
	const conflicted = page.getByRole("dialog");
	await conflicted.getByRole("button", { name: "Studio" }).click();
	await conflicted.getByRole("button", { name: "Save", exact: true }).click();

	await expect(
		page.getByText("This page changed on another device", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Save as a copy" }),
	).toBeVisible();
});

test("applies a realtime page created in another session", async ({ page }) => {
	// Replace EventSource with a controllable fake so the test can push a server
	// event deterministically (Playwright can't stream a real SSE response).
	await page.addInitScript(() => {
		class FakeEventSource {
			onmessage: ((event: { data: string }) => void) | null = null;
			readyState = 1;
			constructor(public url: string) {
				(window as unknown as { __sse: FakeEventSource[] }).__sse ??= [];
				(window as unknown as { __sse: FakeEventSource[] }).__sse.push(this);
			}
			close() {
				this.readyState = 2;
			}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
	});

	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(
		page.getByRole("button", { exact: true, name: "My calendar" }),
	).toBeVisible();

	const sharedPage = {
		...defaultPage,
		id: "33333333-3333-4333-8333-333333333333",
		isDefault: false,
		name: "Shared plan",
		position: 1,
	};
	await page.evaluate(
		(data) => {
			const sockets = (
				window as unknown as {
					__sse?: Array<{ onmessage: ((e: { data: string }) => void) | null }>;
				}
			).__sse;
			sockets?.[sockets.length - 1]?.onmessage?.({ data });
		},
		JSON.stringify({ payload: { page: sharedPage }, type: "page_created" }),
	);

	// The page created elsewhere shows up without a manual refresh.
	await expect(
		page.getByRole("button", { exact: true, name: "Shared plan" }),
	).toBeVisible();
});

test("creates, renames and deletes a calendar", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "Calendars" }).click();
	const settingsWindow = page.getByRole("dialog", { name: "Settings" });
	await expect(
		settingsWindow.getByRole("heading", { level: 2, name: "Calendars" }),
	).toBeVisible();

	// The group mark and the calendar dots share one column.
	const sourceIcon = settingsWindow
		.getByRole("region", { name: "Musubi" })
		.locator('[data-provider="musubi"]')
		.first();
	const calendarSwatch = settingsWindow
		.locator("[data-calendar-swatch]")
		.first();
	const [sourceBox, swatchBox] = await Promise.all([
		sourceIcon.boundingBox(),
		calendarSwatch.boundingBox(),
	]);
	expect(sourceBox).not.toBeNull();
	expect(swatchBox).not.toBeNull();
	expect(
		Math.abs(
			sourceBox!.x + sourceBox!.width / 2 - (swatchBox!.x + swatchBox!.width / 2),
		),
	).toBeLessThanOrEqual(1.5);

	await settingsWindow.getByRole("button", { name: "New calendar" }).click();
	const calendarDialog = page.getByRole("dialog", { name: "New calendar" });
	const newName = calendarDialog.getByPlaceholder("New calendar");
	const newColor = calendarDialog.getByRole("button", {
		name: /New calendar color:/,
	});
	const [nameBox, colorBox] = await Promise.all([
		newName.boundingBox(),
		newColor.boundingBox(),
	]);
	expect(nameBox).not.toBeNull();
	expect(colorBox).not.toBeNull();
	expect(Math.abs(nameBox!.y - colorBox!.y)).toBeLessThanOrEqual(1);
	expect(colorBox!.x).toBeGreaterThan(nameBox!.x + nameBox!.width);
	expect(Math.abs(nameBox!.height - colorBox!.height)).toBeLessThanOrEqual(1);

	// Create
	await page.getByPlaceholder("New calendar").fill("Travel");
	await page
		.getByRole("button", { name: "New calendar color: #B3A48A" })
		.click();
	await expect(page.getByRole("dialog", { name: "Choose color" })).toBeVisible();
	const colorPickerAccessibility = await new AxeBuilder({ page })
		.include('[data-ui="color-picker-popover"]')
		.analyze();
	expect(colorPickerAccessibility.violations).toEqual([]);
	await page.getByRole("option", { name: "Moss, #A8B5A0" }).click();
	await expect(
		page.getByRole("button", {
			name: "New calendar color: #A8B5A0",
		}),
	).toBeVisible();
	const createRequest = page.waitForRequest(
		(request) =>
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/v1/calendars",
	);
	await calendarDialog.getByRole("button", { name: "Create", exact: true }).click();
	expect((await createRequest).postDataJSON()).toMatchObject({
		color: "#A8B5A0",
		name: "Travel",
	});
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Travel created.",
	);
	const travelRow = page.getByRole("listitem").filter({ hasText: "Travel" });
	await expect(travelRow).toBeVisible();
	await expect(travelRow.locator("[data-calendar-swatch]")).toHaveCSS(
		"background-color",
		"rgb(168, 181, 160)",
	);

	// Rename
	await page.getByRole("button", { name: "Settings for Travel" }).click();
	const calendarSettings = page.getByRole("dialog", { name: "Calendar settings" });
	await calendarSettings.getByRole("textbox", { name: "Name" }).fill("Trips");
	await calendarSettings.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Calendar updated.",
	);
	await expect(
		page.getByRole("listitem").filter({ hasText: "Trips" }),
	).toBeVisible();

	// Delete lives in the calendar's own settings, behind the same accessible
	// confirmation and focus policy as the rest of the UI.
	await page.getByRole("button", { name: "Settings for Trips" }).click();
	const deleteButton = calendarSettings.getByRole("button", { name: "Delete calendar" });
	await deleteButton.click();
	const deleteDialog = page.getByRole("dialog", {
		name: "Delete “Trips”?",
	});
	await expect(deleteDialog).toBeVisible();
	await expect(
		deleteDialog.getByRole("button", { name: "Cancel" }),
	).toBeFocused();
	await deleteDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(deleteButton).toBeFocused();

	await deleteButton.click();
	await deleteDialog.getByRole("button", { name: "Delete calendar" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Trips deleted.",
	);
	await expect(
		page.getByRole("listitem").filter({ hasText: "Trips" }),
	).toHaveCount(0);
});

test("keeps the settings window one size across sections", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 600 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Calendars" }).click();
	const dialog = page.getByRole("dialog", { name: "Settings" });
	await dialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const first = (await dialog.boundingBox())!;
	for (const section of ["General", "Connections", "Account", "About", "Calendars"]) {
		await dialog.getByRole("tab", { exact: true, name: section }).click();
		await expect(
			dialog.getByRole("heading", { level: 2, name: section }),
		).toBeVisible();
		const box = (await dialog.boundingBox())!;
		expect(Math.round(box.width)).toBe(Math.round(first.width));
		expect(Math.round(box.height)).toBe(Math.round(first.height));
	}
});

test("creates a calendar inside a connected account", async ({ page }) => {
	const withAccount = [
		calendars[0]!,
		{
			...calendars[1]!,
			accountId: "google-work",
			accountLabel: "work@example.com",
			provider: "google",
		},
	];
	await mockAuthenticatedReads(page, events, withAccount);
	let created: { accountId?: string; provider?: string } | undefined;
	await page.route("**/api/v1/calendars", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		created = route.request().postDataJSON();
		return respond(
			route,
			{
				accountId: "google-work",
				accountLabel: "work@example.com",
				color: "#B3A48A",
				creatorID: "web-qa",
				id: "cal-new",
				isDefault: false,
				members: [],
				name: "Studio hours",
				provider: "google",
				role: "owner",
			},
			201,
		);
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Calendars" }).click();
	await page
		.getByRole("dialog", { name: "Settings" })
		.getByRole("button", { name: "New calendar" })
		.click();
	const dialog = page.getByRole("dialog", { name: "New calendar" });

	await dialog.getByPlaceholder("New calendar").fill("Studio hours");
	// The destination includes the connected account alongside Musubi.
	await dialog.getByRole("combobox", { name: "Account", exact: true }).click();
	await page.getByRole("option", { name: "work@example.com" }).click();
	await dialog.getByRole("button", { name: "Create", exact: true }).click();

	// Provider and account go with it, which is what makes the server create it on
	// Google first and import the mirror. The closed dialog is the flow finishing:
	// an error would have kept it open, with a message under the name.
	await expect(dialog).toHaveCount(0);
	expect(created).toMatchObject({
		accountId: "google-work",
		name: "Studio hours",
		provider: "google",
	});
});

test("groups calendars by server and connected account", async ({ page }) => {
	const groupedCalendars = [
		calendars[0]!,
		{
			...calendars[1]!,
			accountId: "google-work",
			accountLabel: "work@example.com",
			provider: "google",
		},
		{
			...calendars[2]!,
			accountId: "google-work",
			accountLabel: "work@example.com",
			provider: "google",
		},
	];
	await mockAuthenticatedReads(page, events, groupedCalendars);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "Calendars" }).click();
	const dialog = page.getByRole("dialog", { name: "Settings" });
	const musubiGroup = dialog.getByRole("region", { name: "Musubi" });
	const googleGroup = dialog.getByRole("region", {
		name: "work@example.com",
	});

	await expect(
		musubiGroup.getByRole("listitem").filter({ hasText: "Personal" }),
	).toBeVisible();
	await expect(
		googleGroup.getByRole("listitem").filter({ hasText: "Studio" }),
	).toBeVisible();
	await expect(
		googleGroup.getByRole("listitem").filter({ hasText: "Family" }),
	).toBeVisible();
	// The group is the account; its mark is the provider's.
	await expect(googleGroup.locator('[data-provider="google"]')).toHaveCount(1);
	// A synced calendar is a calendar: it can be renamed, recoloured and shared
	// with people here, the same as one kept on this server. The server renames it
	// on the provider first and refuses if the account is somebody else's.
	await expect(
		googleGroup.getByRole("button", { name: "Settings for Studio" }),
	).toBeVisible();
	await expect(
		googleGroup.getByRole("button", { name: "Share Studio" }),
	).toBeVisible();
	// Deleting is not offered, because on a provider it is not reversible. The
	// reversible thing — stop syncing — is in its place, inside the calendar's
	// own settings rather than loose in the list.
	await expect(googleGroup.getByRole("button", { name: /Delete|Stop syncing/ })).toHaveCount(0);
	await googleGroup.getByRole("button", { name: "Settings for Studio" }).click();
	const studioSettings = page.getByRole("dialog", { name: "Calendar settings" });
	await expect(
		studioSettings.getByRole("button", { name: "Delete calendar" }),
	).toHaveCount(0);
	await expect(
		studioSettings.getByRole("button", { name: "Stop syncing" }),
	).toBeVisible();
	await studioSettings.getByRole("button", { name: "Close calendar settings" }).click();

	const [musubiBox, googleBox] = await Promise.all([
		musubiGroup.boundingBox(),
		googleGroup.boundingBox(),
	]);
	expect(musubiBox?.y).toBeLessThan(googleBox?.y ?? 0);
	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);
});

test("keeps a calendar's reminder on the calendar, viewer or not", async ({
	page,
}) => {
	const saved: Array<{ body: unknown; url: string }> = [];
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/reminders/calendars/**", (route) => {
		saved.push({
			body: route.request().postDataJSON() as unknown,
			url: route.request().url(),
		});
		return route.fulfill({ body: "", status: 204 });
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Calendars" }).click();
	const dialog = page.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();

	// Family is shared with this account as an editor rather than owned, and the
	// row still offers its settings: when your own phone rings is not the
	// owner's call.
	await dialog.getByRole("button", { name: "Settings for Family" }).click();
	const sheet = page.getByRole("dialog", { name: "Calendar settings" });
	await expect(sheet).toBeVisible();

	const choices = sheet.getByRole("radiogroup", { name: "Remind me" });
	await expect(choices).toBeVisible();
	// No rule of its own yet, so it follows the account default.
	await expect(sheet.getByRole("radio", { name: "Default" })).toHaveAttribute(
		"aria-checked",
		"true",
	);

	await sheet.getByRole("radio", { name: "Evening before" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Reminder saved.",
	);
	expect(saved).toHaveLength(1);
	expect(saved[0]?.url).toContain("/api/v1/reminders/calendars/family");
	expect(saved[0]?.body).toEqual({
		rule: { allDay: { atMinute: 1080, daysBefore: 1 }, minutesBefore: null },
	});

	// The label sits above the choices, so a five-option bar gets the full width
	// instead of being squeezed into the half a row leaves it.
	const [labelBox, choiceBox] = await Promise.all([
		sheet.getByText("Remind me", { exact: true }).boundingBox(),
		choices.boundingBox(),
	]);
	expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(choiceBox!.y + 1);
	// Every option readable: an option clipped to less than its text is the bug
	// this row had when the label sat beside it.
	for (const label of ["Off", "10 min", "1 hour", "Evening before"]) {
		const option = choices.getByRole("radio", { exact: true, name: label });
		const fits = await option.evaluate(
			(node) => node.scrollWidth <= node.clientWidth + 1,
		);
		expect(fits, `${label} is clipped`).toBe(true);
	}

	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);
});

test("offers a reload when the server has moved past this tab", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	// Registered after the helper's, so this one answers.
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			pushPublicKey: null,
			socials: [],
			socialsWeb: [],
			syncProviders: ["google"],
			version: "9.9.9",
		}),
	);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const banner = page.getByRole("status").filter({ hasText: "A newer Musubi" });
	await expect(banner).toBeVisible();

	// Offers, never takes over: someone may be mid-sentence in an event.
	await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("stays quiet when the server is behind this tab", async ({ page }) => {
	await mockAuthenticatedReads(page);
	// The self-hosting case: a server older than the app it serves. Reloading
	// fetches the same bundle again, so there is nothing to offer.
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			pushPublicKey: null,
			socials: [],
			socialsWeb: [],
			syncProviders: ["google"],
			version: "0.0.1",
		}),
	);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();

	await expect(
		page.getByRole("status").filter({ hasText: "A newer Musubi" }),
	).toHaveCount(0);
});

test("does not ask twice for a reload that changed nothing", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			pushPublicKey: null,
			socials: [],
			socialsWeb: [],
			syncProviders: ["google"],
			version: "9.9.9",
		}),
	);
	// Releases land API first, web second. Between the two the reload lands on
	// the same bundle, and a bar that returns each time reads as a broken app.
	await page.addInitScript(() =>
		sessionStorage.setItem("musubi-reloaded-for", "9.9.9"),
	);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();

	await expect(
		page.getByRole("status").filter({ hasText: "A newer Musubi" }),
	).toHaveCount(0);
});

test("manages members and invite links for a calendar", async ({ page }) => {
	await mockAuthenticatedReads(page);
	let members = [
		{ id: "user-web-qa", image: null, name: "Web QA", role: "owner" },
		{ id: "member-2", image: null, name: "Sam Rivers", role: "viewer" },
	];
	let invites: Array<{ id: string }> = [];
	let inviteSeq = 0;
	const empty = (route: Route) => route.fulfill({ body: "", status: 200 });

	await page.route("**/api/v1/calendars/*/members/*", (route) => {
		const method = route.request().method();
		const memberId = route.request().url().split("/").pop();
		if (method === "PUT") {
			const role = (route.request().postDataJSON() as { role: string }).role;
			members = members.map((member) =>
				member.id === memberId ? { ...member, role } : member,
			);
			return empty(route);
		}
		if (method === "DELETE") {
			members = members.filter((member) => member.id !== memberId);
			return empty(route);
		}
		return route.fallback();
	});
	await page.route("**/api/v1/calendars/*/members", (route) =>
		respond(route, members),
	);
	await page.route("**/api/v1/calendars/*/invites", (route) =>
		respond(route, invites),
	);
	let inviteRequest:
		| { expiresAt: null | string; maxUses: null | number }
		| undefined;
	await page.route("**/api/v1/calendars/invites", (route) => {
		inviteSeq += 1;
		inviteRequest = route.request().postDataJSON();
		const created = {
			calendarID: "44444444-4444-4444-8444-444444444444",
			expiresAt: inviteRequest!.expiresAt,
			id: `invite-${inviteSeq}`,
			maxUses: inviteRequest!.maxUses,
			uses: 0,
		};
		invites = [...invites, created];
		return respond(route, created, 201);
	});
	await page.route("**/api/v1/calendars/invites/*", (route) => {
		const inviteId = route.request().url().split("/").pop();
		invites = invites.filter((invite) => invite.id !== inviteId);
		return empty(route);
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Calendars" }).click();
	await page.getByRole("button", { name: "Share Studio" }).click();

	await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
	await expect(page.getByText("Sam Rivers", { exact: true })).toBeVisible();
	const sharingDialog = page.getByRole("dialog", { name: "Share Studio" });
	await sharingDialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);

	// Promote Sam to editor through the row's role select.
	await chooseSelectOption(page, "Sam Rivers role", "Editor");
	await expect(
		sharingDialog.getByRole("combobox", { name: "Sam Rivers role" }),
	).toHaveText("Editor");

	// Create then revoke an invite link. Both limits are fillable rather than a
	// short preset list, and the header close makes a second Done footer redundant.
	await expect(sharingDialog.getByRole("button", { name: "Done" })).toHaveCount(
		0,
	);
	await expect(sharingDialog.locator("footer")).toHaveCount(0);
	const expiryInput = sharingDialog.getByRole("spinbutton", {
		name: "Expires after days",
	});
	const peopleInput = sharingDialog.getByRole("spinbutton", {
		name: "How many people",
	});
	await expect(expiryInput).toHaveValue("7");
	await expect(sharingDialog.getByText("Expires after (days)")).toBeVisible();
	await expiryInput.fill("10");
	await peopleInput.fill("5");
	const createInviteButton = sharingDialog.getByRole("button", {
		name: "Create invite link",
	});
	const emailInput = sharingDialog.getByRole("textbox", { name: "Email an invitation" });
	const emailBox = (await emailInput.boundingBox())!;
	const sendBox = (await sharingDialog.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
	// Email stays readable and uses the same control height as its action.
	expect(emailBox.width).toBeGreaterThan(240);
	expect(Math.abs(emailBox.height - sendBox.height)).toBeLessThanOrEqual(1);
	await createInviteButton.click();
	await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveValue(
		/\/invite\/invite-1$/,
	);
	expect(inviteRequest).toMatchObject({ maxUses: 5 });
	// Ten days as entered, counted from now rather than left open forever.
	const expiry = new Date(inviteRequest!.expiresAt!).getTime() - Date.now();
	expect(expiry).toBeGreaterThan(9.5 * 24 * 60 * 60_000);
	expect(expiry).toBeLessThan(10.5 * 24 * 60 * 60_000);
	await page.getByRole("button", { name: "Revoke invite link" }).click();
	await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveCount(
		0,
	);

	// Remove Sam entirely.
	await page.getByRole("button", { name: "Actions for Sam Rivers" }).click();
	await page.getByRole("menuitem", { name: "Remove Sam Rivers" }).click();
	await expect(page.getByText("Sam Rivers", { exact: true })).toHaveCount(0);
});

test("keeps calendar sharing usable as a mobile sheet", async ({ page }) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/calendars/*/members", (route) =>
		respond(route, [
			{ id: "user-web-qa", image: null, name: "Web QA", role: "owner" },
			{ id: "member-2", image: null, name: "Sam Rivers", role: "viewer" },
		]),
	);
	await page.route("**/api/v1/calendars/*/invites", (route) =>
		respond(route, []),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("button", { name: "Calendars" }).click();
	await page.getByRole("button", { name: "Share Studio" }).click();

	const sheet = page.getByRole("dialog", { name: "Share Studio" });
	await sheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const box = (await sheet.boundingBox())!;
	expect(box.x).toBe(0);
	expect(Math.round(box.width)).toBe(390);
	expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(721);
	await expect(
		sheet.getByRole("combobox", { name: "Sam Rivers role" }),
	).toBeVisible();

	const transfer = sheet.getByRole("button", { name: "Actions for Sam Rivers" });
	await transfer.click();
	await page.getByRole("menuitem", { name: "Make owner" }).click();
	const confirmation = page.getByRole("dialog", {
		name: "Make Sam Rivers the owner?",
	});
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(confirmation).toHaveCount(0);
	await expect(transfer).toBeFocused();

	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);
});

test("transfers calendar ownership", async ({ page }) => {
	await mockAuthenticatedReads(page);
	let members = [
		{ id: "user-web-qa", image: null, name: "Web QA", role: "owner" },
		{ id: "member-2", image: null, name: "Sam Rivers", role: "editor" },
	];
	let transferredRole: string | undefined;
	await page.route("**/api/v1/calendars/*/members/*", (route) => {
		if (route.request().method() === "PUT") {
			const role = (route.request().postDataJSON() as { role: string }).role;
			const memberId = route.request().url().split("/").pop();
			transferredRole = role;
			members = members.map((member) =>
				member.id === memberId ? { ...member, role } : member,
			);
			return route.fulfill({ body: "", status: 200 });
		}
		return route.fallback();
	});
	await page.route("**/api/v1/calendars/*/members", (route) =>
		respond(route, members),
	);
	await page.route("**/api/v1/calendars/*/invites", (route) =>
		respond(route, []),
	);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Calendars" }).click();
	await page.getByRole("button", { name: "Share Studio" }).click();
	await expect(page.getByText("Sam Rivers", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Actions for Sam Rivers" }).click();
	await page.getByRole("menuitem", { name: "Make owner" }).click();
	const transferDialog = page.getByRole("dialog", {
		name: "Make Sam Rivers the owner?",
	});
	await expect(transferDialog).toBeVisible();
	await expect(
		transferDialog.getByText(
			"Sam Rivers takes over members, invite links and settings of Studio. You become an editor.",
		),
	).toBeVisible();
	await transferDialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);

	await transferDialog
		.getByRole("button", { name: "Transfer ownership" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Sam Rivers is now the owner of Studio.",
	);
	await expect(page.getByRole("dialog", { name: "Share Studio" })).toHaveCount(
		0,
	);
	expect(transferredRole).toBe("owner");
});

test("connects and disconnects calendar providers", async ({ page }) => {
	const runtimeErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));

	const withExternal: Calendar[] = [
		...calendars,
		{
			accountId: "acc-1",
			accountLabel: "work@gmail.com",
			color: "#4285f4",
			creatorID: "user-web-qa",
			id: "g-cal-1",
			members: [],
			name: "Work (Google)",
			provider: "google",
			role: "owner",
			syncStatus: "active",
		},
	];
	await mockAuthenticatedReads(page, events, withExternal);
	let disconnectBody: unknown;
	let caldavBody: unknown;
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			minClientVersion: "0.1.2",
			socials: ["google"],
			syncProviders: ["google", "microsoft", "caldav"],
		}),
	);
	await page.route("**/api/v1/users/connections/disconnect", (route) => {
		disconnectBody = route.request().postDataJSON();
		return route.fulfill({ body: "", status: 200 });
	});
	await page.route("**/api/v1/users/connections/caldav", (route) => {
		if (route.request().method() === "POST") {
			caldavBody = route.request().postDataJSON();
			return route.fulfill({ body: "", status: 200 });
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Connections" }).click();
	await expect(
		page.getByRole("heading", { exact: true, name: "Connections" }),
	).toBeVisible();
	const connectionsDialog = page.getByRole("dialog", {
		name: "Settings",
	});
	await connectionsDialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	await expect(connectionsDialog.locator("footer")).toHaveCount(0);
	await expect(
		connectionsDialog.getByRole("button", { name: "Done" }),
	).toHaveCount(0);
	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);

	for (const title of [
		"Connected accounts",
		"Join a shared calendar",
	] as const) {
		const titleBox = await connectionsDialog
			.getByRole("heading", { name: title })
			.locator("..")
			.boundingBox();
		// The account heading includes a full-sized refresh target.
		expect(titleBox!.height).toBeLessThanOrEqual(80);
	}

	// Capability-gated add buttons.
	await expect(
		page.getByRole("button", { exact: true, name: "Google Calendar" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { exact: true, name: "Apple / iCloud" }),
	).toBeVisible();

	// Connected account shows and disconnects.
	await expect(page.getByText("work@gmail.com")).toBeVisible();
	await page.getByRole("button", { name: "Disconnect work@gmail.com" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"work@gmail.com disconnected.",
	);
	expect(disconnectBody).toEqual({ accountId: "acc-1", provider: "google" });

	// CalDAV/Apple connect form.
	await page
		.getByRole("button", { exact: true, name: "Apple / iCloud" })
		.click();
	await page
		.getByRole("textbox", { name: "Apple ID email" })
		.fill("me@icloud.com");
	await page.getByPlaceholder("Password").fill("app-specific-pw");
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Calendar connected.",
	);
	expect(caldavBody).toEqual({
		password: "app-specific-pw",
		serverUrl: "https://caldav.icloud.com",
		username: "me@icloud.com",
	});
	expect(runtimeErrors).toEqual([]);
});

test("keeps connections usable as a mobile sheet", async ({ page }) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page, events, [
		...calendars,
		{
			accountId: "acc-1",
			accountLabel: "work@gmail.com",
			color: "#4285f4",
			creatorID: "user-web-qa",
			id: "g-cal-1",
			members: [],
			name: "Work (Google)",
			provider: "google",
			role: "owner",
			syncStatus: "reconnect_required",
		},
	]);
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			minClientVersion: "0.1.2",
			socials: ["google"],
			syncProviders: ["google", "microsoft", "caldav"],
		}),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("button", { name: "Connections" }).click();

	const sheet = page.getByRole("dialog", { name: "Settings" });
	await sheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const box = (await sheet.boundingBox())!;
	expect(box.x).toBe(0);
	expect(Math.round(box.width)).toBe(390);
	expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(721);

	const account = sheet
		.getByRole("listitem")
		.filter({ hasText: "work@gmail.com" });
	await expect(account).toContainText("Needs attention");
	await expect(account.getByRole("button", { name: "Reconnect" })).toBeVisible();

	const apple = sheet.getByRole("button", {
		exact: true,
		name: "Apple / iCloud",
	});
	await apple.click();
	const icloud = page.getByRole("dialog", { name: "Connect iCloud" });
	const email = icloud.getByRole("textbox", { name: "Apple ID email" });
	await expect(email).toBeFocused();
	await icloud.getByRole("button", { name: "Cancel" }).click();
	await expect(apple).toBeFocused();

	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);
});

test("shows federated calendars and reports an unreachable server", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	let disconnectedServer: unknown;
	await page.route("**/api/v1/federation/connections", (route) =>
		respond(route, [
			{
				id: "conn-1",
				label: "friends.example",
				remoteUserID: "fed_1",
				server: "https://friends.example",
			},
			{
				id: "conn-2",
				label: "dead.example",
				remoteUserID: "fed_2",
				server: "https://dead.example",
			},
		]),
	);
	await page.route("**/api/v1/federation/s/conn-1/api/v1/server", (route) =>
		respond(route, {
			email: true,
			pushPublicKey: null,
			socials: [],
			socialsWeb: [],
			syncProviders: [],
			version: "0.1.4",
		}),
	);
	// Reachable server: one shared calendar with one event.
	await page.route("**/api/v1/federation/s/conn-1/api/v1/calendars", (route) =>
		respond(route, [
			{
				color: "#8a6fae",
				creatorID: "remote-owner",
				id: "remote-cal-1",
				members: [],
				name: "Book club",
				role: "editor",
			},
		]),
	);
	await page.route("**/api/v1/federation/s/conn-1/api/v1/events", (route) =>
		respond(route, {
			deletedIds: [],
			events: [
				event(
					"remote-book-club",
					"Book club meetup",
					"remote-cal-1",
					"#8a6fae",
					"2026-07-23T17:00:00.000Z",
					"2026-07-23T18:30:00.000Z",
				),
			],
			serverTime: "2026-07-26T14:00:00.000Z",
		}),
	);
	// Unreachable server: the gateway reports 502.
	await page.route("**/api/v1/federation/s/conn-2/**", (route) =>
		route.fulfill({
			body: JSON.stringify({
				error: "FederatedServerUnreachable",
				message: "The connected Musubi server could not be reached.",
			}),
			contentType: "application/json",
			status: 502,
		}),
	);
	await page.route("**/api/v1/users/connections/musubi", (route) => {
		disconnectedServer = route.request().postDataJSON();
		return route.fulfill({ body: "", status: 200 });
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// The remote calendar and its event render like any other.
	await expectCalendarVisibility(page, "Book club", true);
	await page
		.locator('[data-day-key="2026-07-23"]')
		.getByRole("button", { name: /\+\d+ more/ })
		.click();
	const dayEvents = page.getByRole("dialog", {
		name: "Thursday, July 23, 2026 events",
	});
	await expect(
		dayEvents.getByRole("button", { name: /Book club meetup/ }),
	).toBeVisible();
	// A dead server must not take the home calendar down with it.
	await expect(
		page.getByRole("button", { name: /Weekly review/ }).first(),
	).toBeVisible();

	await page.getByRole("button", { name: "Connections" }).click();
	await expect(
		page.getByRole("heading", { name: "Musubi servers" }),
	).toBeVisible();
	const deadRow = page.getByRole("listitem").filter({ hasText: "dead.example" });
	await expect(deadRow).toContainText("Unreachable");
	// Transient failures offer a retry, not a re-invite.
	await expect(
		page.getByRole("button", { name: "Retry dead.example" }),
	).toBeVisible();
	const friendsRow = page
		.getByRole("listitem")
		.filter({ hasText: "friends.example" });
	await expect(friendsRow).not.toContainText("Unreachable");
	// Federation is the one clock nobody here winds, so what that server runs
	// has to be readable rather than guessed at.
	await expect(friendsRow).toContainText("0.1.4");
	// A server that will not say stays unlabelled instead of claiming a version.
	await expect(deadRow).not.toContainText("·");

	// Disconnecting a federated server uses its own endpoint, not provider disconnect.
	await page.getByRole("button", { name: "Disconnect dead.example" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"dead.example disconnected.",
	);
	expect(disconnectedServer).toEqual({ server: "https://dead.example" });
});

test("routes federated event writes through the gateway", async ({ page }) => {
	await mockAuthenticatedReads(page);
	const remoteCalendar = {
		color: "#8a6fae",
		creatorID: "user-web-qa",
		id: "remote-cal-1",
		members: [],
		name: "Book club",
		role: "owner",
	};
	let remoteEvents = [
		event(
			"remote-book-club",
			"Book club meetup",
			"remote-cal-1",
			"#8a6fae",
			"2026-07-23T17:00:00.000Z",
			"2026-07-23T18:30:00.000Z",
		),
	];
	let homeWrites = 0;
	const gatewayWrites: string[] = [];

	// Registered first: a later route wins in Playwright, and the gateway paths
	// below also end in /api/v1/events. Any home write here would be a routing bug.
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() !== "GET") {
			homeWrites += 1;
			return respond(route, {}, 500);
		}
		return route.fallback();
	});

	await page.route("**/api/v1/federation/connections", (route) =>
		respond(route, [
			{
				id: "conn-1",
				label: "friends.example",
				remoteUserID: "fed_1",
				server: "https://friends.example",
			},
		]),
	);
	await page.route("**/api/v1/federation/s/conn-1/api/v1/calendars", (route) =>
		respond(route, [remoteCalendar]),
	);
	await page.route(
		"**/api/v1/federation/s/conn-1/api/v1/events",
		async (route) => {
			const method = route.request().method();
			if (method === "GET") {
				return respond(route, {
					deletedIds: [],
					events: remoteEvents,
					serverTime: "2026-07-26T14:00:00.000Z",
				});
			}
			gatewayWrites.push(method);
			const request = route.request().postDataJSON();
			const previous = remoteEvents.find((item) => item.id === request.id)!;
			expect(method).toBe("PATCH");
			expect(request.expectedRevision).toBe(previous.revision);
			const body = {
				...previous,
				...request.patch,
				revision: previous.revision + 1,
			};
			remoteEvents = remoteEvents.map((item) =>
				item.id === body.id ? body : item,
			);
			return respond(route, body);
		},
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page
		.locator('[data-day-key="2026-07-23"]')
		.getByRole("button", { name: /\+\d+ more/ })
		.click();
	await page
		.getByRole("dialog", {
			name: "Thursday, July 23, 2026 events",
		})
		.getByRole("button", { name: /Book club meetup/ })
		.click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Event title" })
		.fill("Book club — new venue");
	await page.getByRole("button", { name: "Save" }).click();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Event updated.",
	);
	expect(gatewayWrites).toEqual(["PATCH"]);
	expect(homeWrites).toBe(0);
	await expect(
		page.getByRole("button", { name: /Book club — new venue/ }),
	).toBeVisible();
});

test("distinguishes a revoked federated token from an outage", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/federation/connections", (route) =>
		respond(route, [
			{
				id: "conn-1",
				label: "revoked.example",
				remoteUserID: "fed_1",
				server: "https://revoked.example",
			},
		]),
	);
	// The origin rejects our member token (kicked, or the token expired). The
	// gateway relays that status unchanged.
	await page.route("**/api/v1/federation/s/conn-1/**", (route) =>
		route.fulfill({
			body: JSON.stringify({ error: "Unauthorized", message: "Unauthorized" }),
			contentType: "application/json",
			status: 401,
		}),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Connections" }).click();

	const row = page.getByRole("listitem").filter({ hasText: "revoked.example" });
	// A dead credential needs a new invite — retrying would never fix it.
	await expect(row).toContainText("Needs a new invite");
	await expect(
		page.getByRole("button", { name: "Retry revoked.example" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Disconnect revoked.example" }),
	).toBeVisible();
});

test("refreshes federated calendars on a realtime federated_sync", async ({
	page,
}) => {
	await page.addInitScript(() => {
		class FakeEventSource {
			onmessage: ((event: { data: string }) => void) | null = null;
			readyState = 1;
			constructor(public url: string) {
				(window as unknown as { __sse: FakeEventSource[] }).__sse ??= [];
				(window as unknown as { __sse: FakeEventSource[] }).__sse.push(this);
			}
			close() {
				this.readyState = 2;
			}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
	});

	await mockAuthenticatedReads(page);
	let remoteName = "Book club";
	await page.route("**/api/v1/federation/connections", (route) =>
		respond(route, [
			{
				id: "conn-1",
				label: "friends.example",
				remoteUserID: "fed_1",
				server: "https://friends.example",
			},
		]),
	);
	await page.route("**/api/v1/federation/s/conn-1/api/v1/calendars", (route) =>
		respond(route, [
			{
				color: "#8a6fae",
				creatorID: "remote-owner",
				id: "remote-cal-1",
				members: [],
				name: remoteName,
				role: "viewer",
			},
		]),
	);
	await page.route("**/api/v1/federation/s/conn-1/api/v1/events", (route) =>
		respond(route, {
			deletedIds: [],
			events: [],
			serverTime: "2026-07-26T14:00:00.000Z",
		}),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expectCalendarVisibility(page, "Book club", true);

	// The remote calendar is renamed on its own server; our server relays the
	// change as federated_sync and the snapshot refetches.
	remoteName = "Book club (Thursdays)";
	await page.evaluate(() => {
		const sockets = (
			window as unknown as {
				__sse?: Array<{ onmessage: ((e: { data: string }) => void) | null }>;
			}
		).__sse;
		sockets?.[sockets.length - 1]?.onmessage?.({
			data: JSON.stringify({
				payload: { server: "https://friends.example" },
				type: "federated_sync",
			}),
		});
	});

	await expectCalendarVisibility(page, "Book club (Thursdays)", true);
});

test("joins a calendar from a pasted cross-server invite link", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const token = "0f9c1d2e3a4b5c6d7e8f9a0b1c2d3e4f"; // gitleaks:allow -- deterministic test token
	let previewQuery: string | undefined;
	let connectBody: unknown;

	await page.route("**/api/v1/federation/preview?*", (route) => {
		previewQuery = new URL(route.request().url()).search;
		return respond(route, {
			color: "#8a6fae",
			events: [
				{
					end: "2026-07-28T18:00:00.000Z",
					id: "remote-1",
					isAllDay: false,
					start: "2026-07-28T17:00:00.000Z",
					title: "Book club",
				},
			],
			id: "remote-cal-1",
			members: [{ id: "remote-owner", image: null, name: "Sam Rivers" }],
			name: "Book club",
		});
	});
	await page.route("**/api/v1/federation/connect", (route) => {
		connectBody = route.request().postDataJSON();
		return respond(route, {
			calendar: null,
			server: "https://friends.example",
		});
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Connections" }).click();
	await expect(
		page.getByRole("heading", { name: "Join a shared calendar" }),
	).toBeVisible();

	const inviteInput = page.getByRole("textbox", { name: "Invite link" });
	const openInvite = page.getByRole("button", { name: "Open invite" });
	// The dialog translates/scales while opening. Measure both siblings in one
	// browser frame: separate boundingBox calls can sample different transforms.
	const centerDifference = await inviteInput.evaluate((input) => {
		const button = input.closest("form")?.querySelector('button[type="submit"]');
		if (!button) throw new Error("Invite submit button is missing");
		const inputBox = input.getBoundingClientRect();
		const buttonBox = button.getBoundingClientRect();
		return Math.abs(
			inputBox.y + inputBox.height / 2 - (buttonBox.y + buttonBox.height / 2),
		);
	});
	expect(centerDifference).toBeLessThanOrEqual(1);

	await inviteInput.fill(`https://friends.example/invite/${token}`);
	await openInvite.click();

	// Preview is fetched through the home server, and shows what we're joining.
	await expect(page.getByText("1 member · 1 event")).toBeVisible();
	await expect(
		page.getByRole("listitem").filter({ hasText: "friends.example" }),
	).toHaveCount(0); // not connected yet
	expect(previewQuery).toContain("server=https%3A%2F%2Ffriends.example");
	expect(previewQuery).toContain(`token=${token}`);

	await page.getByRole("button", { name: "Join calendar" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Joined Book club.",
	);
	// The handshake runs server-side — no member token is sent by the browser.
	expect(connectBody).toEqual({
		server: "https://friends.example",
		token,
	});
});

test("joins a calendar from an invite link on this server", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const token = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"; // gitleaks:allow -- deterministic test token
	let joinedCalendarId: string | undefined;

	await page.route(`**/api/v1/calendars/tokens/${token}`, (route) =>
		respond(route, {
			color: "#b3492f",
			events: [],
			id: "shared-cal",
			members: [{ id: "owner-1", image: null, name: "Ada" }],
			name: "Shared plans",
		}),
	);
	await page.route("**/api/v1/calendars/members/shared-cal", (route) => {
		joinedCalendarId = "shared-cal";
		return respond(route, {});
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Connections" }).click();
	// A bare token is accepted too.
	await page.getByRole("textbox", { name: "Invite link" }).fill(token);
	await page.getByRole("button", { name: "Open invite" }).click();

	await expect(page.getByText("Shared plans", { exact: true })).toBeVisible();
	await expect(page.getByText("This server")).toBeVisible();

	await page.getByRole("button", { name: "Join calendar" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Joined Shared plans.",
	);
	expect(joinedCalendarId).toBe("shared-cal");
});

test("manages account identity and gates account deletion", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	let deleteRequested = false;
	await page.route("**/api/auth/update-user", (route) =>
		respond(route, { status: true }),
	);
	await page.route("**/api/auth/request-password-reset", (route) =>
		respond(route, { status: true }),
	);
	await page.route("**/api/v1/users", (route) => {
		if (route.request().method() === "DELETE") {
			deleteRequested = true;
			return route.fulfill({ body: "", status: 200 });
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "User menu for Web QA" }).click();
	await page.getByRole("menuitem", { name: "Manage account" }).click();
	const accountDialog = page.getByRole("dialog", { name: "Settings" });
	await expect(accountDialog).toBeVisible();
	await expect(accountDialog).toContainText("web-qa@example.invalid");
	await accountDialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);

	await expect(
		accountDialog.getByRole("tab", { name: "Account" }),
	).toHaveAttribute("aria-selected", "true");
	const sectionHeadings = ["Profile", "Security"];
	const sectionTops = await Promise.all(
		sectionHeadings.map(
			async (name) =>
				(await accountDialog.getByRole("heading", { name }).boundingBox())!.y,
		),
	);
	expect(sectionTops).toEqual([...sectionTops].sort((a, b) => a - b));

	await accountDialog.getByLabel("Change profile photo").setInputFiles({
		buffer: Buffer.from("not-an-image"),
		mimeType: "text/plain",
		name: "notes.txt",
	});
	await expect(accountDialog.getByRole("alert")).toContainText(
		"Choose a PNG, JPEG, or WebP image.",
	);
	await expectNoAccessibilityViolations(page);

	const displayNameAction = accountDialog.getByRole("button", {
		name: /Display name/,
	});
	await displayNameAction.focus();
	await page.keyboard.press("Enter");
	const nameDialog = page.getByRole("dialog", { name: "Display name" });
	await expect(nameDialog).toBeVisible();
	await expect(nameDialog.getByRole("textbox")).toBeFocused();

	await nameDialog
		.getByRole("textbox", { name: "Display name" })
		.fill("Web QA Updated");
	await nameDialog.getByRole("button", { name: "Save" }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Name updated.",
	);
	await expect(nameDialog).toBeHidden();

	await accountDialog.getByRole("button", { name: /Reset passphrase/ }).click();
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Check your email for a link to set a new passphrase.",
	);

	await accountDialog.getByRole("button", { name: /Delete account/ }).click();
	const deleteDialog = page.getByRole("dialog", { name: "Delete account?" });
	await expect(deleteDialog).toBeVisible();
	await deleteDialog.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	await expectNoAccessibilityViolations(page);

	// Deletion needs the exact display name typed to confirm, including spacing.
	const deleteButton = deleteDialog.getByRole("button", {
		name: "Delete account",
	});
	const confirmation = deleteDialog.getByRole("textbox", {
		name: "Type Web QA to confirm",
	});
	await expect(deleteButton).toBeDisabled();
	await confirmation.fill("wrong");
	await expect(deleteButton).toBeDisabled();
	await confirmation.fill(" Web QA ");
	await expect(deleteButton).toBeDisabled();
	await confirmation.fill("Web QA");
	await expect(deleteButton).toBeEnabled();
	await deleteButton.click();

	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Check your email",
	);
	expect(deleteRequested).toBe(true);
});

test("keeps account management usable as nested mobile sheets", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("button", { name: "User menu for Web QA" }).click();
	await page.getByRole("menuitem", { name: "Manage account" }).click();
	const accountSheet = page.getByRole("dialog", { name: "Settings" });
	await accountSheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);

	const accountBox = (await accountSheet.boundingBox())!;
	expect(accountBox.x).toBe(0);
	expect(Math.round(accountBox.width)).toBe(390);
	expect(Math.round(accountBox.height)).toBe(720);

	const deleteAction = accountSheet.getByRole("button", {
		name: /Delete account/,
	});
	await deleteAction.scrollIntoViewIfNeeded();
	await deleteAction.click();

	const deleteSheet = page.getByRole("dialog", { name: "Delete account?" });
	await deleteSheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const deleteBox = (await deleteSheet.boundingBox())!;
	expect(deleteBox.x).toBe(0);
	expect(Math.round(deleteBox.width)).toBe(390);
	await expect(deleteSheet.getByRole("textbox")).toBeFocused();
	await expectNoAccessibilityViolations(page);

	await page.keyboard.press("Escape");
	await expect(deleteSheet).toBeHidden();
	await expect(accountSheet).toBeVisible();
	await expect(deleteAction).toBeFocused();
});

test("drags across month days to create an all-day range", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const from = page.locator('[data-day-key="2026-07-28"]');
	const to = page.locator('[data-day-key="2026-07-30"]');
	await expect(from).toBeVisible();
	const fromBox = (await from.boundingBox())!;
	const toBox = (await to.boundingBox())!;

	// Press near the bottom of the cell, clear of the day number and any chips.
	await page.mouse.move(
		fromBox.x + fromBox.width / 2,
		fromBox.y + fromBox.height - 6,
	);
	await page.mouse.down();
	await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 6, {
		steps: 8,
	});
	// The pill being created is drawn across the range while dragging, the same
	// way the time grid paints the block it is about to make.
	await expect(page.locator("[data-live]")).toHaveCount(3);
	await page.mouse.up();

	// Quick create opens pre-filled as an all-day event spanning the range.
	await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
		"Tuesday, July 28, 2026",
	);
	await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText(
		"Friday, July 31, 2026",
	);
	// The same pill stays put, now grabbable and owned by the open draft.
	await expect(page.locator("[data-live]")).toHaveCount(0);
	await expect(page.locator("[data-draft]")).toHaveCount(3);

  // The first background click closes this draft without creating another one.
  await page.mouse.click(fromBox.x + 20, fromBox.y + fromBox.height - 12);
  await expect(page.getByRole("dialog", { name: "Create event", exact: true })).toHaveCount(0);
  // A fresh gesture after dismissal must still create a multi-day range.
  await page.mouse.move(fromBox.x + 20, fromBox.y + fromBox.height - 12);
  await page.mouse.down();
  await page.mouse.move(toBox.x + 20, toBox.y + toBox.height - 12, { steps: 8 });
  await expect(page.locator("[data-live]")).toHaveCount(3);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText("Friday, July 31, 2026");
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-draft]")).toHaveCount(0);
});

test("dragging backwards across month days still creates a forward range", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const from = page.locator('[data-day-key="2026-07-30"]');
	const to = page.locator('[data-day-key="2026-07-28"]');
	await expect(from).toBeVisible();
	const fromBox = (await from.boundingBox())!;
	const toBox = (await to.boundingBox())!;

	await page.mouse.move(
		fromBox.x + fromBox.width / 2,
		fromBox.y + fromBox.height - 6,
	);
	await page.mouse.down();
	await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 6, {
		steps: 8,
	});
	await page.mouse.up();

	await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
		"Tuesday, July 28, 2026",
	);
	await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText(
		"Friday, July 31, 2026",
	);
});

test("asks which occurrences a dragged series should change", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
	await page.route("**/api/v1/events", async (route) => {
		const method = route.request().method();
		if (method === "PATCH" || method === "POST") {
			writes.push({
				body: route.request().postDataJSON() as Record<string, unknown>,
				method,
			});
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	const chip = page.getByRole("button", { name: /Weekly review/ }).first();
	await expect(chip).toBeVisible();
	const from = (await chip.boundingBox())!;
	const target = page.locator('[data-day-key="2026-07-29"]');
	const to = (await target.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 8,
	});
	await page.mouse.up();

	// Nothing is written until the scope is answered.
	const dialog = page.getByRole("dialog", { name: "Change recurring event" });
	await expect(dialog).toBeVisible();
	expect(writes).toHaveLength(0);
	await expectNoAccessibilityViolations(page);

	// Dismissing writes nothing at all.
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	expect(writes).toHaveLength(0);

	// Drag again and detach this one occurrence.
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
	await page.getByRole("button", { name: "This event" }).click();

	await expect(page.getByRole("status")).toContainText("Event moved.");
	// The series keeps its rule minus this date, and the moved occurrence is a
	// new standalone event.
	const updated = writes.find((write) => write.method === "PATCH")!;
	expect((updated.body.patch as { recurrence: string }).recurrence).toContain(
		"EXDATE:",
	);
	expect(updated.body.expectedRevision).toBe(1);
	const created = writes.find((write) => write.method === "POST")!;
	expect(created.body.recurrence).toBeNull();
	expect(created.body.id).not.toBe("weekly-review");
});

test("navigates by keyboard and documents the map behind ?", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByText("July 2026")).toBeVisible();

	// View switching, period paging and Today all run the same path as the
	// controls, so the URL follows.
	await page.keyboard.press("w");
	await expect(page).toHaveURL(/\/week\?/);
	await page.keyboard.press("p");
	await expect(page).toHaveURL(/date=2026-07-19/);
	await page.keyboard.press("n");
	await expect(page).toHaveURL(/date=2026-07-26/);
	await page.keyboard.press("m");
	await expect(page).toHaveURL(/\/month\?/);

	// "/" opens the same search palette as the toolbar button and puts the caret
	// straight in its query.
	await page.keyboard.press("/");
	const search = page.getByRole("dialog", { name: "Search Musubi" });
	await expect(search.getByRole("searchbox")).toBeFocused();
	await page.keyboard.type("client");
	const clientResult = search.getByRole("button", { name: /Client call/ });
	await expect(clientResult).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await expect(clientResult).toHaveAttribute("data-active", "true");
	await expect(search.getByRole("searchbox")).toBeFocused();
	await page.keyboard.press("Escape");

	// Radix returns focus to the toolbar trigger. Slash must remain global there;
	// treating every focused button as text entry made every second opening fail.
	const searchTrigger = page.getByRole("button", {
		name: "Search events and actions",
	});
	await expect(searchTrigger).toBeFocused();
	await page.keyboard.press("/");
	const searchbox = search.getByRole("searchbox");
	await expect(searchbox).toBeFocused();
	const newEventResult = search.getByRole("button", { name: "New event" });
	const todayResult = search.getByRole("button", { name: "Go to today" });
  const newTaskResult = search.getByRole("button", { name: "New task" });
	await expect(newEventResult).toHaveAttribute("data-active", "true");
	await page.keyboard.press("ArrowDown");
  await expect(newTaskResult).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowDown");
	await expect(todayResult).toHaveAttribute("data-active", "true");
	await page.keyboard.press("ArrowUp");
  await expect(newTaskResult).toHaveAttribute("data-active", "true");
  await page.keyboard.press("ArrowUp");
	await expect(newEventResult).toHaveAttribute("data-active", "true");
	await page.keyboard.press("Escape");

	const switcherBox = await page
		.getByRole("radiogroup", { name: "Calendar view" })
		.boundingBox();
	const eventBox = await page
		.getByRole("button", { name: "Create event, meeting or task", exact: true })
		.boundingBox();
	expect(
		eventBox!.x - (switcherBox!.x + switcherBox!.width),
	).toBeLessThanOrEqual(12);
	expect(
		Math.abs(
			eventBox!.y +
				eventBox!.height / 2 -
				(switcherBox!.y + switcherBox!.height / 2),
		),
	).toBeLessThanOrEqual(1);

	// "?" opens the overlay listing the same shortcuts.
	await searchTrigger.blur();
	await page.keyboard.press("?");
	const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("New event");
	await expect(dialog).toContainText("Alt + arrows");
	await expectNoAccessibilityViolations(page);
});

test("jumps to a date from the mini calendar without changing the view", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-26`);

	const mini = page.getByRole("region", { name: "Jump to date" });
	await expect(mini).toContainText("Jul 2026");
	// One tab stop: the day the view is on.
	await expect(
		mini.getByRole("gridcell", { name: /July 26, 2026/ }),
	).toHaveAttribute("tabindex", "0");

	await mini.getByRole("gridcell", { name: /July 9, 2026/ }).click();
	await expect(page).toHaveURL(/\/week\?date=2026-07-09/);

	// Paging the mini leaves the main view where it is.
	await mini.getByRole("button", { name: "Next month in date picker" }).click();
	await expect(mini).toContainText("Aug 2026");
	await expect(page).toHaveURL(/date=2026-07-09/);
});

test("keeps the calendar on screen while the next range loads", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByText("July 2026")).toBeVisible();

	// Hold the next range's read open, so the transition is observable.
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/v1/events**", async (route) => {
		if (route.request().method() === "GET") await held;
		return route.fallback();
	});

	await page.keyboard.press("n");
	// The old month stays up, marked as refreshing — no loading screen swap.
	await expect(page.getByText("Preparing your calendar…")).toHaveCount(0);
	await expect(page.getByText("Refreshing saved data…")).toBeVisible();
	// The grid, the toolbar and the day cells are all still there.
	await expect(page.getByText("August 2026")).toBeVisible();
	await expect(page.locator('[data-day-key="2026-08-05"]')).toBeVisible();

	release();
	// August's own occurrences arrive once the read completes.
	await expect(
		page.getByRole("button", { name: /Weekly review/ }).first(),
	).toBeVisible();
});

test("scales what an event block shows to the height it has", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-23`);

	const block = page.locator("[data-time-event]").first();
	await expect(block).toBeVisible({ timeout: 15_000 });
	const time = block.locator("[data-event-time]");
	// An hour-long block at comfortable density has room for the time.
	await expect(time).toBeVisible();

	// Shrink it to a sliver: the title stays, the time drops out. No JS threshold
	// is involved — the block queries its own box.
	await block.evaluate((element: HTMLElement) => {
		element.style.height = "18px";
	});
	await expect(time).toBeHidden();
	await expect(block.locator("[data-event-title]")).toBeVisible();

	await block.evaluate((element: HTMLElement) => {
		element.style.height = "120px";
	});
	await expect(time).toBeVisible();
});

test("marks a recurring event with more than its colour", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const recurring = page.getByRole("button", { name: /Weekly review/ }).first();
	await expect(recurring.locator("svg.lucide-repeat")).toBeVisible({ timeout: 15_000 });
	// A one-off event carries no mark.
	const single = page.getByRole("button", { name: /Client call/ }).first();
	await expect(single.locator("[data-event-marks]")).toHaveCount(0);
});

test("says an event is unsettled while its write is in flight", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") await held;
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-23`);
	const block = page.getByRole("button", { name: /Project check-in/ }).first();
	await block.focus();
	await page.keyboard.press("Alt+ArrowDown");

	await expect(block).toHaveAttribute("aria-busy", "true");
	await expect(block).toHaveAttribute("data-pending", "");

	release();
	await expect(block).not.toHaveAttribute("data-pending", "");
});

test("blocks the phone web app with a full-screen app download", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page, events, calendars, undefined, false);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const blocker = page.getByRole("dialog", { name: "Musubi on mobile" });
	await expect(blocker).toContainText("Musubi works best in the app");
	await expect(
		blocker.getByRole("button", { name: "Get the Android app" }),
	).toBeVisible();
	const box = (await blocker.locator("..").boundingBox())!;
	expect(box).toMatchObject({ height: 720, width: 390, x: 0, y: 0 });
	await expect(
		page.getByRole("button", { name: "Create event, meeting or task", exact: true }),
	).toHaveCount(0);

	await page.keyboard.press("Escape");
	await expect(blocker).toBeVisible();
	await page.reload();
	await expect(blocker).toBeVisible();
});

for (const width of [320, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`keeps narrow toolbar date and actions legible at ${width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await setTestTheme(page, theme);
      await mockAuthenticatedReads(page);

      for (const [view, date] of [
        ["month", "2026-09-23"], ["week", "2026-09-23"],
        ["day", "2026-09-23"], ["agenda", "2026-09-23"],
        ["week", "2026-12-30"],
      ] as const) {
        await page.goto(`/app/p/${DEFAULT_PAGE_ID}/${view}?date=${date}`);
        const today = page.getByRole("button", { name: "Today", exact: true });
        const dateControls = today.locator("..");
        const period = dateControls.locator("p");
        const picker = page.getByRole("combobox", { name: "Calendar view" });
        const search = page.getByRole("button", { name: "Search events and actions" });
        await expect(today).toBeVisible();
        await expect(picker).toBeVisible();
        await expect(search).toBeVisible();
        // Fractional serif line metrics can round scrollHeight up by one pixel.
        expect(await period.evaluate(node =>
          node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight + 1,
        )).toBe(true);
        const dateBox = (await dateControls.boundingBox())!;
        const pickerBox = (await picker.boundingBox())!;
        const searchBox = (await search.boundingBox())!;
        expect(dateBox.y + dateBox.height).toBeLessThanOrEqual(pickerBox.y);
        expect(pickerBox.y + pickerBox.height / 2).toBe(searchBox.y + searchBox.height / 2);
        expect(pickerBox.x).toBeLessThan(searchBox.x);
      }

      await page.getByRole("button", { name: "Search events and actions" }).click();
      const searchDialog = page.getByRole("dialog", { name: "Search Musubi" });
      await expect(searchDialog.getByRole("searchbox")).toBeFocused();
      await searchDialog.press("Escape");
      await expect(page.getByRole("button", { name: "Search events and actions" })).toBeFocused();
      await expectNoAccessibilityViolations(page);
    });
  }
}

test("opens creation in a full-height Inspector on a narrow viewport", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// Create sits within thumb reach rather than in the toolbar.
	const create = page.getByRole("button", {
		exact: true,
		name: "Create event, meeting or task",
	});
	const fab = (await create.boundingBox())!;
	expect(fab.y).toBeGreaterThan(500);
	expect(Math.round(fab.width)).toBe(Math.round(fab.height));

	await openCreateEvent(page);
	// The shared Inspector fills the narrow viewport with a fixed action footer.
	const sheet = page.getByRole("dialog", { name: "Create event" });
	await sheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const box = (await sheet.boundingBox())!;
	expect(Math.round(box.width)).toBe(390);
	expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(721);
	expect(box.x).toBe(0);
	expect(box.y).toBe(0);
	expect(box.height).toBe(720);
	expect(
		await sheet.evaluate((element) => element.scrollWidth - element.clientWidth),
	).toBe(0);

	// It is still the same layer: Escape dismisses it and focus is handled.
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expectNoAccessibilityViolations(page);
});

for (const width of [1024, 1280, 1555]) {
  test(`overlay event panel preserves calendar geometry at ${width}px`, async ({ page }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", error => runtimeErrors.push(error.message));
    await page.setViewportSize({ width, height: 916 });
    const appointment = event("docked-toolbar", "Docked toolbar check", "personal", "#b3492f", "2026-07-20T09:00:00.000Z", "2026-07-20T10:00:00.000Z");
    await mockAuthenticatedReads(page, { ...events, events: [appointment] }, calendars.map(calendar => calendar.id === "studio" ? { ...calendar, provider: "microsoft" } : calendar));
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-20`);
    const calendar = page.locator("[data-calendar-area]");
    const before = (await calendar.boundingBox())!;
    await page.getByRole("button", { name: /Docked toolbar check/ }).click();
    const details = page.getByRole("dialog", { name: "Docked toolbar check", exact: true });
    await expect(details).toBeVisible();
    await settleLayout(page);
    expect((await calendar.boundingBox())!.width).toBe(before.width);
    // Overlaying the panel must not resize any of the calendar columns.
    const weekdays = calendar.getByRole("columnheader");
    await expect(weekdays).toHaveCount(7);
    for (const weekday of await weekdays.all()) {
      const box = (await weekday.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(before.x);
      expect(box.x + box.width).toBeLessThanOrEqual(before.x + before.width + 1);
    }
    expect(await calendar.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    await expectNoAccessibilityViolations(page);
    expect(runtimeErrors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`docked-toolbar-${width}.png`) });
    await details.getByRole("button", { name: "Close event details" }).click();
    await settleLayout(page);
    expect((await calendar.boundingBox())!.width).toBe(before.width);
  });
}

test("keeps desktop event details beside the calendar with toolbar controls accessible", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const leftTrigger = page
		.getByRole("button", { name: /Studio retreat/ })
		.first();
	const calendarGrid = page.locator("[data-calendar-area]");
	const calendarBox = (await calendarGrid.boundingBox())!;
	await leftTrigger.click();
	const leftDetails = page.getByRole("dialog", { name: "Studio retreat" });
	await leftDetails.evaluate((element) =>
		Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished),
		),
	);
	const leftDetailsBox = (await leftDetails.boundingBox())!;
	expect(leftDetailsBox).toMatchObject({ x: 740, y: 0, width: 540, height: 800 });
	expect(await calendarGrid.boundingBox()).toMatchObject({ x: calendarBox.x, width: calendarBox.width });
	expect(
		await leftDetails.evaluate((element) => ({
			horizontal: element.scrollWidth - element.clientWidth,
			vertical: element.scrollHeight - element.clientHeight,
		})),
	).toEqual({ horizontal: 0, vertical: 0 });
	await page.keyboard.press("Escape");

	const rightTrigger = page.getByRole("button", {
		name: /Theatre night/,
	});
	await rightTrigger.click();
	const rightDetails = page.getByRole("dialog", { name: "Theatre night" });
	await rightDetails.evaluate((element) =>
		Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished),
		),
	);
	const rightDetailsBox = (await rightDetails.boundingBox())!;
	expect(rightDetailsBox).toMatchObject({ x: 740, y: 0, width: 540, height: 800 });
	expect(
		await rightDetails.evaluate(
			(element) => element.scrollWidth - element.clientWidth,
		),
	).toBe(0);
});

test("chooses event calendars from an accessible mobile list", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await openCreateEvent(page);
	const editor = page.getByRole("dialog", { name: "Create event" });
	const trigger = editor.getByRole("button", {
		name: /^Choose calendars/,
	});
	await trigger.click();

	const selection = editor.locator('[data-ui="calendar-placement"]');
	await expect(selection).toBeVisible();
	await expect(
		selection.getByRole("checkbox", { name: "Show event in Personal" }),
	).toBeChecked();
	await selection
		.getByRole("radio", { name: "Studio as home calendar" })
		.click();
	await expect(
		selection.getByRole("checkbox", { name: "Show event in Studio" }),
	).toBeChecked();

	const accessibility = await new AxeBuilder({ page })
		.include('[data-ui="calendar-placement"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);

	await trigger.click();
	await expect(selection).toHaveCount(0);
	await expect(editor).toBeVisible();
	await expect(trigger).toHaveAccessibleName(
		/Studio is home\. Event appears in 1 calendar/,
	);
});

test("opens the calendar color picker as the top mobile sheet", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("button", { name: "Calendars" }).click();
	await page.getByRole("button", { name: "New calendar" }).click();
	const trigger = page.getByRole("button", {
		name: "New calendar color: #B3A48A",
	});
	await trigger.click();

	const sheet = page.getByRole("dialog", { name: "Choose color" });
	await sheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const box = (await sheet.boundingBox())!;
	expect(box.x).toBe(0);
	expect(Math.round(box.width)).toBe(390);
	expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(721);

	const accessibility = await new AxeBuilder({ page })
		.include('[data-ui="color-picker-popover"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);

	await page.getByRole("option", { name: "Custom color" }).click();
	await expect(page.getByRole("textbox", { name: "Hex color" })).toBeFocused();
	const expandedBox = (await sheet.boundingBox())!;
	expect(Math.round(expandedBox.y + expandedBox.height)).toBeLessThanOrEqual(
		721,
	);
	const customAccessibility = await new AxeBuilder({ page })
		.include('[data-ui="color-picker-popover"]')
		.analyze();
	expect(customAccessibility.violations).toEqual([]);

	// Escape dismisses only the top layer and restores the initiating control.
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "New calendar" })).toBeVisible();
	await expect(trigger).toBeFocused();
});

test("opens an event's details as a full-height panel on a narrow viewport", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// A phone folds a busy day into "+2 more", so the event under test has to be
	// one the compact grid still shows. Same calendar and length as before.
	const eventButton = page
		.getByRole("button", { name: /Client presentation/ })
		.first();
	await eventButton.click();
	const sheet = page.getByRole("dialog").first();
	await sheet.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	const box = (await sheet.boundingBox())!;
	expect(box.x).toBe(0);
	expect(Math.round(box.width)).toBe(390);
	// The narrow inspector fills the viewport; its body owns content scrolling.
	expect(box.y).toBe(0);
	expect(Math.round(box.height)).toBe(720);
	expect(await sheet.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
	await expect(
		page.getByRole("heading", { name: "Client presentation" }),
	).toBeVisible();
	await expect(sheet.getByText("1 hr", { exact: true })).toBeVisible();
	await expect(
		sheet.getByRole("list", { name: "Calendars" }).getByText("Studio"),
	).toBeVisible();

	const titleBox = (await sheet
		.getByRole("heading", { name: "Client presentation" })
		.boundingBox())!;
	const dateBox = (await sheet
		.getByText("Date", { exact: true })
		.boundingBox())!;
	const timeBox = (await sheet
		.getByText("Time", { exact: true })
		.boundingBox())!;
	const calendarBox = (await sheet
		.getByRole("list", { name: "Calendars" })
		.boundingBox())!;
	// Calendar identity now belongs with the event title in the fixed header.
	await expect(sheet.locator("header").getByRole("list", { name: "Calendars" })).toBeVisible();
	expect([titleBox.y, calendarBox.y, dateBox.y, timeBox.y]).toEqual(
		[titleBox.y, calendarBox.y, dateBox.y, timeBox.y].sort((a, b) => a - b),
	);

	const accessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(accessibility.violations).toEqual([]);

	await page.getByRole("button", { name: "More event actions" }).click();
	await page.getByRole("menuitem", { name: "Link to another calendar" }).click();
	await expect(
		page.getByRole("button", { name: "Link to Personal" }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "More event actions" }),
	).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(eventButton).toBeFocused();
});

test("keeps the page name and theme out of the calendar chrome", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// No theme control in the toolbar: it is a setting, and it lives in Settings.
	await expect(page.getByRole("button", { name: /theme/i })).toHaveCount(0);
	// The page name is the sidebar's job; the heading stays for structure only.
	await expect(
		page.getByRole("button", { exact: true, name: "My calendar" }),
	).toBeVisible();

	// Renaming lives in the page's own settings dialog, never in the chrome.
	await expect(page.getByLabel("Page name")).toHaveCount(0);
	await page.getByRole("button", { name: "Edit My calendar" }).click();
	await expect(page.getByLabel("Page name")).toHaveValue("My calendar");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Close page settings" })
		.click();
	await expect(page.getByLabel("Page name")).toHaveCount(0);
});

test("keeps calendar chrome consistent and keyboard operable", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const runtimeErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	const navigation = page.getByRole("complementary", {
		name: "Workspace navigation",
	});
	// Page filters are settings, not permanent calendar chrome.
	await expect(page.getByRole("button", { name: "Filters" })).toHaveCount(0);
	await expect(navigation.getByRole("switch")).toHaveCount(0);
	await setCalendarVisibility(page, "Studio", false);
	await expect(page.getByRole("button", { name: /Studio retreat/ })).toHaveCount(
		0,
	);

	const month = page.getByRole("radio", { name: "Month" });
	await month.focus();
	await page.keyboard.press("ArrowRight");
	await expect(page).toHaveURL(
		`/app/p/${DEFAULT_PAGE_ID}/tasks?date=2026-07-26`,
	);
	await expect(page.getByRole("radio", { name: "Tasks" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expectNoAccessibilityViolations(page);
	expect(runtimeErrors).toEqual([]);
});

test("moves focus through the mobile navigation drawer", async ({ page }) => {
	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const main = page.locator("main#main-content");
	const trigger = page.getByRole("button", { name: "Open navigation" });
	await trigger.click();

	const navigation = page.getByRole("complementary", {
		name: "Workspace navigation",
	});
	const close = navigation.getByRole("button", { name: "Close navigation" });
	await expect(close).toBeFocused();
	await expect(main).toHaveAttribute("inert", "");
	await navigation.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	// Touch targets in the drawer: filters live in each Page's settings, so the
	// drawer only carries the Page rows.
	const pageRow = navigation.getByRole("button", {
		exact: true,
		name: "My calendar",
	});
	expect((await pageRow.boundingBox())!.height).toBeGreaterThanOrEqual(38);
	await expectNoAccessibilityViolations(page);

	// Medium keeps the overlay drawer; 1024 is the first permanent-sidebar
	// width. CSS owns that boundary and JS reads its flag, so the two cannot
	// silently drift apart.
	await page.setViewportSize({ height: 720, width: 800 });
	await expect(main).toHaveAttribute("inert", "");
	await page.setViewportSize({ height: 720, width: 1024 });
	await expect(main).not.toHaveAttribute("inert", "");
	await page.setViewportSize({ height: 720, width: 800 });
	await expect(close).toBeFocused();

	await page.keyboard.press("Escape");
	await expect(main).not.toHaveAttribute("inert", "");
	await expect(trigger).toBeFocused();
});

test("leaves a draft on the grid that can be moved before saving", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-30`);
	const column = page.locator("[data-time-grid-column]").first();
	await expect(column).toBeVisible();
	await page.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>(
			'[data-calendar-area]',
		);
		if (scroller) scroller.scrollTop = 0;
	});

	// Drag out a 90-minute slot.
	const bounds = (await column.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 128);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 224, {
		steps: 6,
	});
	await page.mouse.up();

	const start = page.getByLabel("Start time");
	await expect(start).toHaveValue("02:00");
	await expect(page.getByLabel("End time")).toHaveValue("03:30");

	// Type a title, then drag the draft itself: the time follows, the title stays.
	await page.getByRole("textbox", { name: "Event title" }).fill("Deep work");
	const draft = page.locator("[data-draft]");
	await expect(draft).toBeVisible();
	// It reads as the event it is about to become, not as a selection.
	await expect(draft).toContainText("New event");
	await expect(draft).toContainText("02:00–03:30");
	const draftBox = (await draft.boundingBox())!;
	// The right inspector overlays part of the day; drag its exposed left edge.
	expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-draft]')), { x: draftBox.x + 20, y: draftBox.y + draftBox.height / 2 })).toBe(true);
	await page.mouse.move(
		draftBox.x + 20,
		draftBox.y + draftBox.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		draftBox.x + 20,
		draftBox.y + draftBox.height / 2 + 64,
		{ steps: 8 },
	);
	await page.mouse.up();

	await expect(start).toHaveValue("03:00");
	await expect(page.getByLabel("End time")).toHaveValue("04:30");
	await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(
		"Deep work",
	);

	// Saving writes the dragged time.
	const writes: Array<{ end: string; start: string }> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "POST") {
			const body = route.request().postDataJSON() as {
				end: string;
				start: string;
			};
			writes.push({ end: body.end, start: body.start });
		}
		return route.fallback();
	});
	await page.getByRole("button", { name: "Create", exact: true }).click();

	await expect(page.getByRole("status")).toContainText("Event created.");
	expect(pragueTime(writes[0]!.start)).toBe("03:00");
	expect(
		new Date(writes[0]!.end).getTime() - new Date(writes[0]!.start).getTime(),
	).toBe(90 * 60_000);
});

test("leaves a draggable pill on the month grid", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const from = page.locator('[data-day-key="2026-07-28"]');
	const to = page.locator('[data-day-key="2026-07-30"]');
	await expect(from).toBeVisible();
	const fromBox = (await from.boundingBox())!;
	const toBox = (await to.boundingBox())!;

	await page.mouse.move(
		fromBox.x + fromBox.width / 2,
		fromBox.y + fromBox.height - 6,
	);
	await page.mouse.down();
	await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height - 6, {
		steps: 8,
	});
	await page.mouse.up();

	// One pill per covered day, flat where it runs into the next cell.
	await expect(page.locator("[data-draft]")).toHaveCount(3);
	await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
		"Tuesday, July 28, 2026",
	);
	await page.getByRole("textbox", { name: "Event title" }).fill("Retreat");

	await settleLayout(page);
	// Grab the pill and move the whole range a day later.
	const pill = page.locator("[data-draft]").first();
	const pillBox = (await pill.boundingBox())!;
	const target = page.locator('[data-day-key="2026-07-29"]');
	const targetBox = (await target.boundingBox())!;
	await page.mouse.move(
		pillBox.x + pillBox.width / 2,
		pillBox.y + pillBox.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		targetBox.x + targetBox.width / 2,
		pillBox.y + pillBox.height / 2,
		{ steps: 8 },
	);
	await page.mouse.up();

	await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
		"Wednesday, July 29, 2026",
	);
	await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText(
		"Saturday, August 1, 2026",
	);
	await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(
		"Retreat",
	);
});

test("creation Inspector exposes the complete form and submits from the keyboard", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.locator('[data-day-key="2026-07-15"]').click();

	const bubble = page.getByRole("dialog", { name: "Create event" });
	await expect(bubble).toBeVisible();
	// What a new event cannot do without: name, when, which calendar.
	await expect(page.getByRole("textbox", { name: "Event title" })).toBeFocused();
	await expect(page.getByRole("button", { name: /^Date:/ })).toBeVisible();
	await expect(page.getByLabel("Start time")).toBeVisible();
	await expect(
		bubble.getByRole("button", { name: /^Choose calendars/ }),
	).toBeVisible();
	await bubble.evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished)),
	);
	expect(
		await bubble.evaluate((element) => ({
			horizontal: element.scrollWidth - element.clientWidth,
			vertical: element.scrollHeight - element.clientHeight,
		})),
	).toEqual({ horizontal: 0, vertical: 0 });
	await expectNoAccessibilityViolations(page);
	// The complete event form is available in the same Inspector used for editing.
	await expect(page.getByPlaceholder("Add location")).toBeVisible();
	await expect(page.getByPlaceholder("Add notes")).toBeVisible();
	await expect(page.getByLabel("Repeat")).toBeVisible();
	await expect(bubble.locator('[data-ui="calendar-placement"]')).toHaveCount(0);

	// The documented keyboard path submits without leaving the title field.
	await page.getByRole("textbox", { name: "Event title" }).fill("Studio time");
	await page.keyboard.press("Control+Enter");
	await expect(page.getByRole("status")).toContainText("Event created.");
});

for (const reload of [false, true]) {
	test(
		reload
			? "keeps a handed-off draft after reload without borrowing a revision"
			: "keeps event edits focused and moves details to a full page",
		async ({ page }) => {
			await mockAuthenticatedReads(page);
			const writes: unknown[] = [];
			await page.route("**/api/v1/events", (route) => {
				if (route.request().method() === "PATCH")
					writes.push(route.request().postDataJSON());
				return route.fallback();
			});
			await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

			await page
				.getByRole("button", { name: /Client call/ })
				.first()
				.click();
			await page.getByRole("button", { name: "Edit", exact: true }).click();

			// The inspector exposes the complete form and retains the full-page handoff.
			await expect(
				page.getByRole("button", { name: "Expand event editor" }),
			).toBeVisible();
			await expect(page.getByPlaceholder("Add location")).toBeVisible();
			await expect(page.getByLabel("Repeat")).toBeVisible();
			await expect(
				page.getByRole("button", { name: /^Choose calendars/ }),
			).toBeVisible();
			await page
				.getByRole("textbox", { name: "Event title" })
				.fill("Client call revised");
			await expectNoAccessibilityViolations(page);

			await page.getByRole("button", { name: "Expand event editor" }).click();
			await expect(page).toHaveURL(/\/event\/client-call\?/);
			await expect(page).toHaveURL(/title=Client\+call\+revised/);
			await expect(
				page.getByRole("heading", { name: "Edit event" }),
			).toBeVisible();
			const fullEditor = page.getByRole("dialog", { name: "Edit event", exact: true });
			await fullEditor.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
			const bounds = await fullEditor.boundingBox();
			expect(bounds?.width).toBeGreaterThan(720);
			expect(bounds?.x).toBeGreaterThan(0);
			await expect(fullEditor.locator('[data-layout="page"]')).toBeVisible();
			await expect(
				page.getByRole("textbox", { name: "Event title" }),
			).toHaveValue("Client call revised");

			// The full editor keeps the original baseline handed off by the popover.
			await expect(page.getByPlaceholder("Add location")).toBeVisible();
			await expect(page.getByLabel("Repeat")).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Expand event editor" }),
			).toHaveCount(0);
			await expectNoAccessibilityViolations(page);

			if (reload) {
				await page.reload();
				await expect(
					page.getByRole("textbox", { name: "Event title" }),
				).toHaveValue("Client call revised");
			}

			await page.getByPlaceholder("Add location").fill("Studio C");
			await page.getByRole("button", { exact: true, name: "Save" }).click();
			if (reload) {
				await expect(page.getByRole("alert")).toBeVisible();
				await expect(
					page.getByRole("textbox", { name: "Event title" }),
				).toHaveValue("Client call revised");
				await expect(page.getByPlaceholder("Add location")).toHaveValue(
					"Studio C",
				);
				expect(writes).toEqual([]);
				return;
			}
			expect(writes).toHaveLength(1);
			await expect(page).toHaveURL(/\/month\?date=2026-07-26/);
			await expect(
				page.getByRole("button", { name: /Client call revised/ }).first(),
			).toBeVisible();
			await expectNoAccessibilityViolations(page);
		},
	);
}

test("makes the scope of a recurring event edit explicit", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page
		.getByRole("button", { name: /Weekly review/ })
		.first()
		.click();
	// The popover badges the series and its Edit is one word; "series" is spelled
	// out again by the editor it opens.
	await page.getByRole("button", { exact: true, name: "Edit" }).click();
	await page.getByRole("button", { name: "Expand event editor" }).click();

	await expect(page).toHaveURL(/\/event\/weekly-review\?/);
	await expect(page.getByRole("heading", { name: "Edit series" })).toBeVisible();
	await expect(
		page.getByText("Changes apply to the whole series."),
	).toBeVisible();
	await expectNoAccessibilityViolations(page);
});

test("expands the creation draft in place and returns to its floating position", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAuthenticatedReads(page);
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-30`);
  await openCreateEvent(page);
  const url = page.url();
  const editor = page.getByRole("dialog", { name: "Create event", exact: true });
  await editor.getByRole("button", { name: "Float window", exact: true }).click();
  await editor.getByRole("button", { name: "Move window with arrow keys" }).press("Shift+ArrowLeft");
  const originalBox = (await editor.boundingBox())!;
  const calendar = page.locator("[data-calendar-area]");
  const scrollTop = await calendar.evaluate(node => node.scrollTop);
  await editor.getByRole("textbox", { name: "Event title" }).fill("Quarterly review");
  await editor.getByPlaceholder("Add location").fill("Studio B");
  await editor.getByRole("button", { name: "Expand event editor" }).click();
  await expect(page).toHaveURL(url);
  await expect(editor).toHaveAttribute("data-presentation", "expanded");
  await expect(editor.getByRole("textbox", { name: "Event title" })).toHaveValue("Quarterly review");
  await expect(editor.getByPlaceholder("Add location")).toHaveValue("Studio B");
  await expect(editor.getByLabel("Repeat")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Collapse event editor" })).toBeFocused();
  await expectNoAccessibilityViolations(page);
  await editor.getByPlaceholder("Add notes").fill("Bring the roadmap.");
  await editor.getByRole("button", { name: "Collapse event editor" }).click();
  await expect(editor).toHaveAttribute("data-presentation", "floating");
  await editor.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
  const restoredBox = (await editor.boundingBox())!;
  expect(restoredBox.x).toBeCloseTo(originalBox.x, 0);
  expect(restoredBox.y).toBeCloseTo(originalBox.y, 0);
  await expect(editor.getByPlaceholder("Add notes")).toHaveValue("Bring the roadmap.");
  expect(await calendar.evaluate(node => node.scrollTop)).toBe(scrollTop);
  await editor.getByRole("button", { name: "Dock to side" }).click();
  await editor.getByRole("button", { name: "Expand event editor" }).click();
  await editor.getByRole("button", { name: "Collapse event editor" }).click();
  await expect(editor).toHaveAttribute("data-presentation", "panel");
  await editor.getByRole("button", { name: "Expand event editor" }).click();
  const writes: Array<{ title: string; location: string }> = [];
  await page.route("**/api/v1/events", async route => {
    if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
    return route.fallback();
  });
  await editor.getByRole("button", { exact: true, name: "Create" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(url);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ title: "Quarterly review", location: "Studio B" });
  await expect(page.getByRole("button", { name: /Quarterly review/ }).first()).toBeVisible();
});

test("uses the desktop event editor as a fixed multi-column workspace", async ({
	page,
}) => {
	await page.setViewportSize({ height: 800, width: 1280 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await openCreateEvent(page);
	await page.getByRole("button", { name: "Expand event editor" }).click();

	const editor = page.getByRole("dialog", { name: "Create event", exact: true });
	const surface = editor.locator("header + div");
	const form = editor.locator('form[data-layout="page"]');
	const when = form.locator('[data-editor-section="when"]');
	const details = form.locator('[data-editor-section="details"]');
	const calendarSection = form.locator('[data-editor-section="calendars"]');
	// Measure the settled layer, not a frame of its entrance zoom.
	await form.evaluate(async node => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)); void node; });
	const [whenBox, detailsBox, calendarBox] = await Promise.all([
		when.boundingBox(),
		details.boundingBox(),
		calendarSection.boundingBox(),
	]);

	expect(whenBox).not.toBeNull();
	expect(detailsBox).not.toBeNull();
	expect(calendarBox).not.toBeNull();
	expect(Math.abs(whenBox!.y - detailsBox!.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(detailsBox!.y - calendarBox!.y)).toBeLessThanOrEqual(1);
	expect(
		await page.evaluate(() => ({
			horizontal: document.documentElement.scrollWidth - window.innerWidth,
			vertical: document.documentElement.scrollHeight - window.innerHeight,
		})),
	).toEqual({ horizontal: 0, vertical: 0 });
	expect(
		await editor.evaluate((element) => ({
			horizontal: element.scrollWidth - element.clientWidth,
			vertical: element.scrollHeight - element.clientHeight,
		})),
	).toEqual({ horizontal: 0, vertical: 0 });
	// The dialog clips, so its own scrollHeight can never report an overflow.
	// The invariant worth pinning is the pair below: the layer stays inside the
	// viewport, and at this height the three columns fit without the body
	// needing to scroll at all.
	const body = editor.locator("header + div");
	const editorBox = (await editor.boundingBox())!;
	expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(801);
	expect(
		await body.evaluate((element) => element.scrollHeight - element.clientHeight),
	).toBe(0);
	expect(
		await form
			.locator('[data-ui="calendar-placement"]')
			.evaluate((element) => element.scrollHeight - element.clientHeight),
	).toBeLessThanOrEqual(1);

	await page.getByPlaceholder("Add location").fill("Studio B");
	await page.getByPlaceholder("Add notes").fill("Bring the roadmap.");
	await expect(
		page.getByRole("button", { exact: true, name: "Create" }),
	).toBeInViewport();

	await page.setViewportSize({ height: 768, width: 1024 });
	const create = page.getByRole("button", {
		exact: true,
		name: "Create",
	});
	const [compactSurfaceBox, compactActionsBox, compactWhenBox] =
		await Promise.all([
			surface.boundingBox(),
			create.boundingBox(),
			when.boundingBox(),
		]);
	expect(compactSurfaceBox).not.toBeNull();
	expect(compactActionsBox).not.toBeNull();
	expect(compactWhenBox).not.toBeNull();
	// The editor is a layer now, so its inset is the shared viewport gutter
	// (--layer-viewport-gutter, 24px here) rather than a page's own padding.
	expect(compactSurfaceBox!.x).toBeGreaterThanOrEqual(24);
	expect(
		Math.abs(
			compactSurfaceBox!.x -
				(1024 - compactSurfaceBox!.x - compactSurfaceBox!.width),
		),
	).toBeLessThanOrEqual(1);
	// The primary action ends on the layer's shared 24px inset.
	expect(
		Math.abs(
			compactActionsBox!.x +
				compactActionsBox!.width -
				(compactSurfaceBox!.x + compactSurfaceBox!.width - 24),
		),
	).toBeLessThanOrEqual(2);

	// Too short for the form's own minimum. `scrollHeight` cannot tell scrolling
	// from clipping — both report an overflow — so the check is the one thing the
	// person filling the form needs: the bottom of it is still reachable.
	await page.setViewportSize({ height: 620, width: 1280 });
	await expect.poll(async () => { const box = (await editor.boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(621);
	const submit = page.getByRole("button", { exact: true, name: "Create" });
	await submit.scrollIntoViewIfNeeded();
	await expect(submit).toBeInViewport();
	await page.setViewportSize({ height: 800, width: 1280 });

	const [dateBox, startTimeBox, repeatBox] = await Promise.all([
		form.getByRole("button", { name: /^Date:/ }).boundingBox(),
		form.getByLabel("Start time").boundingBox(),
		form.getByLabel("Repeat").boundingBox(),
	]);
	expect(dateBox).not.toBeNull();
	expect(startTimeBox).not.toBeNull();
	expect(repeatBox).not.toBeNull();
	expect(Math.abs(dateBox!.x - startTimeBox!.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(startTimeBox!.x - repeatBox!.x)).toBeLessThanOrEqual(1);
	expect(
		await page.evaluate(() => ({
			horizontal: document.documentElement.scrollWidth - window.innerWidth,
			vertical: document.documentElement.scrollHeight - window.innerHeight,
		})),
	).toEqual({ horizontal: 0, vertical: 0 });
	expect(
		await form
			.locator('[data-ui="calendar-placement"]')
			.evaluate((element) => element.scrollHeight - element.clientHeight),
	).toBeLessThanOrEqual(1);
	await expect(create).toBeInViewport();
	await expectNoAccessibilityViolations(page);
});

test("keeps the full event editor usable on a narrow viewport", async ({
	page,
}) => {
	const runtimeErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") runtimeErrors.push(message.text());
	});
	page.on("pageerror", (error) => runtimeErrors.push(error.message));

	await page.setViewportSize({ height: 720, width: 390 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await openCreateEvent(page);
	await page
		.getByRole("textbox", { name: "Event title" })
		.fill("Mobile planning");
	await page.getByRole("button", { name: "Expand event editor" }).click();

	await expect(page).toHaveURL(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Collapse event editor" })).toBeFocused();
	await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("Mobile planning");
	await expect(page.getByRole("button", { name: /^Date:/ })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Location", exact: true })).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Calendars" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await expectNoAccessibilityViolations(page);

	const create = page.getByRole("button", {
		exact: true,
		name: "Create",
	});
	await create.scrollIntoViewIfNeeded();
	await expect(create).toBeVisible();
	await page.getByRole("button", { name: "Close new event" }).click();
	await page.getByRole("button", { name: "Discard event", exact: true }).click();
	await expect(page).toHaveURL(/\/month\?date=2026-07-26/);
	expect(runtimeErrors).toEqual([]);
});

test("leaving the full event editor keeps the calendar where it was", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.locator('[data-day-key="2026-07-15"]').click();
	await page.getByRole("button", { name: "Expand event editor" }).click();
	await expect(page).toHaveURL(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	await page.getByRole("button", { name: "Close new event" }).click();
	await expect(page).toHaveURL(/\/month\?date=2026-07-26/);
});

for (const view of ["month", "week"] as const) {
	test(`creation Inspector guards edit-to-create and create-to-event handoffs in ${view}`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const appointment = event("inspector-appointment", "Inspector appointment", "personal", "#b3492f", "2026-07-20T04:00:00.000Z", "2026-07-20T05:00:00.000Z");
		await mockAuthenticatedReads(page, { ...events, events: [appointment] });
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/${view}?date=2026-07-20`);
		const calendar = page.locator("[data-calendar-area]");
		if (view === "week") await calendar.evaluate(element => { element.scrollTop = 0; });
		const calendarBefore = await calendar.boundingBox();
		const trigger = page.getByRole("button", { name: /Inspector appointment/ }).first();
		await trigger.click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		const title = page.getByRole("textbox", { name: "Event title" });
		await title.fill("Keep the edited appointment");
		const slot = page.locator(view === "month" ? '[data-day-key="2026-07-21"]' : '[data-time-grid-column="2026-07-20"]');
		const bounds = (await slot.boundingBox())!;
		const point = { x: bounds.x + Math.min(40, bounds.width / 2), y: view === "month" ? bounds.y + bounds.height - 8 : bounds.y + 128 };
		await page.mouse.click(point.x, point.y);
		let confirmation = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole("button", { name: "Keep editing", exact: true }).last().click();
		await expect(title).toHaveValue("Keep the edited appointment");
		await expect(page.getByRole("dialog", { name: "Create event", exact: true })).toHaveCount(0);
		await page.mouse.click(point.x, point.y);
		await confirmation.getByRole("button", { name: "Discard changes", exact: true }).click();
		await page.mouse.click(point.x, point.y);

		const create = page.getByRole("dialog", { name: "Create event", exact: true });
		await expect(create).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(title).toHaveValue("");
		await expect(title).toBeFocused();
		expect(await calendar.boundingBox()).toMatchObject({ x: calendarBefore!.x, width: calendarBefore!.width });
		await title.fill("Keep the new appointment");
		await trigger.click();
		confirmation = page.getByRole("dialog", { name: "Discard new event?", exact: true });
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole("button", { name: "Keep editing", exact: true }).last().click();
		await expect(title).toHaveValue("Keep the new appointment");
		await expect(title).toBeFocused();
		await trigger.click();
		await confirmation.getByRole("button", { name: "Discard event", exact: true }).click();
		await trigger.click();
		const details = page.getByRole("dialog", { name: "Inspector appointment", exact: true });
		await expect(details).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(create).toHaveCount(0);
		await expect.poll(() => details.evaluate(element => element.contains(document.activeElement))).toBe(true);
		expect(await calendar.boundingBox()).toMatchObject({ x: calendarBefore!.x, width: calendarBefore!.width });
	});

	test(`creation Inspector preserves a dirty draft until a new ${view} slot is accepted`, async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await mockAuthenticatedReads(page, { ...events, events: [] });
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/${view}?date=2026-07-20`);
		const calendar = page.locator("[data-calendar-area]");
		if (view === "week") await calendar.evaluate(element => { element.scrollTop = 0; });
		const first = page.locator(view === "month" ? '[data-day-key="2026-07-20"]' : '[data-time-grid-column="2026-07-20"]');
		const firstBox = (await first.boundingBox())!;
		await page.mouse.click(firstBox.x + 30, view === "month" ? firstBox.y + firstBox.height - 8 : firstBox.y + 128);
		const create = page.getByRole("dialog", { name: "Create event", exact: true });
		const title = create.getByRole("textbox", { name: "Event title" });
		await title.fill("Preserve this draft");
		const oldDate = await create.getByRole("button", { name: /^Date:/ }).textContent();
		const oldStart = await create.getByRole("combobox", { name: "Start time" }).inputValue();
		const next = page.locator(view === "month" ? '[data-day-key="2026-07-21"]' : '[data-time-grid-column="2026-07-20"]');
		const nextBox = (await next.boundingBox())!;
		const point = { x: nextBox.x + 30, y: view === "month" ? nextBox.y + nextBox.height - 8 : nextBox.y + 256 };
		await page.mouse.click(point.x, point.y);
		const confirmation = page.getByRole("dialog", { name: "Discard new event?", exact: true });
		await expect(confirmation).toBeVisible();
		await confirmation.getByRole("button", { name: "Keep editing", exact: true }).last().click();
		await expect(title).toHaveValue("Preserve this draft");
		await expect(title).toBeFocused();
		await expect(create.getByRole("button", { name: /^Date:/ })).toHaveText(oldDate!);
		await expect(create.getByRole("combobox", { name: "Start time" })).toHaveValue(oldStart);
		await page.mouse.click(point.x, point.y);
		await confirmation.getByRole("button", { name: "Discard event", exact: true }).click();
		await page.mouse.click(point.x, point.y);
		await expect(page.getByRole("dialog")).toHaveCount(1);
		await expect(title).toHaveValue("");
		await expect(title).toBeFocused();
		if (view === "month") await expect(create.getByRole("button", { name: /^Date:/ })).toContainText("Tuesday, July 21, 2026");
		else await expect(create.getByRole("combobox", { name: "Start time" })).not.toHaveValue(oldStart);
		await expect(page.locator("[data-draft]")).toHaveCount(1);
	});
}

test("scrolls the calendar and event form with hidden scrollbar chrome", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockAuthenticatedReads(page, { ...events, events: [] });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-20`);
  const calendar = page.locator("[data-calendar-area]");
  await calendar.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => calendar.evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe("none");
  await calendar.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => calendar.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await openCreateEvent(page);
  const panel = page.getByRole("dialog", { name: "Create event", exact: true });
  const body = panel.locator('[data-editor-body]');
  await expect.poll(() => body.evaluate(element => getComputedStyle(element).scrollbarWidth)).toBe("none");
  await body.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(panel.getByRole("button", { name: "Create", exact: true })).toBeInViewport();
  await panel.getByPlaceholder("Add notes").fill("Scrollable notes");
  await page.screenshot({ path: testInfo.outputPath("docked-create-hidden-scrollbars.png") });
});

test("creation Inspector preserves a draft across the modal viewport boundary", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 916 });
  await mockAuthenticatedReads(page, { ...events, events: [] });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-20`);
  await openCreateEvent(page);
  const panel = page.getByRole("dialog", { name: "Create event", exact: true });
  const title = panel.getByRole("textbox", { name: "Event title" });
  await title.fill("Draft across layouts");
  await panel.getByPlaceholder("Add location").fill("Studio C");
  await panel.getByPlaceholder("Add notes").fill("Keep these notes");
  await panel.getByRole("combobox", { name: "Start time" }).fill("14:30");
  await panel.getByRole("combobox", { name: "Start time" }).press("Tab");
  for (const width of [1023, 390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 916 });
    await expect(title).toHaveValue("Draft across layouts");
    await expect(panel.getByPlaceholder("Add location")).toHaveValue("Studio C");
    await expect(panel.getByPlaceholder("Add notes")).toHaveValue("Keep these notes");
    await expect(panel.getByRole("combobox", { name: "Start time" })).toHaveValue("14:30");
    if (width <= 1023) await expect(panel).toHaveAttribute("aria-modal", "true");
    else await expect(panel).not.toHaveAttribute("aria-modal", "true");
  }
  const write = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/events");
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  expect((await write).postDataJSON()).toMatchObject({ title: "Draft across layouts", location: "Studio C", description: "Keep these notes", start: "2026-07-20T12:30:00.000Z" });
  await expect(panel).toHaveCount(0);
});

test("creation Inspector retains pending writes and failures across a narrow resize", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 916 });
  await mockAuthenticatedReads(page, { ...events, events: [] });
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/events", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts++;
    if (attempts > 1) return route.fallback();
    await pending;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Test write failure" }) });
  });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-20`);
  await openCreateEvent(page);
  const panel = page.getByRole("dialog", { name: "Create event", exact: true });
  const title = panel.getByRole("textbox", { name: "Event title" });
  await title.fill("Retain failed write");
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => attempts).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(title).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await panel.press("Escape");
  await expect(panel).toBeVisible();
  expect(attempts).toBe(1);
  release();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(title).toBeEnabled();
  await expect(title).toHaveValue("Retain failed write");
  await page.setViewportSize({ width: 1280, height: 916 });
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", { name: "Create", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("creation Inspector stays fixed while its header is dragged and restores keyboard focus", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	const calendar = page.locator("[data-calendar-area]");
	const calendarBefore = await calendar.boundingBox();
	const origin = page.locator('[data-day-key="2026-07-15"]');
	await origin.focus();
	await origin.press("Enter");
	const panel = page.getByRole("dialog", { name: "Create event", exact: true });
	await expect(panel.getByRole("textbox", { name: "Event title" })).toBeFocused();
	await settleLayout(page);
		const before = (await panel.boundingBox())!;
	expect(before).toEqual({ x: 900, y: 0, width: 540, height: 900 });
	expect(await calendar.boundingBox()).toMatchObject({ x: calendarBefore!.x, width: calendarBefore!.width });
	const header = panel.getByRole("heading", { name: "New event", exact: true });
	const grip = (await header.boundingBox())!;
	await page.mouse.move(grip.x + 8, grip.y + grip.height / 2);
	await page.mouse.down();
	await page.mouse.move(grip.x - 220, grip.y + grip.height / 2 + 80, { steps: 10 });
	await page.mouse.up();
	expect(await panel.boundingBox()).toEqual(before);
	expect(await calendar.boundingBox()).toMatchObject({ x: calendarBefore!.x, width: calendarBefore!.width });
	await expect(panel.getByRole("button", { name: /^Date:/ })).toContainText("Wednesday, July 15, 2026");
	await expect(page.locator("[data-live]")).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("create-inspector-desktop.png") });
	await panel.getByRole("button", { name: "Close new event" }).click();
	await expect(panel).toHaveCount(0);
	await expect(origin).toBeFocused();
});

test("shows a dragged event where it is going and a ghost where it was", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-06`);

	const block = page.getByRole("button", { name: /Weekly review/ }).first();
	await expect(block).toBeVisible();
	const from = (await block.boundingBox())!;
	const monday = page.locator("[data-time-grid-column]").first();
	const thursday = page.locator("[data-time-grid-column]").nth(3);
	const target = (await thursday.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		target.x + target.width / 2,
		from.y + from.height / 2 + 70,
		{ steps: 10 },
	);

	// The event is where the pointer is — in another day's column, at the time it
	// would take — and its outline stays behind on the day it came from.
	const preview = page.locator("[data-drag-preview]");
	await expect(preview).toHaveCount(1);
	await expect(thursday.locator("[data-drag-preview]")).toHaveCount(1);
	await expect(preview).toContainText("Weekly review");
	await expect(preview).toContainText("12:00–13:00");
	await expect(monday.locator("[data-ghost]")).toHaveCount(1);

	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
	await expect(page.locator("[data-ghost]")).toHaveCount(0);
});

test("shows a dragged chip in the month cell it would land in", async ({
	page,
}) => {
	await page.setViewportSize({ width: 800, height: 720 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const calendarArea = page.locator("[data-calendar-area]");
	const initialScrollTop = await calendarArea.evaluate(
		(element) => element.scrollTop,
	);
	const chip = page.getByRole("button", { name: /Client call/ }).first();
	await expect(chip).toBeVisible();
	const from = (await chip.boundingBox())!;
	const origin = page.locator('[data-day-key="2026-07-08"]');
	const target = page.locator('[data-day-key="2026-07-10"]');
	const to = (await target.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 10,
	});

	await expect(target.locator("[data-drag-preview]")).toHaveCount(1);
	await expect(target.locator("[data-drag-preview]")).toContainText(
		"Client call",
	);
	await expect(origin.getByRole("button", { name: /more/ })).toBeVisible();
	expect(await calendarArea.evaluate((element) => element.scrollTop)).toBe(
		initialScrollTop,
	);

	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
});

test("previews a dragged all-day event across the days it would land on", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// Family holiday runs Friday 17 to Wednesday 22, so a day forward lands it on
	// 18 to 23 and crosses the week edge on the way.
	const bar = page.getByRole("button", { name: /Family holiday/ }).first();
	await expect(bar).toBeVisible();
	const from = (await bar.boundingBox())!;
	const nextDay = page.locator('[data-day-key="2026-07-18"]');
	const to = (await nextDay.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 10,
	});

	// Six days previewed, one block per cell — not a single chip under the pointer
	// that would read as the event shrinking to a day.
	await expect(page.locator("[data-drag-preview]")).toHaveCount(6);
	for (const day of [18, 19, 20, 21, 22, 23]) {
		await expect(
			page.locator(`[data-day-key="2026-07-${day}"] [data-drag-preview]`),
		).toHaveCount(1);
	}
	await expect(
		page.locator('[data-day-key="2026-07-17"] [data-drag-preview]'),
	).toHaveCount(0);

	// Its own colour and its own shape: the family calendar's blue, titled where
	// the range starts and blank where it is continuing.
	await expect(nextDay.locator("[data-drag-preview]")).toContainText(
		"Family holiday",
	);
	await expect(
		page.locator('[data-day-key="2026-07-19"] [data-drag-preview]'),
	).toHaveText("");
	expect(
		await nextDay
			.locator("[data-drag-preview]")
			.evaluate((element) => getComputedStyle(element).backgroundColor),
	).toBe("rgb(54, 90, 146)");

	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
});

test("moves a bar grabbed by its middle to where the preview drew it", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await mockAuthenticatedReads(page);
	const writes: Array<{ end: string; start: string }> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") {
			const body = route.request().postDataJSON().patch as {
				end: string;
				start: string;
			};
			writes.push({ end: body.end, start: body.start });
		}
		return route.fallback();
	});
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// Family holiday runs 17 to 22. Grab it on the 19th and drop on the 21st:
	// two days, so it lands on 19 to 24 — the drop day does not become the start.
	const middle = page
		.locator('[data-day-key="2026-07-19"]')
		.getByRole("button", { name: /Family holiday/ });
	await expect(middle).toBeVisible();
	const from = (await middle.boundingBox())!;
	const target = page.locator('[data-day-key="2026-07-21"]');
	const to = (await target.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 10,
	});

	await expect(page.locator("[data-drag-preview]")).toHaveCount(6);
	await expect(
		page.locator('[data-day-key="2026-07-19"] [data-drag-preview]'),
	).toHaveCount(1);
	await expect(
		page.locator('[data-day-key="2026-07-24"] [data-drag-preview]'),
	).toHaveCount(1);
	await expect(
		page.locator('[data-day-key="2026-07-18"] [data-drag-preview]'),
	).toHaveCount(0);

	await page.mouse.up();

	// What was previewed is what was written: no jump on release.
	await expect(page.locator('[data-slot="toast-region"]')).toContainText(
		"Event moved.",
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]!.start).toContain("2026-07-19");
	expect(writes[0]!.end).toContain("2026-07-24");
});

test("steps a whole week aside for a dragged bar and leaves its ghost in line", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const bar = page.getByRole("button", { name: /Family holiday/ }).first();
	await expect(bar).toBeVisible();
	const from = (await bar.boundingBox())!;
	const nextDay = page.locator('[data-day-key="2026-07-18"]');
	const to = (await nextDay.boundingBox())!;

	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 10,
	});

	// The bar it left behind keeps the line the preview carries on, so the two
	// read as one thing rather than a step.
	const ghost = page.locator('[data-day-key="2026-07-17"] [data-ghost]');
	await expect(ghost).toHaveCount(1);
	const ghostBox = (await ghost.boundingBox())!;
	const previewBox = (await nextDay
		.locator("[data-drag-preview]")
		.boundingBox())!;
	expect(Math.abs(ghostBox.y - previewBox.y)).toBeLessThanOrEqual(1);

	// The week below is covered from Monday to Thursday only, yet every cell in it
	// steps aside by the same line — otherwise a chip a day past the range would
	// sit higher than its neighbours.
	const covered = (await page
		.locator('[data-day-key="2026-07-20"]')
		.getByRole("button", { name: /Weekly review/ })
		.boundingBox())!;
	const beyond = (await page
		.locator('[data-day-key="2026-07-24"]')
		.getByRole("button", { name: /Client presentation/ })
		.boundingBox())!;
	expect(Math.abs(covered.y - beyond.y)).toBeLessThanOrEqual(1);

	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
	await expect(page.locator("[data-ghost]")).toHaveCount(0);
});

test("parks a stuck agenda day below the year band, not under it", async ({
	page,
}) => {
	await mockAuthenticatedReads(page, { ...events, events: Array.from({ length: 20 }, (_, i) => event(`sticky-${i}`, `Agenda item ${i}`, "personal", "#b3492f", "2026-07-27T08:00:00.000Z", "2026-07-27T09:00:00.000Z")) });
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/agenda?date=2026-07-26`);
	await expect(page.locator("[data-agenda-date]").first()).toBeVisible();

	const scroller = page.locator('[data-calendar-area]');
	await scroller.evaluate((element) => {
		element.scrollTop = 90;
	});

	// Both are sticky and the year sits above, so a shared stop would slide the
	// day label out of sight underneath it.
	const geometry = await page.evaluate(() => {
		const area = document
			.querySelector('[data-calendar-area]')!
			.getBoundingClientRect();
		const year = document
			.querySelector("[data-agenda-year]")!
			.getBoundingClientRect();
		const resting = [...document.querySelectorAll("[data-agenda-date] > time")]
			.map((date) => date.getBoundingClientRect().top - area.top)
			.filter((top) => top >= 0 && top < 60);

		return { resting, yearBottom: year.bottom - area.top };
	});

	expect(geometry.resting.length).toBeGreaterThan(0);
	for (const top of geometry.resting) {
		expect(top).toBeGreaterThanOrEqual(geometry.yearBottom - 1);
	}
});

test("keeps a page's settings button on its row, not under it", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	const row = page.getByRole("button", { name: "My calendar", exact: true });
	const settings = page.getByRole("button", { name: "Edit My calendar" });
	await expect(row).toBeVisible();
	const rowBox = (await row.boundingBox())!;
	const settingsBox = (await settings.boundingBox())!;

	// Overlaid on the row's right edge and centred on it — the row stays one line.
	expect(settingsBox.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);
	expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(
		rowBox.x + rowBox.width + 1,
	);
	expect(
		Math.abs(
			settingsBox.y + settingsBox.height / 2 - (rowBox.y + rowBox.height / 2),
		),
	).toBeLessThanOrEqual(1);
});

test("offers the drawer toggle only where there is a drawer", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// Desktop keeps the sidebar in place, so a toggle for it opens nothing.
	await expect(
		page.getByRole("button", { name: "Open navigation" }),
	).toBeHidden();

	await page.setViewportSize({ height: 720, width: 390 });
	const toggle = page.getByRole("button", { name: "Open navigation" });
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(
		page.getByRole("button", { name: "Close navigation" }).first(),
	).toBeVisible();
});

for (const [scopeLabel, width] of [
	["This event", 1280],
	["This and following events", 390],
	["All events", 1280],
] as const) {
	test(`K05 third occurrence title edit: ${scopeLabel}`, async ({ page }) => {
		await page.setViewportSize({ width, height: 844 });
		const master = event(
			"weekly-review",
			"Weekly review",
			"personal",
			"#b3492f",
			"2026-07-06T09:00:00Z",
			"2026-07-06T10:30:00Z",
			{ recurrence: "FREQ=WEEKLY;COUNT=6" },
		);
		await mockAuthenticatedReads(page, { ...events, events: [master] });
		const writes: Array<{ body: Record<string, unknown>; method: string }> = [];
		await page.route("**/api/v1/events", async (route) => {
			const method = route.request().method();
			if (method === "PATCH" || method === "POST")
				writes.push({ method, body: route.request().postDataJSON() });
			return route.fallback();
		});
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-20`);
		await page
			.getByRole("button", { name: /Weekly review/ })
			.first()
			.click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
			"July 20",
		);
		await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText(
			"July 20",
		);
		await page.getByRole("textbox", { name: "Event title" }).fill("Weekly retro");
		await page
			.getByRole("textbox", { name: "Event title" })
			.press("Control+Enter");
		const scope = page.getByRole("dialog", { name: "Change recurring event" });
		await expect(scope).toBeVisible();
		expect(writes).toHaveLength(0);
		await scope
			.getByRole("button", { name: "Close change recurring event dialog" })
			.click();
		await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(
			"Weekly retro",
		);
		await expect(
			page.getByRole("button", { name: "Save", exact: true }),
		).toBeFocused();
		expect(writes).toHaveLength(0);
		await page.keyboard.press("Enter");
		await scope.getByRole("button", { name: scopeLabel, exact: true }).focus();
		await page.keyboard.press("Enter");
		await expect(scope).toHaveCount(0);
		expect(writes.map((write) => write.method)).toEqual(
			scopeLabel === "All events" ? ["PATCH"] : ["PATCH", "POST"],
		);
		const { scopeEdit, ...update } = writes[0]!.body;
		expect(scopeEdit).toEqual({
			updates: [update],
			creates: writes.slice(1).map((write) => write.body),
		});
		expect({
			...master,
			start: new Date(master.start).toISOString(),
			end: new Date(master.end).toISOString(),
			...(update.patch as object),
		}).toMatchObject({
			start: new Date(master.start).toISOString(),
			end: new Date(master.end).toISOString(),
			title: scopeLabel === "All events" ? "Weekly retro" : master.title,
		});
		if (scopeLabel !== "All events") {
			expect(writes[1]!.body).toMatchObject({
				title: "Weekly retro",
				start: "2026-07-20T09:00:00.000Z",
				end: "2026-07-20T10:30:00.000Z",
				recurrence: scopeLabel === "This event" ? null : "FREQ=WEEKLY;COUNT=4",
			});
			expect((update.patch as Record<string, unknown>).recurrence).toContain(
				scopeLabel === "This event"
					? "EXDATE:20260720T090000Z"
					: "UNTIL=20260720T085959Z",
			);
		} else
			expect((update.patch as Record<string, unknown>).recurrence).toBeUndefined();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
		).toBe(false);
	});
}

for (const shift of [false, true]) {
	test(`K05 More options rebases third occurrence draft to master (time change ${shift})`, async ({
		page,
	}) => {
		await mockAuthenticatedReads(page);
		const writes: Record<string, unknown>[] = [];
		await page.route("**/api/v1/events", async (route) => {
			if (["PATCH", "POST"].includes(route.request().method()))
				writes.push(route.request().postDataJSON());
			return route.fallback();
		});
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-20`);
		await page
			.getByRole("button", { name: /Weekly review/ })
			.first()
			.click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
			"July 20",
		);
		await page.getByRole("textbox", { name: "Event title" }).fill("Master draft");
		if (shift) {
			await page.getByRole("combobox", { name: "Start time" }).fill("13:00");
			await page.getByRole("combobox", { name: "Start time" }).press("Tab");
		}
		await page.getByRole("button", { name: "Expand event editor" }).click();
		await expect(
			page.getByText("Changes apply to the whole series."),
		).toBeVisible();
		await expect(page.getByRole("button", { name: /^Date:/ })).toContainText(
			"July 6",
		);
		await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText(
			"July 6",
		);
		await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(
			"Master draft",
		);
		expect(writes).toHaveLength(0);
		expect(page.url()).not.toContain("scopeEdit");
		await page
			.getByRole("textbox", { name: "Event title" })
			.press("Control+Enter");
		await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(
			0,
		);
		expect(writes).toHaveLength(1);
		expect(writes[0]!.expectedRevision).toBe(1);
		expect(writes[0]!.patch).toEqual({
			title: "Master draft",
			...(shift
				? { start: "2026-07-06T11:00:00.000Z", end: "2026-07-06T12:00:00.000Z" }
				: {}),
		});
	});
}

for (const width of [1280, 390]) {
	for (const reason of ["unsupported", "denied", "unknown"] as const) {
		test(`K04 scope refusal ${reason} keeps draft and server reason at ${width}px`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 800 });
			await mockAuthenticatedReads(page);
			const requests: Array<{ method: string; body: Record<string, unknown> }> =
				[];
			const message = `This recurrence operation is ${reason}. No changes were saved.`;
			await page.route("**/api/v1/events", async (route) => {
				const method = route.request().method();
				if (method !== "PATCH" && method !== "POST") return route.fallback();
				requests.push({ method, body: route.request().postDataJSON() });
				return route.fulfill({
					status: 403,
					contentType: "application/json",
					body: JSON.stringify({ error: message, reason, capability: "recurrence" }),
				});
			});
			await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
			await page
				.getByRole("button", { name: /Weekly review/ })
				.first()
				.click();
			await page.getByRole("button", { name: "Edit", exact: true }).click();
			await page
				.getByRole("textbox", { name: "Event title" })
				.fill("Keep this draft");
			await page.getByRole("button", { name: "Save", exact: true }).click();
			const scope = page.getByRole("dialog", { name: "Change recurring event" });
			const occurrence = scope.getByRole("button", {
				name: "This event",
				exact: true,
			});
			await occurrence.focus();
			await page.keyboard.press("Enter");
			await expect(scope.getByRole("alert")).toContainText(message);
			expect(requests.map((request) => request.method)).toEqual(["PATCH"]);
			const intent = requests[0]!.body.scopeEdit as {
				updates: unknown[];
				creates: Array<{ title: string }>;
			};
			expect(intent.updates).toHaveLength(1);
			expect(intent.creates[0]!.title).toBe("Keep this draft");
			await expect(
				page.getByRole("status").filter({ hasText: "Occurrence updated." }),
			).toHaveCount(0);
			await scope
				.getByRole("button", { name: "Close change recurring event dialog" })
				.click();
			await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue(
				"Keep this draft",
			);
			await expect(
				page.getByRole("button", { name: "Save", exact: true }),
			).toBeFocused();
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			);
			expect(overflow).toBe(false);
		});
	}
}

test("edits a whole series without moving it onto one date", async ({
	page,
}) => {
	const recurrence =
		"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20261231T225959Z\nEXDATE:20260803T090000Z\nRDATE:20260804T090000Z";
	await mockAuthenticatedReads(page, {
		...events,
		events: events.events.map((item) =>
			item.id === "weekly-review" ? { ...item, recurrence } : item,
		),
	});
	const writes: Array<Record<string, unknown>> = [];
	await page.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") {
			writes.push(route.request().postDataJSON() as Record<string, unknown>);
		}
		return route.fallback();
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page
		.getByRole("button", { name: /Weekly review/ })
		.first()
		.click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("textbox", { name: "Event title" }).fill("Weekly retro");
	await page.getByRole("button", { name: "Save" }).click();
	const savedResponse = page.waitForResponse((response) =>
		response.url().endsWith("/api/v1/events") &&
		response.request().method() === "PATCH",
	);
	await page
		.getByRole("dialog", { name: "Change recurring event" })
		.getByRole("button", { name: "All events" })
		.click();

	await expect(page.getByRole("status")).toContainText(
		"Recurring series updated.",
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]!.patch).toEqual({ title: "Weekly retro" });
	expect(writes[0]!.expectedRevision).toBe(1);
	const { scopeEdit, ...update } = writes[0]!;
	expect(scopeEdit).toEqual({ updates: [update], creates: [] });
	// The master keeps its own first occurrence rather than jumping to the one
	// that was edited.
	expect(update.patch).not.toHaveProperty("start");
	expect(update.patch).not.toHaveProperty("recurrence");
	const saved = await (await savedResponse).json();
	expect(saved.recurrence).toBe(recurrence);
	expect(saved.start).toContain("2026-07-06");
	expect(saved.revision).toBe(2);
});

test("asks the scope question above the layer that raised it", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page
		.getByRole("button", { name: /Weekly review/ })
		.first()
		.click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("button", { name: "Save" }).click();

	const scope = page.getByRole("dialog", { name: "Change recurring event" });
	await expect(scope).toBeVisible();

	// The editor stays mounted so nothing typed is lost, but a popover paints
	// above dialogs by default and would hide the question it just asked.
	const box = (await scope.boundingBox())!;
	const topmost = await page.evaluate(
		([x, y]) => {
			const element = document.elementFromPoint(x, y);
			return Boolean(element?.closest('[role="dialog"][data-state="open"]'));
		},
		[box.x + box.width / 2, box.y + 20],
	);
	expect(topmost).toBe(true);

	// Dismissing it leaves the edit where it was rather than writing anything.
	await scope
		.getByRole("button", { name: "Close change recurring event dialog" })
		.click();
	await expect(scope).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Edit series" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Save" })).toBeFocused();
});

test("says what a failed write left behind", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/users/me/settings", (route) =>
		route.request().method() === "PATCH"
			? route.fulfill({
					body: JSON.stringify({ error: "server", requestId: "req-1" }),
					contentType: "application/json",
					status: 500,
				})
			: route.fallback(),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "Settings" }).click();
	const settingsDialog = page.getByRole("dialog", { name: "Settings" });
	await settingsDialog.getByRole("radio", { name: "12 hour" }).click();

	// An error has to answer what happened to the thing the user just touched —
	// "could not be saved" alone leaves them guessing whether it stuck.
	await expect(settingsDialog.getByRole("alert")).toContainText(
		"could not be saved",
	);
	await expect(settingsDialog.getByRole("alert")).toContainText(
		"went back to its previous value",
	);
	await expect(
		settingsDialog.getByRole("radio", { name: "24 hour" }),
	).toHaveAttribute("aria-checked", "true");
});

test("brings the calendar forward when the live stream comes back", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	let eventReads = 0;
	await page.route(/\/api\/v1\/events(?:\?.*)?$/, (route) => {
		if (route.request().method() === "GET") eventReads += 1;
		return route.fallback();
	});
	// The stream is down before the app opens it, so it starts out reconnecting.
	const streamDown = (route: Route) => route.abort();
	await page.route("**/api/stream?clientVersion=*", streamDown);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
	const whileDown = eventReads;

	await page.unroute("**/api/stream?clientVersion=*", streamDown);
	await page.route("**/api/stream?clientVersion=*", (route) =>
		route.fulfill({ body: ":ok\n\n", contentType: "text/event-stream" }),
	);

	// Nothing arrives over the stream to say what changed, so a reopen has to
	// refetch: anything that happened while it was down is otherwise invisible.
	await expect(async () => {
		expect(eventReads).toBeGreaterThan(whileDown);
	}).toPass({ timeout: 10_000 });
});

/** Which snapshots the browser is holding, if any. */
function snapshotKeys(page: Page) {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve) => {
				const request = indexedDB.open("musubi-offline");
				request.onsuccess = () => {
					const database = request.result;
					if (![...database.objectStoreNames].includes("query-cache")) {
						return resolve([]);
					}
					const read = database
						.transaction("query-cache")
						.objectStore("query-cache")
						.getAllKeys();
					read.onsuccess = () => resolve(read.result.map(String));
					read.onerror = () => resolve([]);
				};
				request.onerror = () => resolve([]);
			}),
	);
}

function snapshotQueryNames(page: Page) {
	return page.evaluate(
		() =>
			new Promise<string[]>((resolve) => {
				const request = indexedDB.open("musubi-offline");
				request.onsuccess = () => {
					const database = request.result;
					if (![...database.objectStoreNames].includes("query-cache")) {
						return resolve([]);
					}
					const read = database
						.transaction("query-cache")
						.objectStore("query-cache")
						.getAll();
					read.onsuccess = () =>
						resolve(
							read.result.flatMap((snapshot) =>
								snapshot.state.queries.map((query: { queryKey: unknown[] }) =>
									String(query.queryKey[0]),
								),
							),
						);
					read.onerror = () => resolve([]);
				};
				request.onerror = () => resolve([]);
			}),
	);
}

test("starts from its snapshot with no server, then catches up", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
	// The snapshot is written on a throttle, so wait for it to land rather than
	// reloading into an empty store.
	await expect(async () => {
		expect(
			await page.evaluate(() =>
				window.localStorage.getItem("musubi:last-session"),
			),
		).toBeTruthy();
		expect(await snapshotKeys(page)).not.toHaveLength(0);
	}).toPass({ timeout: 5_000 });

	// Everything the app talks to is gone — not refusing, unreachable, which is
	// what a laptop off the network and a self-hosted server that is down both
	// look like. `/src/**` has to keep loading or Vite itself cannot serve the app.
	let failedCalendarReads = 0;
	const dead = async (route: Route) => {
		await route.abort();
		if (new URL(route.request().url()).pathname === "/api/v1/calendars") failedCalendarReads++;
	};
	for (const pattern of ["**/api/v1/**", "**/api/auth/**", "**/api/stream*"]) {
		await page.route(pattern, dead);
	}
	// Make the restored queries stale without sleeping through the cache TTL.
	await page.clock.setFixedTime(new Date(Date.now() + 120_000));
	await page.reload();

	// The five guarantees of offline v1 (`07-realtime-offline-federation.md:88-92`),
	// seen from the outside: the calendar is there, it says how old it is, and it
	// refuses to pretend a write went through.
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
	const offlineState = page.getByText(/Offline — saved (.+ago|just now)/);
	await expect(offlineState).toBeVisible();
	// Wait for the background refresh and its retry to fail. Otherwise the
	// editor assertions can finish before a failed refresh drops the snapshot.
	await expect.poll(() => failedCalendarReads).toBeGreaterThanOrEqual(2);
	await expect(offlineState).toBeVisible();

	await page
		.getByRole("button", { name: /Client call/ })
		.first()
		.click();
	await page.getByRole("button", { exact: true, name: "Edit" }).click();
	const title = page.getByRole("textbox", { name: "Event title" });
	await title.fill("Renamed while offline");
	await expect(
		page.getByRole("button", { name: "No connection" }),
	).toBeDisabled();
	// The typing survives — a draft is worth more than a cleared form.
	await expect(title).toHaveValue("Renamed while offline");
	await page.keyboard.press("Escape");

	for (const pattern of ["**/api/v1/**", "**/api/auth/**", "**/api/stream*"]) {
		await page.unroute(pattern, dead);
	}
	await page.evaluate(() => window.dispatchEvent(new Event("online")));

	// Back online the banner has to go, or a fresh calendar keeps apologising for
	// being stale.
	await expect(offlineState).toHaveCount(0, { timeout: 10_000 });
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
});

test("keeps a previously loaded task list readable offline", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/tasks", (route) =>
		respond(route, {
			tasks: [
				{
					calendarID: "personal",
					completedAt: null,
					creatorID: session.user.id,
					description: null,
					due: "2026-07-28T16:00:00.000Z",
					id: "offline-task",
					isAllDay: false,
					percentComplete: 0,
					priority: 0,
					recurrence: null,
					relatedTo: null,
					sequence: 0,
					start: null,
					status: "needs-action",
					title: "Pack the offline checklist",
					url: null,
				},
			],
		}),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/tasks?date=2026-07-26`);
	await expect(
		page.getByRole("button", {
			name: /^Pack the offline checklist/,
		}),
	).toBeVisible();
	await expect.poll(() => snapshotQueryNames(page)).toContain("tasks");

	const dead = (route: Route) => route.abort();
	for (const pattern of ["**/api/v1/**", "**/api/auth/**", "**/api/stream"]) {
		await page.route(pattern, dead);
	}
	await page.reload();

	const tasks = page.getByRole("region", { name: "Tasks" });
	await expect(
		tasks.getByText("Pack the offline checklist", { exact: true }),
	).toBeVisible();
	await expect(
		tasks.getByRole("combobox", {
			name: "Status of Pack the offline checklist",
		}),
	).toBeDisabled();
	await expect(
		tasks.getByRole("button", { name: /Pack the offline checklist/ }),
	).toHaveCount(0);
});

test("leaves nothing of the last account on a shared computer", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();

	await page.getByRole("button", { name: "User menu for Web QA" }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login/);
	// Not "eventually gone" — never rendered. `06-settings-pages-sync.md:175` is
	// explicit that the login screen must not flash the previous user's data.
	await expect(page.getByRole("button", { name: /Client call/ })).toHaveCount(0);
	await expect(page.getByText("Web QA")).toHaveCount(0);

	expect(
		await page.evaluate(() => window.localStorage.getItem("musubi:last-session")),
	).toBeNull();
	expect(await snapshotKeys(page)).toEqual([]);

	// The next person, with the server unreachable, must reach the login page and
	// not a snapshot: nothing local is left to restore.
	const dead = (route: Route) => route.abort();
	for (const pattern of ["**/api/v1/**", "**/api/auth/**", "**/api/stream"]) {
		await page.route(pattern, dead);
	}
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: /Client call/ })).toHaveCount(0);
});

test("carries one session's edit into the other over the stream", async ({
	browser,
	browserName,
}) => {
	test.skip(
		browserName === "firefox",
		"Playwright Firefox does not reliably dispatch finite mocked SSE responses.",
	);
	// One context, one mock, two pages: two tabs of the same account against the
	// same backend, which is what the server's SSE fan-out is for.
	const context = await browser.newContext();
	await mockAuthenticatedReads(context);

	// Frames the second session is waiting for. Playwright cannot push into an
	// open response, so instead its stream request parks until there is something
	// to say, then delivers that frame and ends — the client reconnects on its own.
	const pending: string[] = [];
	await context.route("**/api/v1/events", async (route) => {
		if (route.request().method() === "PATCH") {
			pending.push("event_updated");
		}
		return route.fallback();
	});

	const first = await context.newPage();
	const second = await context.newPage();
	await second.route("**/api/stream?clientVersion=*", async (route) => {
		expect(new URL(route.request().url()).searchParams.get("clientVersion")).toBe(
			PRODUCT_VERSION,
		);
		for (let waited = 0; pending.length === 0 && waited < 10_000; waited += 50) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const type = pending.shift();
		if (!type) return route.abort();
		return route.fulfill({
			body: `data: ${JSON.stringify({ payload: {}, type })}\n\n`,
			contentType: "text/event-stream",
		});
	});

	const url = `/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`;
	await first.goto(url);
	await second.goto(url);
	await expect(
		second.getByRole("button", { name: /Client call/ }).first(),
	).toBeVisible({ timeout: 15_000 });

	await first
		.getByRole("button", { name: /Client call/ })
		.first()
		.click();
	await first.getByRole("button", { exact: true, name: "Edit" }).click();
	await first
		.getByRole("textbox", { name: "Event title" })
		.fill("Renamed in the first tab");
	await first.getByRole("button", { name: "Save" }).click();
	await expect(first.getByRole("status")).toContainText("Event updated.");

	// The frame carries no event data — `07-realtime-offline-federation.md:35` is
	// explicit that there is no durable log to replay, so a notification is a cue
	// to refetch, not the change itself. The second tab must land on the new title
	// without anybody reloading it.
	await expect(
		second.getByRole("button", { name: /Renamed in the first tab/ }).first(),
	).toBeVisible({ timeout: 15_000 });
	await expect(second.getByRole("button", { name: /Client call/ })).toHaveCount(
		0,
	);

	await context.close();
});

// 200% is where a person with low vision lives all day; 320 CSS px is what WCAG
// 1.4.10 actually demands (400% of a 1280 px viewport). Both, because a layout
// can survive one step and break at the next.
for (const { label, width } of [
	{ label: "200%", width: 640 },
	{ label: "400%", width: 320 },
]) {
	test(`stays usable at ${label} zoom`, async ({ page }) => {
		await mockAuthenticatedReads(page);
		await page.setViewportSize({ height: 512, width });

		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
		await expect(
			page.getByRole("heading", { name: "My calendar" }),
		).toBeVisible();

		// Nothing may scroll the document sideways: a reader who has to pan left and
		// right to read one row is the exact failure the criterion is about.
		const overflow = await page.evaluate(() => {
			const { documentElement: root } = document;
			return root.scrollWidth - root.clientWidth;
		});
		expect(overflow).toBeLessThanOrEqual(0);

		// And the controls are still reachable, not merely present.
		await page.getByRole("button", { name: "Today" }).click();
		await page.getByRole("button", { name: "Open navigation" }).click();
		await expect(
			page.getByRole("button", { name: "User menu for Web QA" }),
		).toBeVisible();
		await page.keyboard.press("Escape");

		await expectNoAccessibilityViolations(page);
	});
}

test("explains an unconfirmed address instead of blaming the passphrase", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	// What a server with REQUIRE_EMAIL_VERIFICATION answers: a 403 carrying a code,
	// not a message the client has to pattern-match.
	await page.route("**/api/auth/sign-in/email", (route) =>
		route.fulfill({
			body: JSON.stringify({
				code: "EMAIL_NOT_VERIFIED",
				message: "Email not verified",
			}),
			contentType: "application/json",
			status: 403,
		}),
	);
	let resends = 0;
	await page.route("**/api/auth/send-verification-email", (route) => {
		resends += 1;
		return respond(route, { status: true });
	});

	await page.goto("/login");
	// Until React has taken the form over, the browser submits it natively and
	// reloads the page — the same trap the narrow-screen sign-in test waits out.
	await page.waitForLoadState("networkidle");
	await page
		.getByRole("textbox", { name: "Email" })
		.fill("unconfirmed@example.com");
	await page.getByLabel("Passphrase").fill("supersecret123");
	await page.getByRole("button", { exact: true, name: "Continue" }).click();

	// The passphrase was right. Saying "check your details" here sends someone to
	// reset a password that works.
	await expect(
		page.getByRole("heading", { name: "Check your email" }),
	).toBeVisible();
	await expect(page.getByText("unconfirmed@example.com")).toBeVisible();
	// And the form is gone: nothing typed here can move this forward.
	await expect(page.getByLabel("Passphrase")).toHaveCount(0);

	await page.getByRole("button", { name: "Send the link again" }).click();
	await expect(
		page.getByRole("button", { name: "Link sent again" }),
	).toBeDisabled();
	expect(resends).toBe(1);

	await expectNoAccessibilityViolations(page);
});

test("says a new account is waiting on its confirmation link", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	// Sign-up succeeds but creates no session — `token: null` is how Better Auth
	// says "verified addresses only".
	await page.route("**/api/auth/sign-up/email", (route) =>
		respond(route, {
			token: null,
			user: {
				email: "new@example.com",
				emailVerified: false,
				id: "u1",
				name: "New Person",
			},
		}),
	);

	await page.goto("/login");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "Create one" }).click();
	await page.getByLabel("Name").fill("New Person");
	await page.getByLabel("Email").fill("new@example.com");
	await page.getByLabel("Passphrase", { exact: true }).fill("supersecret123");
	await page.getByLabel("Confirm passphrase").fill("supersecret123");
	await page.getByRole("button", { name: "Create account" }).click();

	// Redirecting instead would bounce off the session gate straight back to the
	// login form, which reads as "it did not work".
	await expect(
		page.getByRole("heading", { name: "Check your email" }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/login/);
});

test("offers the sign-in providers this server can actually finish", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			emailVerificationRequired: false,
			minClientVersion: "0.1.2",
			// Apple is advertised for the phone, which uses the native token flow —
			// and deliberately not for the browser, which needs its own registration.
			socials: ["google", "microsoft", "apple"],
			socialsWeb: ["google", "microsoft"],
			syncProviders: [],
		}),
	);
	let social: unknown;
	await page.route("**/api/auth/sign-in/social", (route) => {
		social = route.request().postDataJSON();
		// Stop before the real provider: a redirect off-origin ends the test.
		return respond(route, {
			redirect: false,
			url: "https://accounts.example.com/oauth",
		});
	});

	await page.goto("/login?redirect=%2Fapp%2Fp%2Fmy-calendar%2Fweek");
	await page.waitForLoadState("networkidle");

	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Microsoft" }),
	).toBeVisible();
	// A browser has nowhere to send an Apple sign-in on this server, so offering
	// it would open a page that cannot come back.
	await expect(page.getByRole("button", { name: /Apple/ })).toHaveCount(0);

	await page.getByRole("button", { name: "Continue with Google" }).click();
	await expect
		.poll(() => social)
		.toEqual(
			expect.objectContaining({
				// The page someone was interrupted for has to survive the round trip.
				callbackURL: new URL("/app/p/my-calendar/week", page.url()).href,
				errorCallbackURL: new URL("/login?error=oauth", page.url()).href,
				provider: "google",
			}),
		);

	await expectNoAccessibilityViolations(page);
});

test("shows only the passphrase form on a server with no OAuth", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: false,
			emailVerificationRequired: false,
			minClientVersion: "0.1.2",
			socials: [],
			syncProviders: [],
		}),
	);

	await page.goto("/login");
	await page.waitForLoadState("networkidle");

	// Self-hosted Musubi without credentials: no dead buttons, no lonely divider.
	await expect(page.getByRole("button", { name: /Continue with/ })).toHaveCount(
		0,
	);
	await expect(page.getByText("or", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("button", { exact: true, name: "Continue" }),
	).toBeVisible();
});

test("says so when a provider sign-in does not come back", async ({ page }) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));

	// Where Better Auth returns the browser after a failed round trip.
	await page.goto("/login?error=oauth");
	await page.waitForLoadState("networkidle");

	await expect(page.getByRole("alert")).toContainText("did not come back");
});

test("offers Apple once the server has its browser registration", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			emailVerificationRequired: false,
			minClientVersion: "0.1.2",
			socials: ["google", "apple"],
			// A Services ID and a .p8 key are configured, so the redirect can come back.
			socialsWeb: ["google", "apple"],
			syncProviders: [],
		}),
	);
	let social: unknown;
	await page.route("**/api/auth/sign-in/social", (route) => {
		social = route.request().postDataJSON();
		return respond(route, {
			redirect: false,
			url: "https://appleid.apple.com/auth/authorize",
		});
	});

	await page.goto("/login");
	await page.waitForLoadState("networkidle");

	await page.getByRole("button", { name: "Continue with Apple" }).click();
	await expect
		.poll(() => social)
		.toEqual(expect.objectContaining({ provider: "apple" }));
});

test("hides Apple on an API too old to say what a browser can finish", async ({
	page,
}) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	await page.route("**/api/v1/server", (route) =>
		respond(route, {
			email: true,
			minClientVersion: "0.1.2",
			// No socialsWeb: this list mixes the phone's flows in, and Apple's is one
			// of them. Offering it would open a page with nowhere to return to.
			socials: ["google", "apple"],
			syncProviders: [],
		}),
	);

	await page.goto("/login");
	await page.waitForLoadState("networkidle");

	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /Apple/ })).toHaveCount(0);
});

test("imports the calendars of an account the moment it comes back linked", async ({
	page,
}) => {
	// The provider consent screen is a full page load away, so what the app sees
	// on the way back is a fresh boot with a marker in session storage.
	let imported = false;
	const microsoftCalendar = {
		accountId: "microsoft-account-1",
		accountLabel: "qa@outlook.com",
		color: "#4285f4",
		creatorID: "user-web-qa",
		id: "g-cal-1",
		members: [],
		name: "Work (Outlook)",
		provider: "microsoft",
		role: "owner",
		syncStatus: "active",
	};
	await mockAuthenticatedReads(page);
	// After the fixture, not before: Playwright matches the most recently
	// registered handler first, so registering this earlier would let the
	// fixture's own calendars route answer and the import would look like a no-op.
	await page.route("**/api/v1/calendars", (route) =>
		route.request().method() === "GET"
			? respond(route, imported ? [...calendars, microsoftCalendar] : calendars)
			: route.fallback(),
	);
	// The sync endpoint is what actually pulls the provider's calendars in; until
	// it runs, Better Auth has an account and the app has nothing to show for it.
	let syncCalls = 0;
	await page.route("**/api/v1/users/connections/sync", (route) => {
		expect(route.request().method()).toBe("POST");
		expect(route.request().postDataJSON()).toEqual({ provider: "microsoft" });
		syncCalls += 1;
		imported = true;
		return respond(route, {});
	});

	// The real sequence: the marker is written while the app is still running,
	// then the browser leaves for the provider and comes back to a fresh boot.
	// (A reload stands in for that trip; session storage survives both.)
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
	await page.evaluate(() =>
		window.sessionStorage.setItem("musubi:linking-provider", "microsoft"),
	);
	await page.reload();

	// The dialog reopens itself onto the imported account: landing on a plain
	// calendar after consenting is what reads as "nothing happened".
	const dialog = page.getByRole("dialog", { name: "Settings" });
	await expect(
		dialog.getByRole("button", { name: /Disconnect qa@outlook.com/ }),
	).toBeVisible();
	expect(syncCalls).toBe(1);

	// One import per return trip. The marker is consumed on read, so a later
	// reload of the same tab must not talk to Microsoft again — nor pop the dialog.
	await page.reload();
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
	expect(syncCalls).toBe(1);
});

test("says so when the import fails instead of showing an empty list", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/users/connections/sync", (route) =>
		route.fulfill({
			body: JSON.stringify({
				error: "ProviderUnavailable",
				message: "Outlook could not be reached.",
				requestId: "sync-failed",
			}),
			contentType: "application/json",
			status: 502,
		}),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(page.getByRole("button", { name: /Client call/ })).toBeVisible();
	await page.evaluate(() =>
		window.sessionStorage.setItem("musubi:linking-provider", "microsoft"),
	);
	await page.reload();

	// The account IS linked — the calendars are what failed. "No connected
	// accounts" alone would send someone to connect it a second time.
	await expect(page.getByRole("dialog", { name: "Settings" })).toContainText(
		"could not be fetched",
	);
});

const INVITE_TOKEN = "8f14e45fceea167a5a36dedd4bea2543"; // gitleaks:allow -- deterministic test token

function invitePreview() {
	return {
		color: "#6f7f6a",
		events: [
			{
				end: new Date(Date.now() + 90 * 60_000).toISOString(),
				id: "shared-1",
				isAllDay: false,
				start: new Date(Date.now() + 60 * 60_000).toISOString(),
				title: "Team lunch",
			},
		],
		id: "shared-calendar",
		members: [{ id: "owner-1", image: null, name: "Mika" }],
		name: "Studio",
	};
}

test("shows an invitation in the browser and joins it", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.route(`**/api/v1/calendars/tokens/${INVITE_TOKEN}`, (route) =>
		respond(route, invitePreview()),
	);
	let joined: unknown;
	await page.route("**/api/v1/calendars/members/*", (route) => {
		joined = {
			body: route.request().postDataJSON(),
			url: route.request().url(),
		};
		return respond(route, { id: "shared-calendar", joined: true });
	});

	await page.goto(`/invite/${INVITE_TOKEN}`);

	// The point of a preview: what you are joining and who is already on it,
	// before you decide — not a deep link to an app you may not have.
	await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
	await expect(page.getByText("Mika shared a calendar with you.")).toBeVisible();
	await expect(page.getByText("Team lunch")).toBeVisible();
	await expectNoAccessibilityViolations(page);

	await page.getByRole("button", { name: "Join this calendar" }).click();
	await expect(page).toHaveURL(/\/app\/p\/default\/month/);
	expect(joined).toMatchObject({
		body: { token: INVITE_TOKEN },
		url: expect.stringContaining("/calendars/members/shared-calendar"),
	});
});

test("keeps a long public invitation readable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route("**/api/auth/get-session", route => respond(route, null));
  const preview = invitePreview();
  preview.name = "Studio planning and a deliberately long calendar name";
  preview.members[0]!.name = "AReallyLongUnbrokenDisplayNameToCheckNarrowWrapping";
  preview.events[0]!.title = "Design review and launch coordination with the entire team";
  await page.route(`**/api/v1/calendars/tokens/${INVITE_TOKEN}`, route => respond(route, preview));
  await page.goto(`/invite/${INVITE_TOKEN}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: preview.name })).toBeVisible();
  const people = page.getByRole("list", { name: "People on this calendar" });
  const join = page.getByRole("button", { name: "Create an account to join" });
  for (const target of [people, join]) {
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await target.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
  const eventTitle = page.getByText(preview.events[0]!.title, { exact: true });
  const eventBox = (await eventTitle.boundingBox())!;
  expect(eventBox.x + eventBox.width).toBeLessThanOrEqual(320);
  expect(await eventTitle.evaluate(node => getComputedStyle(node).textOverflow)).toBe("ellipsis");
  const name = people.locator("li > span:last-child");
  expect(await name.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await expectNoAccessibilityViolations(page);
});

test("carries an invitation through sign in", async ({ page }) => {
	await page.route("**/api/auth/get-session", (route) => respond(route, null));
	await page.route(`**/api/v1/calendars/tokens/${INVITE_TOKEN}`, (route) =>
		respond(route, invitePreview()),
	);

	await page.goto(`/invite/${INVITE_TOKEN}`);
	await page.waitForLoadState("networkidle");
	await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();

	// Joining writes membership, so it needs an account here — and the invitation
	// has to survive that detour, or the person lands on an empty calendar and the
	// link is already spent.
	await page.getByRole("button", { name: "Create an account to join" }).click();
	await expect(page).toHaveURL(
		new RegExp(`/login\\?redirect=%2Finvite%2F${INVITE_TOKEN}`),
	);
});

test("says an invitation is spent rather than showing an empty page", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.route(`**/api/v1/calendars/tokens/${INVITE_TOKEN}`, (route) =>
		route.fulfill({
			body: JSON.stringify({ error: "NotFound", message: "Invite not found." }),
			contentType: "application/json",
			status: 404,
		}),
	);

	await page.goto(`/invite/${INVITE_TOKEN}`);

	await expect(
		page.getByRole("heading", { name: "This invitation is closed" }),
	).toBeVisible();
	await expectNoAccessibilityViolations(page);
});

test("moves an account to a new address, asking the old one to approve", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	let changeBody: unknown;
	await page.route("**/api/auth/change-email", (route) => {
		changeBody = route.request().postDataJSON();
		return respond(route, { status: true });
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await page.getByRole("button", { name: "User menu for Web QA" }).click();
	await page.getByRole("menuitem", { name: "Manage account" }).click();
	const accountDialog = page.getByRole("dialog", { name: "Settings" });
	await accountDialog.getByRole("button", { name: /^Email/ }).click();

	const editor = page.getByRole("dialog", { name: "Change email" });
	await expect(editor).toContainText("Currently web-qa@example.invalid");
	// The same address is not a change, and neither is half of one.
	await editor
		.getByRole("textbox", { name: "New email" })
		.fill("web-qa@example.invalid");
	await expect(
		editor.getByRole("button", { name: "Send the link" }),
	).toBeDisabled();
	await editor.getByRole("textbox", { name: "New email" }).fill("moved@");
	await expect(
		editor.getByRole("button", { name: "Send the link" }),
	).toBeDisabled();

	await editor
		.getByRole("textbox", { name: "New email" })
		.fill("Moved@Example.invalid");
	await editor.getByRole("button", { name: "Send the link" }).click();

	// Lowercased before it leaves, so the address the server stores matches the
	// one the person will type at the login screen.
	await expect.poll(() => changeBody).toMatchObject({ newEmail: "moved@example.invalid" });
	// Which inbox to look in is the whole answer here — and for a verified
	// account it is the OLD one, so a stolen session cannot move the account
	// somewhere the owner can't reach.
	await expect(page.getByRole("status")).toContainText("web-qa@example.invalid");
});

function multiWeekPage(weeks: number) {
	return {
		...defaultPage,
		config: {
			...defaultPage.config,
			view: { configVersion: 1, id: "multi-week", weeks },
		},
	};
}

test("keeps multi-week out of the switcher while it is still a concept", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// Reachable by URL and by Page config, but not offered: the view works and
	// its tests run, it is simply not in front of people yet.
	const switcher = page.getByRole("radiogroup", { name: "Calendar view" });
	await expect(switcher.getByRole("radio", { name: "Month" })).toBeVisible();
	await expect(switcher.getByRole("radio", { name: "Weeks" })).toHaveCount(0);

	// The shortcut overlay lists the same set, so it must not advertise it either.
	await page.keyboard.press("?");
	const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(shortcuts).toContainText("Month");
	await expect(shortcuts.getByText("Weeks")).toHaveCount(0);
});

test("lays weeks out as a matrix and pages a screen at a time", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/pages", (route) =>
		respond(route, [multiWeekPage(8)]),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/multi-week?date=2026-07-26`);

	// Eight separate week calendars, not eight rows of one grid — the whole point
	// is comparing weeks side by side.
	const blocks = page.getByRole("region", { name: /^Week of/ });
	await expect(blocks).toHaveCount(8);
	await expect(page.getByText("Jul 20 – Sep 13")).toBeVisible();

	// A matrix: on a wide screen the first blocks share a row.
	const first = (await blocks.nth(0).boundingBox())!;
	const second = (await blocks.nth(1).boundingBox())!;
	expect(second.x).toBeGreaterThan(first.x);
	expect(Math.abs(second.y - first.y)).toBeLessThan(4);

	// A page is a screen, not a week: eight weeks forward lands on the next span.
	await page.keyboard.press("n");
	await expect(page).toHaveURL(/date=2026-09-20/);
	await expect(page.getByText("Sep 14 – Nov 8")).toBeVisible();

	await expectNoAccessibilityViolations(page);
});

test("stacks the matrix into one column when it cannot fit", async ({
	page,
}) => {
	await page.setViewportSize({ height: 720, width: 430 });
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/pages", (route) =>
		respond(route, [multiWeekPage(4)]),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/multi-week?date=2026-07-26`);

	const blocks = page.getByRole("region", { name: /^Week of/ });
	await expect(blocks).toHaveCount(4);
	// Seven day columns need room; on a phone that means one week per row rather
	// than four unreadable slivers.
	const first = (await blocks.nth(0).boundingBox())!;
	const second = (await blocks.nth(1).boundingBox())!;
	expect(second.y).toBeGreaterThan(first.y);
	expect(Math.abs(second.x - first.x)).toBeLessThan(4);
});

test("opens the same event popover from a week block", async ({ page }) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await mockAuthenticatedReads(page);
	await page.route("**/api/v1/pages", (route) =>
		respond(route, [multiWeekPage(4)]),
	);

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/multi-week?date=2026-07-26`);
	await page
		.getByRole("button", { name: /Weekly review/ })
		.first()
		.click();

	// The block is a reader, but the event behind it is the same event — the
	// popover, and everything it can do, comes from the one implementation.
	const popover = page.getByRole("dialog").filter({ hasText: "Weekly review" });
	await expect(
		popover.getByRole("heading", { name: "Weekly review" }),
	).toBeVisible();
	await expect(
		popover.getByRole("button", { exact: true, name: "Edit" }),
	).toBeVisible();
});

test("opens a day-view preview on screen, not over the sidebar", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/day?date=2026-07-23`);

	await page
		.getByRole("button", { name: /Project check-in/ })
		.first()
		.click();
	const preview = page.getByRole("dialog").first();
	await expect(preview).toBeVisible();

	// A day column is as wide as the grid, so there is no room to the right of a
	// block: the preview used to flip left, across the sidebar and off the screen.
	await settleLayout(page);
	const box = (await preview.boundingBox())!;
	const width = page.viewportSize()!.width;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(width);
});

test("event details close on outside clicks without creating another event", async ({ page }) => {
  await mockAuthenticatedReads(page);
  for (const view of ["day", "month"]) {
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/${view}?date=2026-07-23`);
    await page.getByRole("button", { name: /Project check-in/ }).first().click();
    const details = page.getByRole("dialog", { name: "Project check-in", exact: true });
    await expect(details).toBeVisible();
    await details.getByRole("heading", { name: "Project check-in", exact: true }).click();
    await expect(details).toBeVisible();
    const target = view === "day"
      ? page.locator("[data-time-grid-column]").first()
      : page.locator('[data-day-key="2026-07-13"]');
    const bounds = (await target.boundingBox())!;
    const point = { x: bounds.x + 20, y: view === "day" ? page.viewportSize()!.height - 120 : bounds.y + bounds.height - 12 };
    await page.mouse.click(point.x, point.y);
    await expect(details).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Create event", exact: true })).toHaveCount(0);
    const closedBounds = (await target.boundingBox())!;
    await page.mouse.click(closedBounds.x + 20, view === "day" ? page.viewportSize()!.height - 120 : closedBounds.y + closedBounds.height - 12);
    await expect(page.getByRole("dialog", { name: "Create event", exact: true })).toBeVisible();
  }
});

test("stays inside its box with twenty calendars", async ({ page }) => {
	await mockAuthenticatedReads(page, events, manyCalendars);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	/** Nothing may push the page sideways, whatever is open. */
	async function expectNoSidewaysScroll(what: string) {
		const overflow = await page.evaluate(() => ({
			body: document.body.scrollWidth - document.body.clientWidth,
			root:
				document.documentElement.scrollWidth - document.documentElement.clientWidth,
		}));
		expect(overflow, what).toEqual({ body: 0, root: 0 });
	}

	await expect(page.getByRole("grid").first()).toBeVisible();
	await expectNoSidewaysScroll("month grid");

	// Page filters hold every calendar without introducing page-level overflow.
	const { dialog: pageSettings, filters: pageFilters } =
		await openPageFilters(page);
	await expect(pageFilters.getByRole("button")).toHaveCount(
		manyCalendars.length,
	);
	await expectNoSidewaysScroll("Page filters");
	await expectNoAccessibilityViolations(page);
	await pageSettings
		.getByRole("button", { name: "Close page settings" })
		.click();

	// The manage dialog holds the same twenty rows and scrolls its own body.
	await page.getByRole("button", { name: "Calendars" }).click();
	const dialog = page.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();
	const dialogBox = (await dialog.boundingBox())!;
	expect(dialogBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
	await expectNoSidewaysScroll("calendars dialog");
	await settleAnimations(page);
	const calendarAccessibility = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.analyze();
	expect(calendarAccessibility.violations).toEqual([]);
	await page.keyboard.press("Escape");

	// And the composer, which lists every writable calendar.
	await openCreateEvent(page);
	await expect(page.getByRole("dialog", { name: "Create event" })).toBeVisible();
	await expectNoSidewaysScroll("quick create");
});

test("keeps the time on a chip while the cell can hold one", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	const chipState = () =>
		page.evaluate(() => {
			// The first cell with something in it: an empty day has no chip to read,
			// and the month opens on one.
			const cell = [...document.querySelectorAll("[data-day-events]")].find(
				(el) => el.querySelector('[data-event-time]'),
			)!;
			const time = cell.querySelector('[data-event-time]');

			return {
				cell: Math.round(cell.getBoundingClientRect().width),
				// One row per chip. The marks sit at `grid-column: -2`, so a
				// single-column chip pushes them under the title and doubles its height.
				heights: [
					...new Set(
						[...cell.querySelectorAll('[data-event-chip]')].map((el) =>
							Math.round(el.getBoundingClientRect().height),
						),
					),
				],
				timeShown: time ? window.getComputedStyle(time).display !== "none" : false,
			};
		});

	// 1023px is where the sidebar becomes a drawer, so the cells get *wider* than
	// they are on a 1200px desktop. Keyed to the viewport, the time was dropped
	// here (137px cells) and kept there (122px cells).
	for (const width of [1023, 760]) {
		await page.setViewportSize({ height: 900, width });
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-23`);
		await expect(
			page.getByRole("button", { name: /Weekly review/ }).first(),
		).toBeVisible();
		const state = await chipState();
		expect(state.cell).toBeGreaterThan(95);
		expect(state.timeShown).toBe(true);
		expect(state.heights).toHaveLength(1);
	}

	// Narrow enough that a time would leave no title: it goes, and the chip stays
	// one row tall.
	for (const width of [600, 390]) {
		await page.setViewportSize({ height: 844, width });
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-23`);
		await expect(
			page.getByRole("button", { name: /Weekly review/ }).first(),
		).toBeVisible();
		const state = await chipState();
		expect(state.cell).toBeLessThan(95);
		expect(state.timeShown).toBe(false);
		expect(state.heights).toHaveLength(1);
	}
});

test("finds events and actions without filtering the calendar", async ({
	page,
}) => {
	await mockAuthenticatedReads(page);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-23`);
	const clientCall = page.getByRole("button", { name: /Client call/ });
	await expect(clientCall).toBeVisible();

	await page.getByRole("button", { name: "Search events and actions" }).click();
	const search = page.getByRole("dialog", { name: "Search Musubi" });
	await expect(
		search.getByRole("button", { name: "Go to today" }),
	).toBeVisible();
	await expectNoAccessibilityViolations(page);
	await search.getByRole("searchbox").fill("review");
	const reviewResult = search
		.getByRole("button", { name: /Weekly review/ })
		.first();
	await expect(reviewResult).toBeVisible();
	await reviewResult.click();

	// Selecting a result follows the same path as clicking its calendar block: it
	// moves to the date and opens the lightweight event preview, not the editor.
	await expect(
		page.getByRole("dialog", { name: "Weekly review" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(clientCall).toBeVisible();
});

test("draws the plus on the narrow create button", async ({ page }) => {
	await mockAuthenticatedReads(page);
	await page.setViewportSize({ height: 844, width: 390 });
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);

	// Measured, not looked at: the rule that hides the word on a phone used to
	// match the primitive's content wrapper — the button's only direct span — and
	// took the icon with it, leaving a plain dark circle with nothing in it.
	const create = page.getByRole("button", {
		exact: true,
		name: "Create event, meeting or task",
	});
	const plus = create.locator("svg");
	await expect(plus).toBeVisible();
	const box = (await plus.boundingBox())!;
	expect(box.width).toBeGreaterThan(10);
	expect(box.height).toBeGreaterThan(10);
	await expect(create).toHaveText("");
});

test("puts an unknown view back in the address bar", async ({ page }) => {
	await mockAuthenticatedReads(page);
	// An unknown view renders the month and must be canonicalized in the URL.
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/unknown?date=2026-07-23`);
	await expect(page.getByRole("radio", { name: "Month" })).toBeChecked();
	await expect(page).toHaveURL(/\/month\?date=2026-07-23$/);
});

for (const width of [1280, 768]) test(`keeps the sidebar's Pages label and management usable with many Pages (${width})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockAuthenticatedReads(page);
  const pages = [defaultPage, ...Array.from({ length: 20 }, (_, index) => ({
    ...defaultPage, id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    name: `Project ${index + 1}`, isDefault: false, position: index + 1,
  }))];
  await page.route("**/api/v1/pages", route => respond(route, pages));
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-23`);
  if (width === 768) await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
  const label = sidebar.getByRole("heading", { name: "Pages" });
  await expect(label).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "My calendar", exact: true })).toBeInViewport({ ratio: 1 });
  // Preserve the original label/list spacing contract as well as the new scroll contract.
  const gap = await sidebar.evaluate(element => {
    const heading = element.querySelector("#pages-label")!;
    const list = element.querySelector('[data-page-list]')!;
    return list.getBoundingClientRect().top - heading.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(8);
  const management = sidebar.getByRole("navigation", { name: "Manage Musubi" });
  const before = await management.boundingBox();
  for (const name of ["Calendars", "Connections", "Settings"]) {
    const button = management.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: testInfo.outputPath(`sidebar-${width}-initial.png`), animations: "disabled" });
  await sidebar.getByRole("button", { name: "My calendar", exact: true }).focus();
  const last = sidebar.getByRole("button", { name: "Project 20", exact: true });
  // Keyboard navigation must reveal off-screen Pages without moving management.
  for (let index = 0; index < pages.length * 3; index++) {
    if (await last.evaluate(element => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });
  expect(await sidebar.locator('[data-sidebar-scroll]').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await management.boundingBox()).toEqual(before);
  for (const name of ["Calendars", "Connections", "Settings"]) {
    await expect(management.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await page.screenshot({ path: testInfo.outputPath(`sidebar-${width}-keyboard.png`), animations: "disabled" });
});

test("walks a new account through onboarding once", async ({ page }) => {
	await mockAuthenticatedReads(page);

	// Overrides after the shared mock, so these win: an account that has never
	// finished setting up.
	let revision = 1;
	let state = { ...settings, onboarded: false };
	let patched: unknown;
	let renamed: unknown;
	let named: unknown;
	await page.route("**/api/v1/server", (route) =>
		respond(route, { syncProviders: ["google"] }),
	);
	await page.route("**/api/auth/update-user", (route) => {
		named = route.request().postDataJSON();
		return respond(route, { status: true });
	});
	await page.route("**/api/v1/users/settings", (route) => respond(route, state));
	await page.route("**/api/v1/users/settings/document", (route) =>
		respond(route, {
			revision,
			updatedAt: "2026-07-26T14:00:00.000Z",
			value: state,
		}),
	);
	await page.route("**/api/v1/users/me/settings", (route) => {
		patched = route.request().postDataJSON();
		revision += 1;
		state = { ...state, onboarded: true };
		return respond(route, {
			revision,
			updatedAt: "2026-07-26T14:01:00.000Z",
			value: state,
		});
	});
	await page.route("**/api/v1/calendars", async (route) => {
		if (route.request().method() !== "PUT") return route.fallback();
		renamed = route.request().postDataJSON();
		return respond(route, renamed);
	});

	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
	await expect(
		page.getByRole("heading", { level: 1, name: "Welcome to Musubi" }),
	).toBeVisible();
	// The step marks are dots; the sentence they replaced lives on their label.
	await expect(page.getByRole("img", { name: "Step 1 of 3" })).toBeVisible();

	await page.getByLabel("Your name").fill("Zoe Novák");
	await page.getByRole("button", { exact: true, name: "Continue" }).click();

	// Step two renames the calendar the server already made — it never creates one.
	await expect(
		page.getByRole("heading", { level: 1, name: "Your calendar" }),
	).toBeVisible();
	await page.getByLabel("Calendar name").fill("Home");
	await page.getByRole("button", { exact: true, name: "Continue" }).click();

	await expect(
		page.getByRole("heading", { level: 1, name: "Bring your calendars" }),
	).toBeVisible();
	// Offered because this server advertises it, not because it was hard-coded.
	await expect(
		page.getByRole("button", { name: /Connect Google Calendar/ }),
	).toBeVisible();
	await page.getByRole("button", { name: "Skip for now" }).click();

	// Through to the calendar, and the flag is set so it never asks again.
	await expect(page.getByRole("grid").first()).toBeVisible();
	expect(named).toMatchObject({ name: "Zoe Novák" });
	expect(renamed).toMatchObject({ name: "Home" });
	expect(patched).toMatchObject({
		baseRevision: 1,
		patch: { onboarded: true },
	});

	await page.reload();
	await expect(page.getByRole("grid").first()).toBeVisible();
	await expect(page.getByRole("img", { name: "Step 1 of 3" })).toHaveCount(0);
});

test("scrolls the calendar list inside the editor layer, not the layer", async ({
	page,
}) => {
	await page.setViewportSize({ height: 962, width: 1890 });
	await mockAuthenticatedReads(page);
	// More calendars than the column has room for: the point of the test is what
	// gives way when they do not fit.
	await page.route("**/api/v1/calendars", (route) =>
		route.request().method() === "GET"
			? respond(
					route,
					Array.from({ length: 16 }, (_, index) => ({
						color: "#b3492f",
						creatorID: "user-web-qa",
						id: index === 0 ? "personal" : `extra-${index}`,
						isDefault: index === 0,
						members: [],
						name: `Calendar ${index + 1}`,
						role: "owner" as const,
					})),
				)
			: route.fallback(),
	);
	await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-08-07`);
	await openCreateEvent(page);
	await page.getByRole("button", { name: "Expand event editor" }).click();

	const dialog = page.getByRole("dialog", { name: "Create event", exact: true });
	const body = dialog.locator("header + div");
	const form = dialog.locator('form[data-layout="page"]');
	const placement = form.locator('[data-ui="calendar-placement"]');
	const overflow = (locator: typeof body) =>
		locator.evaluate((element) => element.scrollHeight - element.clientHeight);

	const [bodyBox, formBox] = await Promise.all([
		body.boundingBox(),
		form.boundingBox(),
	]);
	// The form takes the body's height rather than its content's. Without that the
	// row holding the calendars grows to fit all of them, and the form leaves the
	// bottom of the layer.
	expect(formBox!.height).toBeLessThanOrEqual(bodyBox!.height + 1);
	expect(await overflow(body)).toBe(0);
	expect(await overflow(placement)).toBeGreaterThan(0);

	// The column heading stays put while the calendar list scrolls.
	const heading = form.getByRole("heading", { name: "Calendars", exact: true });
	await dialog.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
	const before = (await heading.boundingBox())!;
	await placement.evaluate(element => { element.scrollTop = element.scrollHeight; });
	expect((await heading.boundingBox())!.y).toBeCloseTo(before.y, 0);
	await expect(placement.getByText("Calendar 16")).toBeInViewport();
});

for (const { provider, width, theme } of [
	{ provider: "google", width: 1280, theme: "light" },
	{ provider: "microsoft", width: 390, theme: "dark" },
] as const) {
	test(`provider connection includes Tasks: ${provider}, ${theme}, ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 850 });
		await setTestTheme(page, theme);
		await mockAuthenticatedReads(page);
		await page.route("**/api/v1/server", (route) =>
			respond(route, { syncProviders: ["google", "microsoft"] }),
		);
		const requests: {
			provider: string;
			scopes: string[];
			callbackURL: string;
		}[] = [];
		await page.route("**/api/auth/link-social", (route) => {
			requests.push(route.request().postDataJSON());
			return respond(route, { redirect: false, url: "" });
		});
		await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
		if (width < 600)
			await page.getByRole("button", { name: "Open navigation" }).click();
		await page.getByRole("button", { name: "Connections" }).click();
		const dialog = page.getByRole("dialog", { name: "Settings" });
		await expect(dialog.getByRole("checkbox", { name: "Include Tasks" })).toHaveCount(0);
		const connect = dialog.getByRole("button", {
			name: provider === "google" ? "Google Calendar" : "Outlook",
		});
		const taskScope =
			provider === "google"
				? "https://www.googleapis.com/auth/tasks"
				: "Tasks.ReadWrite";
		await connect.click();
		await expect.poll(() => requests.length).toBe(1);
		expect(requests[0].scopes).toContain(taskScope);
		expect(requests[0]).toMatchObject({ provider, callbackURL: page.url() });
		expect(requests[0].scopes).toContain(
			provider === "google"
				? "https://www.googleapis.com/auth/calendar.events"
				: "Calendars.ReadWrite",
		);
		const accessibility = await new AxeBuilder({ page })
			.include('[role="dialog"]')
			.analyze();
		expect(accessibility.violations).toEqual([]);
		expect(
			await dialog.evaluate(
				(element) => element.scrollWidth <= element.clientWidth,
			),
		).toBe(true);
		await dialog.getByRole("button", { name: "Close settings" }).click();
		await expect(dialog).toHaveCount(0);
	});
}

for (const [width, end] of [
	[1280, "2026-07-09T01:00:00+02:00"],
	[390, "2026-07-11T10:00:00+02:00"],
] as const) {
	test(`K05 timed title-only submission preserves independent end at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 844 });
		const item = event(
			"night",
			"Night shift",
			"personal",
			"#b3492f",
			"2026-07-08T23:00:00+02:00",
			end,
		);
		await mockAuthenticatedReads(page, { ...events, events: [item] });
		await page.goto(
			`/app/p/${DEFAULT_PAGE_ID}/month/event/night?date=2026-07-08`,
		);
		const title = page.getByRole("textbox", { name: "Event title" });
		await expect(title).toBeFocused();
		await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText(
			width === 390 ? "July 11" : "July 9",
		);
		await title.fill("Night renamed");
		const write = page.waitForRequest(
			(request) =>
				request.method() === "PATCH" && request.url().endsWith("/api/v1/events"),
		);
		await title.press("Control+Enter");
		const body = (await write).postDataJSON();
		expect(body).toEqual({
			id: item.id,
			expectedRevision: 1,
			patch: { title: "Night renamed" },
		});
		await expect(title).toHaveCount(0);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
		).toBe(false);
	});
}

for (const editor of ["full", "handoff"] as const) {
	test(`K06 two real ${editor} drafts keep original revision across SSE and reject stale title without restoring time`, async ({
		browser,
	}) => {
		const context = await browser.newContext({ timezoneId: "Europe/Prague" });
		const item = event(
			"k06-night",
			"K06 night",
			"personal",
			"#b3492f",
			"2026-07-08T23:00:00+02:00",
			"2026-07-10T02:00:00+02:00",
		);
		await mockAuthenticatedReads(context, { ...events, events: [item] });
		const first = await context.newPage();
		const second = await context.newPage();
		let changed = false;
		let readsAfterChange = 0;
		await second.route("**/api/stream?clientVersion=*", async (route) => {
			expect(
				new URL(route.request().url()).searchParams.get("clientVersion"),
			).toBe(PRODUCT_VERSION);
			while (!changed) await new Promise((resolve) => setTimeout(resolve, 20));
			await route.fulfill({
				contentType: "text/event-stream",
				body: 'data: {"type":"event_updated","payload":{}}\n\n',
			});
		});
		await second.route(/\/api\/v1\/events(?:\?.*)?$/, async (route) => {
			if (route.request().method() === "GET" && changed) readsAfterChange++;
			return route.fallback();
		});
		const path = `/app/p/${DEFAULT_PAGE_ID}/month/event/k06-night?date=2026-07-08`;
		await first.goto(path);
		if (editor === "full") await second.goto(path);
		else {
			await second.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-08`);
			await second
				.getByRole("button", { name: /K06 night/ })
				.first()
				.click();
			await second.getByRole("button", { name: "Edit", exact: true }).click();
		}
		const secondTitle = second.getByRole("textbox", { name: "Event title" });
		await secondTitle.fill("K06 retained title");
		const write = first.waitForResponse(
			(response) =>
				response.request().method() === "PATCH" &&
				response.url().endsWith("/api/v1/events"),
		);
		await first.getByRole("combobox", { name: "Start time" }).fill("22:00");
		await first.getByRole("combobox", { name: "Start time" }).press("Tab");
		await first.getByRole("button", { name: "Save", exact: true }).click();
		const firstResponse = await write;
		expect(firstResponse.status()).toBe(200);
		const authoritative = await firstResponse.json();
		expect(authoritative.revision).toBe(2);
		expect(authoritative.start).not.toBe(item.start);
		changed = true;
		await expect.poll(() => readsAfterChange).toBeGreaterThan(0);
		await expect(secondTitle).toHaveValue("K06 retained title");
		if (editor === "handoff")
			await second.getByRole("button", { name: "Expand event editor" }).click();
		const stale = second.waitForResponse(
			(response) =>
				response.request().method() === "PATCH" &&
				response.url().endsWith("/api/v1/events"),
		);
		await second.getByRole("button", { name: "Save", exact: true }).click();
		const response = await stale;
		expect(response.request().postDataJSON()).toEqual({
			id: item.id,
			expectedRevision: 1,
			patch: { title: "K06 retained title" },
		});
		expect(response.status()).toBe(409);
		expect((await response.json()).current.start).toBe(authoritative.start);
		await expect(secondTitle).toHaveValue("K06 retained title");
		await expect(second.getByRole("alert")).toContainText(
			"Refresh and reconcile",
		);
		expect(second.url()).not.toContain("expectedRevision");
		await context.close();
	});
}

for (const code of ["provider-conflict", "committed-fallback", "401", "426", "network"] as const) {
	test(`K06 actual full editor retains multiday draft after ${code}`, async ({
		page,
	}) => {
		const item = event(
			"k06-delivery",
			"Delivery draft",
			"personal",
			"#b3492f",
			"2026-07-08T23:00:00+02:00",
			"2026-07-10T02:00:00+02:00",
		);
		await mockAuthenticatedReads(page, { ...events, events: [item] });
		const requests: unknown[] = [];
		await page.route("**/api/v1/events", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			requests.push(route.request().postDataJSON());
			if (code === "network") return route.abort("failed");
			return respond(
				route,
				(code === "provider-conflict" || code === "committed-fallback")
					? {
							error:
								"Saved locally, but remote delivery was not confirmed. Your draft was kept. Refresh and reconcile before any retry.",
							code: code === "committed-fallback" ? "event-delivery-unconfirmed" : code,
							localCommitted: true,
							...(code === "committed-fallback"
                ? { committed: [{ ...item, title: "Keep delivery draft", revision: 2 }] }
                : { current: { ...item, title: "Keep delivery draft", revision: 2 }, currentRevision: 2 }),
							delivery: code === "committed-fallback"
                ? { completed: false, status: "unconfirmed" }
                : { completed: true, status: "conflict" },
						}
					: { error: code === "401" ? "Sign in required" : "ClientUpgradeRequired" },
				code === "provider-conflict" ? 409 : code === "committed-fallback" ? 502 : Number(code),
			);
		});
		await page.goto(
			`/app/p/${DEFAULT_PAGE_ID}/month/event/k06-delivery?date=2026-07-08`,
		);
		const title = page.getByRole("textbox", { name: "Event title" });
		await title.fill("Keep delivery draft");
		await title.press("Control+Enter");
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(title).toHaveValue("Keep delivery draft");
		expect(requests).toEqual([
			{
				id: item.id,
				expectedRevision: 1,
				patch: { title: "Keep delivery draft" },
			},
		]);
		if (code === "provider-conflict" || code === "committed-fallback") {
			await expect(page.getByRole("alert")).toContainText("Saved locally");
			await title.press("Control+Enter");
			await expect.poll(() => requests.length).toBe(2);
			expect(requests[1]).toEqual(requests[0]);
		}
	});
}

for (const override of ["description=Restored", "endTime=12%3A30", "recurrence=FREQ%3DDAILY", 'calendarIds=%5B%22personal%22%5D']) {
  test(`K06 URL-only ${override} cannot borrow freshly read revision`, async ({ page }) => {
    const item = event("url-only", "Original", "personal", "#b3492f", "2026-07-08T09:00:00+02:00", "2026-07-08T10:00:00+02:00");
    await mockAuthenticatedReads(page, { ...events, events: [item] });
    const writes: unknown[] = [];
    await page.route("**/api/v1/events", (route) => {
      if (route.request().method() === "PATCH") writes.push(route.request().postDataJSON());
      return route.fallback();
    });
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month/event/url-only?date=2026-07-08&${override}`);
    const title = page.getByRole("textbox", { name: "Event title" });
    await title.fill("Retained restored draft");
    await title.press("Control+Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(title).toHaveValue("Retained restored draft");
    expect(writes).toEqual([]);
    await page.reload();
    await title.fill("Still not authorized after reload");
    await title.press("Control+Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(writes).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K09 delivery review and retained deletion after reload: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const id = "00000000-0000-4000-8000-000000000091";
    const operation = "00000000-0000-4000-8000-000000000092";
    const remoteCalendar = "00000000-0000-4000-8000-000000000093";
    const targetId = "00000000-0000-4000-8000-000000000094";
    const saved = event(id, "Delivery appointment", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const writes: unknown[] = [];
    let resolved = false;
    const target = { targetId, calendarId: remoteCalendar, calendarName: "Work", provider: "google", connected: true, owned: true,
      operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1,
      updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    await page.route(`**/api/v1/events/${id}/delivery`, (route) => respond(route, {
      eventId: id, localRevision: 1, targets: [{ ...target, ...(resolved ? { status: "pending", issue: null } : {}) }],
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, (route) => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1, masterRevision: 7,
      local: { ...saved, description: null, location: null, isCanceled: true, originalStart: { kind: "instant", value: "2026-07-23T07:30:00.000Z" }, timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-23T09:30:00.000", endLocal: "2026-07-23T10:30:00.000" } }, remote: { ...saved, title: "Changed at provider", description: "Remote notes", location: null },
      remoteEtag: '"fresh"', action: "update", canResolve: true, reason: null,
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, (route) => {
      writes.push(route.request().postDataJSON()); resolved = true;
      return respond(route, { eventId: id, localRevision: 1, targets: [{ ...target, status: "pending", issue: null }] }, 202);
    });
    const deleted = "00000000-0000-4000-8000-000000000095";
    await page.route("**/api/v1/event-deliveries", (route) => respond(route, { items: [{ eventId: deleted, savedTitle: "Deleted appointment" }], nextCursor: null }));
    await page.route(`**/api/v1/events/${deleted}/delivery`, (route) => respond(route, { eventId: deleted, localRevision: null,
      targets: [{ ...target, action: "delete", status: "unconfirmed", issue: "unconfirmed" }] }));
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    const eventTrigger = page.getByRole("button", { name: /Delivery appointment/ }).first();
    await eventTrigger.click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await expect(delivery.getByText(/Remote changes need review/)).toBeVisible();
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("Changed at provider")).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await expect(comparison.getByText("Remote notes")).toBeVisible();
    await expect(comparison.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(comparison.getByText(/Europe\/Prague ·/)).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await comparison.screenshot({ path: `/tmp/musubi-k09-web-${theme}-comparison.png` });
    await comparison.getByRole("button", { name: "Apply saved changes" }).click();
    await expect(delivery.getByText(/Saved changes queued/)).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ expectedLocalRevision: 1, expectedMasterRevision: 7, expectedRemoteExists: true, expectedRemoteEtag: '"fresh"' });
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    await expect(eventTrigger).toBeFocused();
    await page.reload();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("button", { name: /Deleted appointment/ }).click();
    await expect(delivery.getByText(/Delivery unconfirmed/)).toBeVisible();
    await expect(delivery.getByText("Retained delivery records")).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await delivery.screenshot({ path: `/tmp/musubi-k09-web-${theme}-retained.png` });
    expect(await delivery.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  });
}

test("retries a failed calendar read without a route crash", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await mockAuthenticatedReads(page);
  let unavailable = true;
  await page.route("**/api/v1/events**", (route) => {
    if (route.request().method() !== "GET" || !unavailable) return route.fallback();
    return respond(route, { message: "Calendar temporarily unavailable" }, 503);
  });
  await page.goto("/app/p/my-calendar/month?date=2026-07-26");
  await expect(page.getByRole("heading", { name: "We could not open this calendar." })).toBeVisible();
  await expectNoAccessibilityViolations(page);
  await page.screenshot({ path: testInfo.outputPath("calendar-error.png"), fullPage: true });
  unavailable = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Weekly review/ })).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("calendar-recovered.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("restores an event reminder's inherited setting from its menu", async ({ page }, testInfo) => {
  await mockAuthenticatedReads(page);
  const document = {
    default: { minutesBefore: 10, allDay: null },
    calendars: {},
    events: { "project-check-in": { minutesBefore: 30, allDay: null } } as Record<string, { minutesBefore: number; allDay: null }>,
  };
  await page.route("**/api/v1/reminders", (route) => respond(route, document));
  const writes: Array<{ method: string; body: unknown }> = [];
  await page.route("**/api/v1/reminders/events/project-check-in", (route) => {
    writes.push({ method: route.request().method(), body: route.request().postDataJSON() });
    delete document.events["project-check-in"];
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/app/p/my-calendar/month?date=2026-07-26");
  await page.getByRole("button", { name: /Project check-in/ }).click();
  const dialog = page.getByRole("dialog", { name: "Project check-in" });
  await dialog.getByRole("button", { name: "30 min", exact: true }).click();
  await page.getByRole("menuitem", { name: "Use inherited setting" }).click();
  await expect(dialog.getByRole("button", { name: "10 min", exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="toast-region"]')).toContainText("Reminder follows its inherited setting again.");
  expect(writes).toEqual([{ method: "PUT", body: { rule: null } }]);
  await expectNoAccessibilityViolations(page);
  await page.screenshot({ path: testInfo.outputPath("inherited-reminder.png"), fullPage: true });
});


test("recovers from unsupported known time metadata after refresh", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const known = event("00000000-0000-4000-8000-000000000149", "Known zoned series", "personal", "red", "2026-07-25T07:00:00Z", "2026-07-25T08:00:00Z", {
    recurrence: "FREQ=DAILY;COUNT=2",
    timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-25T09:00:00.000", endLocal: "2026-07-25T10:00:00.000" },
    seriesID: null, originalStart: null,
  });
  await mockAuthenticatedReads(page, { ...events, events: [known] });
  let unsupported = true;
  await page.route("**/api/v1/events**", route => {
    if (route.request().method() !== "GET" || !unsupported || new URL(route.request().url()).pathname !== "/api/v1/events") return route.fallback();
    return respond(route, { ...events, events: [{ ...known, recurrence: "FREQ=HOURLY;COUNT=2" }] });
  });
  await page.goto("/app/p/my-calendar/month?date=2026-07-26");
  await expect(page.getByRole("heading", { name: "We could not open this calendar." })).toBeVisible();
  await expect(page.getByText(/FREQ=HOURLY/)).toHaveCount(0);
  await expectNoAccessibilityViolations(page);
  await page.screenshot({ path: testInfo.outputPath("known-time-error.png"), fullPage: true });
  unsupported = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: /Known zoned series/ })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("known-time-recovered.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
});


for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
 test(`saves known civil time and title atomically from the editor: ${theme} ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await setTestTheme(page, theme);
  const known = event("00000000-0000-4000-8000-000000000151", "Gap appointment", "personal", "red", "2026-03-29T01:30:17.123Z", "2026-03-29T02:30:19.456Z", {
    timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T02:30:17.123", endLocal: "2026-03-29T04:30:19.456" },
  });
  await mockAuthenticatedReads(page, { ...events, events: [known] });
  const writes: unknown[] = [];
  let enabled = false;
  await page.route(`**/api/v1/events/${known.id}/time`, route => {
    const body = route.request().postDataJSON();
    writes.push({ method: route.request().method(), body });
    if (!enabled) return respond(route, { error: "Explicit time editing is not enabled on this server. No changes were saved." }, 403);
    return respond(route, { ...known, title: body.patch.title, revision: 2, start: "2026-03-29T01:00:00.000Z", end: "2026-03-29T03:00:00.000Z", timeModel: body.time });
  });
  await page.goto("/app/p/my-calendar/month?date=2026-03-29");
  await page.getByRole("button", { name: /Gap appointment/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Start time", { exact: true })).toHaveValue("02:30");
  await expect(page.getByLabel("When", { exact: true }).getByText("Europe/Prague", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Event title" }).fill("Saved civil draft");
  // The existing control carries the displayed duration when moving the start.
  await page.getByLabel("Start time", { exact: true }).fill("03:00");
  await page.getByLabel("Start time", { exact: true }).press("Enter");
  await expectNoAccessibilityViolations(page);
  await page.screenshot({ path: testInfo.outputPath("known-time-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("Saved civil draft");
  await expect(page.getByLabel("Start time", { exact: true })).toHaveValue("03:00");
  enabled = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Event updated.");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toMatchObject({ method: "PUT", body: { expectedRevision: 1, patch: { title: "Saved civil draft" }, time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T03:00:00.000" } } });
});

}

for (const [width, theme, target] of [[1280, "light", "zoned"], [390, "dark", "all-day"]] as const) {
  test(`explicit time model selection: ${target} ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const source = event("00000000-0000-4000-8000-000000000152", "Choose time model", "personal", "red", "2026-07-25T07:30:17.123Z", "2026-07-25T08:30:19.456Z", target === "all-day" ? {
      timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-25T09:30:17.123", endLocal: "2026-07-25T10:30:19.456" },
    } : {});
    await mockAuthenticatedReads(page, { ...events, events: [source] });
    const writes: unknown[] = [];
    await page.route(`**/api/v1/events/${source.id}/time`, route => {
      const body = route.request().postDataJSON();
      writes.push({ method: route.request().method(), body });
      return respond(route, { ...source, title: body.patch.title, revision: 2,
        start: target === "zoned" ? "2026-07-25T13:30:17.123Z" : "2026-07-25T00:00:00Z",
        end: target === "zoned" ? "2026-07-25T14:30:19.456Z" : "2026-07-25T00:00:00Z",
        isAllDay: target === "all-day", timeModel: target === "zoned" ? body.time : { kind: "all-day" },
      });
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Choose time model/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Event title" }).fill("Explicit complete draft");
    await page.getByRole("button", { name: "Expand event editor", exact: true }).click();
    const timeHelp = page.getByRole("button", { name: "Help for Time model", exact: true });
    await expect(page.getByText("The selected model interprets", { exact: false })).toHaveCount(0);
    await timeHelp.click();
    await expect(page.getByRole("tooltip")).toContainText("Changing it may change when the event occurs.");
    await timeHelp.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.getByRole("combobox", { name: "Time model", exact: true }).click();
    await page.getByRole("option", { name: target === "zoned" ? "Event time zone" : "All-day dates", exact: true }).click();
    if (target === "all-day") {
      await expect(page.getByRole("button", { name: /^Ends:/ })).toContainText("July 26, 2026");
      await page.getByRole("button", { name: "Help for end date", exact: true }).click();
      await expect(page.getByRole("tooltip")).toContainText("The end date is not included.");
      await page.keyboard.press("Escape");
    }
    if (target === "zoned") {
      await expect(page.getByRole("combobox", { name: "Event time zone", exact: true })).toHaveAttribute("value", "");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Enter a valid event time zone");
      expect(writes).toEqual([]);
      await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("Explicit complete draft");
      await chooseTimeZone(page.getByRole("combobox", { name: "Event time zone", exact: true }), "America/New_York");
    }
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath("explicit-time-model.png"), fullPage: true });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ method: "PUT", body: { expectedRevision: 1, patch: { title: "Explicit complete draft" }, time: target === "zoned" ? {
      kind: "zoned", timeZone: "America/New_York", startLocal: "2026-07-25T09:30:17.123", endLocal: "2026-07-25T10:30:19.456",
    } : { kind: "all-day", startDate: "2026-07-25", endDate: "2026-07-25" } } });
  });
}

for (const [width, theme, full] of [[390, "dark", false], [1280, "light", true]] as const) {
  test(`whole-series civil date shift ${theme} ${width} full=${full}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const known = event("00000000-0000-4000-8000-000000000154", "Civil series", "personal", "red", "2026-03-28T08:30:17.123Z", "2026-03-28T09:30:19.456Z", {
      recurrence: "FREQ=DAILY;COUNT=4",
      timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-28T09:30:17.123", endLocal: "2026-03-28T10:30:19.456" },
    });
    await mockAuthenticatedReads(page, { ...events, events: [known] });
    const writes: unknown[] = [];
    let enabled = full;
    await page.route(`**/api/v1/events/${known.id}/${full ? "time" : "scope"}`, route => {
      const body = route.request().postDataJSON();
      writes.push({ method: route.request().method(), body });
      if (!enabled) return respond(route, { error: "Explicit time editing is not enabled on this server. No changes were saved.", reason: "unsupported", capability: "event-write" }, 403);
      if (!full) return respond(route, { operationID: body.operationID, changed: true, events: [{ id: known.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false });
      return respond(route, { ...known, title: body.patch.title, revision: 2, start: "2026-03-29T07:30:17.123Z", end: "2026-03-29T08:30:19.456Z", timeModel: body.time });
    });
    await page.goto("/app/p/my-calendar/month?date=2026-03-29");
    await page.locator('[data-day-key="2026-03-29"]').getByRole("button", { name: /Civil series/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Event title" }).fill("Moved civil series");
    await page.getByRole("button", { name: /^Date:/ }).click();
    await page.getByRole("dialog", { name: "Choose date" }).getByRole("gridcell", { name: "Monday, March 30, 2026" }).click();
    if (full) {
      await page.getByRole("button", { name: "Expand event editor", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Date:/ })).toContainText("March 29, 2026");
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    if (!full) {
      await page.getByRole("button", { name: "This event", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Explicit time editing is not enabled");
      expect(writes).toHaveLength(1);
      await page.getByRole("button", { name: "All events", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Explicit time editing is not enabled");
      expect(writes).toHaveLength(2);
      await expectNoAccessibilityViolations(page);
      await page.screenshot({ path: testInfo.outputPath("series-time-retry.png"), fullPage: true });
      enabled = true;
      await page.getByRole("button", { name: "All events", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Recurring event updated.");
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
      expect(writes).toHaveLength(3);
      expect(writes[2]).toEqual(writes[1]);
    } else {
      await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
      expect(writes).toHaveLength(1);
      await expectNoAccessibilityViolations(page);
      await page.screenshot({ path: testInfo.outputPath("series-time-full-saved.png"), fullPage: true });
    }
    expect(writes[full ? 0 : 1]).toMatchObject({ method: full ? "PUT" : "POST", body: { expectedRevision: 1, patch: { title: "Moved civil series" }, time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-29T09:30:17.123", endLocal: "2026-03-29T10:30:19.456" } } });
  });
}

for (const [width, theme] of [[390, "dark"], [1280, "light"]] as const) {
  test(`explicit time creation retains draft on refusal ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000155";
    await mockAuthenticatedReads(page, { ...events, events: [] }, [{ ...calendars[0]!, id: calendarID }]);
    const writes: any[] = [];
    let enabled = false;
    await page.route("**/api/v1/events/time", route => {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (!enabled) return respond(route, { error: "Explicit time creation is not enabled on this server. No changes were saved.", capability: "event-write", reason: "unsupported" }, 403);
      return respond(route, { ...body.event, revision: 1, start: "2026-07-30T07:30:00Z", end: "2026-07-30T08:30:00Z", isAllDay: false, timeModel: body.time }, 201);
    });
    await page.goto("/app/p/my-calendar/week?date=2026-07-30");
    await openCreateEvent(page);
    await page.getByRole("textbox", { name: "Event title" }).fill("New civil event");
    await page.getByRole("button", { name: "Expand event editor" }).click();
    await page.getByRole("combobox", { name: "Time model", exact: true }).click();
    await page.getByRole("option", { name: "Event time zone", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Event time zone", exact: true })).toHaveAttribute("value", "Europe/Prague");
    expect(writes).toHaveLength(0);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Explicit time creation is not enabled");
    await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("New civil event");
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath("create-time-retry.png"), fullPage: true });
    enabled = true;
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(writes[1].event).toMatchObject({ title: "New civil event", calendars: [calendarID] });
    expect(writes[1].time).toMatchObject({ kind: "zoned", timeZone: "Europe/Prague" });
    expect(writes[1].event.timeModel).toBeUndefined();
    expect(writes[1].event.start).toBeUndefined();
  });
}

test("explains bounded Outlook coverage without a permanent banner", async ({ page }, testInfo) => {
  await mockAuthenticatedReads(page, { ...events, events: [] }, calendars.map(calendar => calendar.id === "studio" ? { ...calendar, provider: "microsoft" } : calendar));
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2035-07-26`);
  const trigger = page.getByRole("button", { name: "Calendar sync coverage", exact: true });
  const calendar = page.locator("[data-calendar-area]");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await calendar.boundingBox();
    await expect(trigger).toBeInViewport();
    await expect(page.getByRole("status").filter({ hasText: "Outlook sync covers" })).toHaveCount(0);
    await trigger.click();
    const details = page.getByRole("dialog", { name: "Calendar sync coverage", exact: true });
    await expect(details).toContainText("Outlook sync covers a limited date range");
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath(`coverage-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await calendar.boundingBox()).toEqual(geometry);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await setCalendarVisibility(page, "Studio", false);
  await expect(trigger).toHaveCount(0);
});

for (const [width, theme] of [[390, "dark"], [1280, "light"]] as const) {
  test(`provider details remain separate ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const imported = event("00000000-0000-4000-8000-000000000166", "Provider meeting", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z", { recurrence: "FREQ=DAILY;COUNT=2" });
    await mockAuthenticatedReads(page, { ...events, events: [imported] }, [{ ...calendars[0]!, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [{ name: "Alex Chen", address: "alex@example.test", self: false, role: "required", response: "accepted" }, { name: "Sam Lee", address: "sam@example.test", self: false, role: "optional", response: "tentative" }], attendeesComplete: false, ownResponse: "notResponded", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "workingElsewhere", privacy: "confidential", status: null, eventType: "singleInstance", conferenceURLs: [] } }));
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Provider meeting/ }).first().click();
    await page.locator("summary").filter({ hasText: "Outlook details" }).click();
    await expect(page.getByText(/These settings describe the series/)).toHaveCount(0);
    await page.getByRole("button", { name: "About Outlook settings" }).click();
    const help = page.getByRole("tooltip");
    await expect(help).toContainText("These settings describe the series");
    await expect(help).toContainText("Both apps may notify");
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(page.getByText("Working elsewhere", { exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Outlook participants" }).click();
    await expect(page.getByRole("list", { name: "Outlook participants" })).toBeVisible();
    await expect(page.getByText("Alex Chen", { exact: true })).toBeVisible();
    await expect(page.getByText("Participant list may be incomplete.", { exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath("provider-details.png"), fullPage: true });
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K14 personal reminder conflict confirmation: ${theme} ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const id = "00000000-0000-4000-8000-000000000141";
    const operation = "00000000-0000-4000-8000-000000000142";
    const saved = event(id, "Reminder appointment", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const writes: Record<string, unknown>[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000144", calendarId: "00000000-0000-4000-8000-000000000143", calendarName: "Google", provider: "google", connected: true, owned: true,
      operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    const receipt = { eventId: id, localRevision: 1, targets: [target] };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1,
      local: { ...saved, description: null, location: null }, remote: { ...saved, description: null, location: null },
      remoteEtag: '"fresh"', action: "update", canResolve: true, reason: null,
      reminderResolution: { desired: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] }, remote: { provider: "google", useDefault: true, overrides: [] }, stateVersion: "a".repeat(64) },
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON());
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, receipt, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/);
    await page.getByRole("button", { name: /Reminder appointment/ }).first().click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("popup · 15 minutes before start")).toBeVisible();
    await expect(comparison.getByText("Calendar defaults")).toBeVisible();
    await expect(comparison.getByText(/Musubi reminders stay unchanged/)).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await expect(comparison.getByText("Current Google reminders")).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    expect(await comparison.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await comparison.screenshot({ path: `/tmp/musubi-k14-reminder-${theme}.png` });
    await comparison.getByRole("button", { name: "Apply saved reminders" }).click();
    await expect(comparison.getByRole("alert")).toBeVisible();
    await comparison.getByRole("button", { name: "Apply saved reminders" }).click();
    await expect(delivery.getByText(/Saved changes queued/)).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0].expectedReminderStateVersion).toBe("a".repeat(64));
    expect(writes[0]).not.toHaveProperty("reminders");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K14 Google reminder editor preserves retry: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    const imported = event("00000000-0000-4000-8000-000000000184", "Google reminder meeting", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [imported] }, [{ ...calendars[0]!, provider: "google", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "google", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [], attendeesComplete: true, ownResponse: "accepted", reminders: { provider: "google", useDefault: false, overrides: [{ method: "popup", minutes: 30 }, { method: "email", minutes: 60 }] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-reminders`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    const eventTrigger = page.getByRole("button", { name: /Google reminder meeting/ }).first();
    await eventTrigger.click();
    const trigger = page.getByRole("button", { name: "Edit Google reminders" });
    await trigger.click();
    const editor = page.getByRole("dialog", { name: "Google reminders", exact: true });
    const minutes = editor.getByRole("textbox", { name: "Reminder 1 minutes before start" });
    await expect(minutes).toHaveValue("30");
    await expect(editor.getByRole("textbox", { name: "Reminder 2 minutes before start" })).toHaveValue("60");
    await chooseSelectOption(page, "Reminder 1 method", "Email");
    await chooseSelectOption(page, "Reminder 1 method", "Notification");
    await minutes.fill("-5");
    await editor.getByRole("button", { name: "Save Google reminders" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("whole minutes");
    expect(writes).toHaveLength(0);
    await minutes.fill("15");
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(await editor.evaluate(node => { const rect = node.getBoundingClientRect(); return [[rect.left + 24, rect.top + 50], [rect.right - 24, rect.top + 200], [rect.right - 24, rect.bottom - 30]].every(([x, y]) => node.contains(document.elementFromPoint(x, y))); })).toBe(true);
    await editor.screenshot({ path: `/tmp/musubi-k14-editor-${theme}.png` });
    await editor.getByRole("button", { name: "Save Google reminders" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(minutes).toHaveValue("15");
    await editor.getByRole("button", { name: "Save Google reminders" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Google confirmation is still pending");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "google", reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }, { method: "email", minutes: 60 }] } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused();
    expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K13 Google RSVP editor preserves retry: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    const imported = event("00000000-0000-4000-8000-000000000192", "Google RSVP meeting", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [imported] }, [{ ...calendars[0]!, provider: "google", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "google", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [{ name: "Guest", address: "guest@example.test", self: true, role: "required", response: "needsAction" }], attendeesComplete: true, ownResponse: "needsAction", reminders: { provider: "google", useDefault: true, overrides: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), rsvpEdit: { provider: "google", expectedRevision: 7 },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-rsvp`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    const eventTrigger = page.getByRole("button", { name: /Google RSVP meeting/ }).first();
    await eventTrigger.click();
    await page.getByRole("button", { name: "Respond in Google", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Respond in Google", exact: true });
    await expect(editor.getByRole("button", { name: "Send response" })).toBeDisabled();
    await chooseSelectOption(page, "Your Google response", "Tentative");
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await editor.screenshot({ path: `/tmp/musubi-k13-rsvp-${theme}.png` });
    await editor.getByRole("button", { name: "Send response" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(editor.getByRole("combobox", { name: "Your Google response" })).toContainText("Tentative");
    await editor.getByRole("button", { name: "Send response" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Google confirmation is still pending");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "google", response: "tentative", sendUpdates: "all" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused(); expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K13 own RSVP conflict confirmation: ${theme} ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const id = "00000000-0000-4000-8000-000000000151";
    const operation = "00000000-0000-4000-8000-000000000152";
    const saved = event(id, "RSVP appointment", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const writes: Record<string, unknown>[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000154", calendarId: "00000000-0000-4000-8000-000000000153", calendarName: "Google", provider: "google", connected: true, owned: true,
      operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    const receipt = { eventId: id, localRevision: 1, targets: [target] };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1,
      local: { ...saved, description: null, location: null }, remote: { ...saved, description: null, location: null },
      remoteEtag: '"fresh"', action: "update", canResolve: true, reason: null,
      rsvpResolution: { desired: "accepted", remote: "declined", baselineVersion: "a".repeat(64) },
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON());
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, receipt, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/);
    await page.getByRole("button", { name: /RSVP appointment/ }).first().click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("Accept")).toBeVisible();
    await expect(comparison.getByText("Decline")).toBeVisible();
    await expect(comparison.getByText(/Email delivery cannot be verified/)).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await expect(comparison.getByText("Current Google response")).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    expect(await comparison.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await comparison.screenshot({ path: `/tmp/musubi-k13-rsvp-conflict-${theme}.png` });
    await comparison.getByRole("button", { name: "Send saved response" }).click();
    await expect(comparison.getByRole("alert")).toBeVisible();
    await comparison.getByRole("button", { name: "Send saved response" }).click();
    await expect(delivery.getByText(/Saved response queued/)).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0].expectedRsvpBaselineVersion).toBe("a".repeat(64));
    expect(writes[0]).not.toHaveProperty("response");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K13 Google instance RSVP editor preserves retry: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    await page.route(url => url.pathname.startsWith("/api/"), route => { errors.push(`Unexpected API request: ${new URL(route.request().url()).pathname}`); return route.abort(); });
    const imported = event("00000000-0000-4000-8000-000000000192", "Google RSVP instance", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    const master = event("00000000-0000-4000-8000-000000000193", "Google RSVP series", "personal", "red", "2026-07-25T09:00:00Z", "2026-07-25T10:00:00Z", { recurrence: "RRULE:FREQ=DAILY;COUNT=4", timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-25T11:00:00.000", endLocal: "2026-07-25T12:00:00.000" } });
    Object.assign(imported, { seriesID: master.id, originalStart: { kind: "instant", value: "2026-07-26T09:00:00.000Z" }, start: "2026-07-26T11:00:00Z", end: "2026-07-26T12:00:00Z", timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-26T13:00:00.000", endLocal: "2026-07-26T14:00:00.000" } });
    await mockAuthenticatedReads(page, { ...events, events: [master, imported] }, [{ ...calendars[0]!, provider: "google", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "google", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [{ name: "Guest", address: "guest@example.test", self: true, role: "required", response: "needsAction" }], attendeesComplete: true, ownResponse: "needsAction", reminders: { provider: "google", useDefault: true, overrides: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), rsvpEdit: { provider: "google", expectedRevision: 7 },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-rsvp`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/);
    const eventTrigger = page.getByRole("button", { name: /Google RSVP instance/ }).first();
    await eventTrigger.click();
    await page.getByRole("button", { name: "Respond to this occurrence", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Respond to this occurrence", exact: true });
    await expect(editor.getByText(/This Google response applies only to this occurrence/)).toBeVisible();
    await expect(editor.getByRole("button", { name: "Send response" })).toBeDisabled();
    await chooseSelectOption(page, "Your Google response", "Tentative");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await editor.screenshot({ path: `/tmp/musubi-k13-instance-rsvp-${theme}.png` });
    await editor.getByRole("button", { name: "Send response" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(editor.getByRole("combobox", { name: "Your Google response" })).toContainText("Tentative");
    await editor.getByRole("button", { name: "Send response" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Google confirmation is still pending");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "google", response: "tentative", sendUpdates: "all" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused(); expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K12 following deletion conflict confirmation: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const id = "00000000-0000-4000-8000-000000000091", operation = "00000000-0000-4000-8000-000000000092";
    const saved = event(id, "Following deletion", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const scopeResolution = { kind: "following-delete", originalStart: { kind: "instant", value: "2026-07-25T07:30:00.000Z" } };
    const writes: unknown[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000094", calendarId: "00000000-0000-4000-8000-000000000093", calendarName: "CalDAV", provider: "caldav", connected: true, owned: true,
      operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    const receipt = { eventId: id, localRevision: 1, targets: [target] };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1, scopeResolution,
      local: { ...saved, description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=2" },
      remote: { ...saved, description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=8" },
      remoteEtag: '"fresh"', action: "update", canResolve: true, reason: null,
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON()); return respond(route, receipt, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/\/app\/p\/my-calendar\/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/i);
    const trigger = page.getByRole("button", { name: /Following deletion/ }).first();
    await trigger.click(); await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("Delete this and following", { exact: true })).toBeVisible();
    await expect(comparison.getByText(/Original start: 2026-07-25/)).toBeVisible();
    await expect(comparison.getByText(/Earlier occurrences remain/)).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Apply saved changes" })).toHaveCount(0);
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await comparison.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await expectNoAccessibilityViolations(page);
    expect(await comparison.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await comparison.screenshot({ path: `/tmp/musubi-k12-following-conflict-${theme}.png` });
    await comparison.getByRole("button", { name: "Delete following occurrences" }).click();
    await expect(delivery.getByText(/Saved changes queued/)).toBeVisible();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expectedScopeResolution: scopeResolution, expectedRemoteEtag: '"fresh"' });
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K12 whole series deletion conflict confirmation: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const id = "00000000-0000-4000-8000-000000000091", operation = "00000000-0000-4000-8000-000000000092";
    const saved = event(id, "Whole series deletion", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [] });
    const scopeResolution = { kind: "series-delete" };
    const writes: unknown[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000094", calendarId: "00000000-0000-4000-8000-000000000093", calendarName: "CalDAV", provider: "caldav", connected: true, owned: true,
      operationId: operation, action: "delete", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    const receipt = { eventId: id, localRevision: null, targets: [target] };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: null, scopeResolution,
      local: null,
      remote: { ...saved, description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=8" },
      remoteEtag: '"fresh"', action: "delete", canResolve: true, reason: null,
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON()); return respond(route, receipt, 202);
    });
    await page.route("**/api/v1/event-deliveries", route => respond(route, { items: [{ eventId: id, savedTitle: "Whole series deletion" }], nextCursor: null }));
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/\/app\/p\/my-calendar\/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/i);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const trigger = page.getByRole("button", { name: /Whole series deletion/ }).first();
    await trigger.click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("Entire series", { exact: true })).toBeVisible();
    await expect(comparison.getByText(/This removes the entire remote series/)).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Apply saved changes" })).toHaveCount(0);
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await comparison.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await expectNoAccessibilityViolations(page);
    expect(await comparison.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await comparison.screenshot({ path: `/tmp/musubi-k12-whole-delete-conflict-${theme}.png` });
    await comparison.getByRole("button", { name: "Delete entire series" }).click();
    await expect(delivery.getByText(/Saved changes queued/)).toBeVisible();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expectedScopeResolution: scopeResolution, expectedRemoteEtag: '"fresh"' });
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K12 following split conflict confirmation: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const id = "00000000-0000-4000-8000-000000000091", operation = "00000000-0000-4000-8000-000000000092";
    const saved = event(id, "Following split", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const scopeResolution = { kind: "following-update", newSeriesId: "00000000-0000-4000-8000-000000000099", originalStart: { kind: "instant", value: "2026-07-25T07:30:00.000Z" } };
    const writes: unknown[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000094", calendarId: "00000000-0000-4000-8000-000000000093", calendarName: "CalDAV", provider: "caldav", connected: true, owned: true,
      operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    const receipt = { eventId: id, localRevision: 1, targets: [target] };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1, scopeResolution,
      local: { ...saved, description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=2" },
      splitFuture: { ...saved, start: "2026-07-25T07:30:00Z", end: "2026-07-25T08:30:00Z", title: "Saved future title", description: "Future notes", location: null, recurrence: "RRULE:FREQ=WEEKLY;COUNT=4" },
      remote: { ...saved, description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=8" },
      remoteEtag: '"fresh"', action: "update", canResolve: true, reason: null,
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON()); return respond(route, receipt, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/\/app\/p\/my-calendar\/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/i);
    const trigger = page.getByRole("button", { name: /Following split/ }).first();
    await trigger.click(); await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("Saved future series", { exact: true })).toBeVisible();
    await expect(comparison.getByText("Saved future title", { exact: true })).toBeVisible();
    await expect(comparison.getByText("Change this and following", { exact: true })).toBeVisible();
    await expect(comparison.getByText(/Original start: 2026-07-25/)).toBeVisible();
    await expect(comparison.getByText(/two steps/)).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Apply saved changes" })).toHaveCount(0);
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await comparison.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await expectNoAccessibilityViolations(page);
    expect(await comparison.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await comparison.screenshot({ path: `/tmp/musubi-k12-split-conflict-${theme}.png` });
    const currentRule = comparison.getByRole("region", { name: "Remote copy" }).getByText("RRULE:FREQ=DAILY;COUNT=8", { exact: true });
    await currentRule.scrollIntoViewIfNeeded(); await expect(currentRule).toBeVisible();
    await comparison.getByRole("button", { name: "Apply following changes" }).click();
    await expect(delivery.getByText(/Saved changes queued/)).toBeVisible();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expectedScopeResolution: scopeResolution, expectedRemoteEtag: '"fresh"' });
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K12 future-only split confirmation: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const id = "00000000-0000-4000-8000-000000000091", operation = "00000000-0000-4000-8000-000000000092";
    const saved = event(id, "Future recovery", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const scopeResolution = { kind: "following-create", newSeriesId: "00000000-0000-4000-8000-000000000099", originalStart: { kind: "instant", value: "2026-07-25T07:30:00.000Z" } };
    const writes: unknown[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000094", calendarId: "00000000-0000-4000-8000-000000000093", calendarName: "CalDAV", provider: "caldav", connected: true, owned: true,
      operationId: operation, action: "create", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
    const receipt = { eventId: id, localRevision: 1, targets: [target] };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, {
      eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1, scopeResolution,
      local: { ...saved, start: "2026-07-25T07:30:00Z", end: "2026-07-25T08:30:00Z", title: "Saved future title", description: "Future notes", location: null, recurrence: "RRULE:FREQ=WEEKLY;COUNT=4" },
      remote: null,
      remoteEtag: null, action: "create", canResolve: true, reason: null,
    }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON()); return respond(route, receipt, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveURL(/\/app\/p\/my-calendar\/month\?date=2026-07-26/);
    await expect(page).toHaveTitle(/Musubi/i);
    const trigger = page.getByRole("button", { name: /Future recovery/ }).first();
    await trigger.click(); await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await delivery.getByRole("button", { name: "Review changes" }).click();
    const comparison = page.getByRole("dialog", { name: "Review remote changes" });
    await expect(comparison.getByText("Saved future series", { exact: true })).toBeVisible();
    await expect(comparison.getByText("Saved future title", { exact: true })).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Finish future series", exact: true })).toBeVisible();
    await expect(comparison.getByText(/Original start: 2026-07-25/)).toBeVisible();
    await expect(comparison.getByText(/The earlier series is already saved/)).toBeVisible();
    await expect(comparison.getByRole("button", { name: "Apply saved changes" })).toHaveCount(0);
    await expect(comparison.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await comparison.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
    expect(writes).toHaveLength(0);
    await expect(delivery.getByRole("button", { name: "Review changes" })).toBeFocused();
    await delivery.getByRole("button", { name: "Review changes" }).press("Enter");
    await comparison.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await expectNoAccessibilityViolations(page);
    expect(await comparison.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await comparison.screenshot({ path: `/tmp/musubi-k12-live/caldav-future-${theme}.png` });
    await expect(comparison.getByText("Not found at the provider", { exact: true })).toBeVisible();
    await comparison.getByRole("button", { name: "Finish future series" }).click();
    await expect(delivery.getByText(/Saved changes queued/)).toBeVisible();
    expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expectedScopeResolution: scopeResolution, expectedRemoteEtag: null, expectedRemoteExists: false });
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[390, "dark"], [1280, "light"]] as const) {
  for (const mode of ["quick-expand", "zoned", "all-day"] as const) {
    test(`creation draft identity survives lost response and expansion or reload ${mode} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setTestTheme(page, theme);
      const calendarID = "00000000-0000-4000-8000-000000000155";
      await mockAuthenticatedReads(page, { ...events, events: [] }, [{ ...calendars[0]!, id: calendarID, ...(mode === "quick-expand" ? {} : { provider: "microsoft" as const }) }]);
      const writes: any[] = [];
      const intercept = async (route: Route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const body = route.request().postDataJSON(); writes.push(body);
        if (writes.length === 1) return route.abort("failed");
        const value = body.event ?? body;
        return respond(route, { ...value, revision: 1, localCommitted: true,
          ...(body.time ? {
            start: mode === "all-day" ? "2026-07-30T00:00:00Z" : "2026-07-30T07:30:00Z",
            end: mode === "all-day" ? "2026-07-30T00:00:00Z" : "2026-07-30T08:30:00Z",
            isAllDay: mode === "all-day", timeModel: mode === "all-day" ? { kind: "all-day" } : body.time,
          } : {}),
        }, 202);
      };
      await page.route("**/api/v1/events", intercept);
      await page.route("**/api/v1/events/time", intercept);
      const draftUrl = `/app/p/${DEFAULT_PAGE_ID}/week/event/new?date=2026-07-30&view=week&calendarId=${calendarID}&title=Creation+retry&startTime=09%3A30&endTime=10%3A30&timeKind=${mode}${mode === "all-day" ? "&allDay=true" : ""}&timeZone=Europe%2FPrague&recurrence=RRULE%3AFREQ%3DDAILY%3BCOUNT%3D4`;
      if (mode === "quick-expand") {
        await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-30`);
        await openCreateEvent(page);
        await page.getByRole("textbox", { name: "Event title" }).fill("Creation retry");
      } else await page.goto(draftUrl);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      expect(writes).toHaveLength(1);
      const id = (writes[0].event ?? writes[0]).id;
      if (mode === "quick-expand") {
        const url = page.url();
        await page.getByRole("button", { name: "Expand event editor" }).click();
        await expect(page.getByRole("alert")).toBeVisible();
        await page.getByRole("button", { name: "Collapse event editor" }).click();
        await page.getByRole("button", { name: "Expand event editor" }).click();
        await expect(page).toHaveURL(url);
      } else {
        await expect(page).toHaveURL(new RegExp(`createID=${id}`));
        await page.reload();
      }
      await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("Creation retry");
      await expectNoAccessibilityViolations(page);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
      if (mode !== "quick-expand") {
        expect(writes[1].time.kind).toBe(mode);
        expect(writes[1].event.recurrence).toBe("RRULE:FREQ=DAILY;COUNT=4");
        expect(writes[1].event.createID).toBeUndefined();
      }
      await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week/event/new?date=2026-07-30&view=week`);
      await expect(page.getByRole("textbox", { name: "Event title" })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("createID")).not.toBe(id);
    });
  }
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  for (const inherited of [false, true]) for (const kind of ["zoned", "all-day"] as const) test(`K14 Google instance reminder editor ${kind} ${inherited ? "inherited defaults" : "custom"} preserves retry: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    const imported = event("00000000-0000-4000-8000-000000000184", "Google reminder instance", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    const master = event("00000000-0000-4000-8000-000000000244", "Google reminder series", "personal", "red", "2026-07-25T09:00:00Z", "2026-07-25T10:00:00Z", { recurrence: "RRULE:FREQ=DAILY;COUNT=4", timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-25T11:00:00.000", endLocal: "2026-07-25T12:00:00.000" } });
    Object.assign(imported, { seriesID: master.id, originalStart: { kind: "instant", value: "2026-07-26T09:00:00.000Z" }, start: "2026-07-26T11:00:00Z", end: "2026-07-26T12:00:00Z", timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-26T13:00:00.000", endLocal: "2026-07-26T14:00:00.000" } });
    if (kind === "all-day") {
      Object.assign(master, { isAllDay: true, start: "2026-07-25T00:00:00Z", end: "2026-07-25T00:00:00Z", timeModel: { kind: "all-day" } });
      Object.assign(imported, { isAllDay: true, start: "2026-07-26T00:00:00Z", end: "2026-07-26T00:00:00Z", originalStart: { kind: "date", value: "2026-07-26" }, timeModel: { kind: "all-day" } });
    }
    await mockAuthenticatedReads(page, { ...events, events: [master, imported] }, [{ ...calendars[0]!, provider: "google", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "google", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [], attendeesComplete: true, ownResponse: "accepted", reminders: { provider: "google", useDefault: inherited, overrides: inherited ? [] : [{ method: "popup", minutes: 30 }, { method: "email", minutes: 60 }] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), reminderEdit: { provider: "google", expectedRevision: 7 },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-reminders`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    const eventTrigger = page.getByRole("button", { name: /Google reminder instance/ }).first();
    await eventTrigger.click();
    const trigger = page.getByRole("button", { name: "Edit reminders for this occurrence" });
    await trigger.click();
    const editor = page.getByRole("dialog", { name: "Google reminders for this occurrence", exact: true });
    await expect(editor.getByText(/These Google reminders apply only to this occurrence/)).toBeVisible();
    if (inherited) {
      await expect(editor.getByRole("combobox", { name: "Reminder mode" })).toContainText("Calendar defaults");
      await expect(editor.getByRole("button", { name: "Save Google reminders" })).toBeDisabled();
      expect(writes).toHaveLength(0);
      await editor.getByRole("combobox", { name: "Reminder mode" }).click();
      await expect(page.getByRole("option", { name: "Calendar defaults", exact: true })).toBeDisabled();
      await page.getByRole("option", { name: "Custom", exact: true }).click();
      await editor.getByRole("textbox", { name: "Reminder 1 minutes before start" }).fill("30");
      await editor.getByRole("button", { name: "Add reminder" }).click();
      await editor.getByRole("textbox", { name: "Reminder 2 minutes before start" }).fill("60");
      await chooseSelectOption(page, "Reminder 2 method", "Email");
    }
    await editor.getByRole("combobox", { name: "Reminder mode" }).click();
    await expect(page.getByRole("option", { name: "Calendar defaults", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "Custom", exact: true }).click();
    const minutes = editor.getByRole("textbox", { name: "Reminder 1 minutes before start" });
    await expect(minutes).toHaveValue("30");
    await expect(editor.getByRole("textbox", { name: "Reminder 2 minutes before start" })).toHaveValue("60");
    await chooseSelectOption(page, "Reminder 1 method", "Email");
    await chooseSelectOption(page, "Reminder 1 method", "Notification");
    await minutes.fill("-5");
    await editor.getByRole("button", { name: "Save Google reminders" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("whole minutes");
    expect(writes).toHaveLength(0);
    await minutes.fill("15");
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(await editor.evaluate(node => { const rect = node.getBoundingClientRect(); return [[rect.left + 24, rect.top + 50], [rect.right - 24, rect.top + 200], [rect.right - 24, rect.bottom - 30]].every(([x, y]) => node.contains(document.elementFromPoint(x, y))); })).toBe(true);
    await editor.screenshot({ path: `/tmp/musubi-k14-instance-editor-${kind}-${theme}.png` });
    await editor.getByRole("button", { name: "Save Google reminders" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(minutes).toHaveValue("15");
    await editor.getByRole("button", { name: "Save Google reminders" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Google confirmation is still pending");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "google", reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }, { method: "email", minutes: 60 }] } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused();
    const deliveryReads: string[] = [];
    for (const id of [imported.id, master.id]) await page.route(`**/api/v1/events/${id}/delivery`, route => { deliveryReads.push(id); return respond(route, { eventId: id, localRevision: 7, targets: [] }); });
    await eventTrigger.click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Occurrence delivery details", exact: true }).click();
    const delivery = page.getByRole("dialog", { name: "Delivery", exact: true });
    await expect(delivery).toBeVisible();
    await expect.poll(() => deliveryReads.at(-1)).toBe(imported.id);
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    await eventTrigger.click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Series delivery details", exact: true }).click();
    await expect(delivery).toBeVisible();
    await expect.poll(() => deliveryReads.at(-1)).toBe(master.id);
    await delivery.getByRole("button", { name: "Close delivery", exact: true }).click();
    expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  for (const openEditor of [false, true]) {
    test(`K14 privacy downgrade retires open ${openEditor ? "editor" : "details"}: ${theme} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setTestTheme(page, theme);
      await page.addInitScript(value => {
        localStorage.setItem("musubi-theme", value);
        class FakeEventSource {
          onmessage: ((event: { data: string }) => void) | null = null;
          readyState = 1;
          constructor(public url: string) { ((window as any).__privacyStreams ??= []).push(this); }
          close() { this.readyState = 2; }
          addEventListener() {}
          removeEventListener() {}
        }
        (window as any).EventSource = FakeEventSource;
      }, theme);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const imported = event("00000000-0000-4000-8000-000000000248", "Native private title", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z", { description: "Native private notes", location: "Native private room" });
      const source = { ...calendars[0]!, provider: "google" as const, accountID: "fixture", accountLabel: "Fixture" };
      let redacted = false;
      await mockAuthenticatedReads(page, { ...events, events: [imported] }, [source]);
      await page.route(/\/api\/v1\/events(?:\?.*)?$/, route => route.request().method() === "GET" ? respond(route, { ...events, events: [redacted ? { ...imported, revision: 2, title: "Busy", description: null, location: null, organizer: "", url: null } : imported] }) : route.fallback());
      await page.route("**/api/v1/calendars", route => route.request().method() === "GET" ? respond(route, [{ ...source, role: redacted ? "viewer" : "owner" }]) : route.fallback());
      await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, redacted ? { state: null, version: null } : {
        state: { provider: "google", organizer: { name: "Native private host", address: "private-host@example.test", self: false }, isOrganizer: false, attendees: [], attendeesComplete: true, ownResponse: "accepted", reminders: { provider: "google", useDefault: false, overrides: [{ method: "popup", minutes: 30 }] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] }, version: "a".repeat(64), reminderEdit: { provider: "google", expectedRevision: 1 },
      }));
      await page.goto("/app/p/my-calendar/month?date=2026-07-26");
      await page.getByRole("button", { name: /Native private title/ }).first().click();
      await page.locator("summary").filter({ hasText: "Google Calendar details" }).click();
      await expect(page.getByText(/private-host@example.test/)).toBeVisible();
      if (openEditor) {
        await page.getByRole("button", { name: "Edit Google reminders" }).click();
        await expect(page.getByRole("dialog", { name: "Google reminders", exact: true })).toBeVisible();
      }
      redacted = true;
      await page.evaluate(() => {
        const streams = (window as any).__privacyStreams;
        const active = streams?.filter((stream: any) => stream.readyState === 1);
        if (!active?.length) throw new Error("No active fixture stream");
        for (const stream of active) stream.onmessage?.({ data: JSON.stringify({ type: "external_sync", payload: { calendars: ["personal"] } }) });
      });
      const busy = page.getByRole("button", { name: /Busy/ }).first();
      if (openEditor) await expect(busy).toBeVisible();
      else await expect(page.getByRole("dialog", { name: "Busy", exact: true })).toBeVisible();
      await expect(page.getByText(/private-host@example.test/)).toHaveCount(0);
      await expect(page.getByText("Native private notes", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: "Google reminders", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit Google reminders" })).toHaveCount(0);
      if (openEditor) await expect(busy).toBeFocused();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (!openEditor) {
        await page.getByRole("button", { name: "Close event details" }).click();
        await expect(busy).toBeVisible();
        await expect(busy).toBeFocused();
      }
      expect(errors).toEqual([]);
    });
  }
}

for (const provider of ["google", "microsoft", "caldav"] as const) {
for (const mode of ["compact", "generated", "full"] as const) {
  test(`${provider} editor privacy refresh preserves typed deltas (${mode})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: mode === "generated" ? 390 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "generated") await setTestTheme(page, "dark");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      class PrivacyEventSource {
        onmessage: ((event: { data: string }) => void) | null = null;
        readyState = 1;
        constructor() { (window as unknown as { privacyStream: PrivacyEventSource }).privacyStream = this; }
        close() { this.readyState = 2; }
        addEventListener() {}
        removeEventListener() {}
      }
      (window as unknown as { EventSource: unknown }).EventSource = PrivacyEventSource;
    });
    let current = event("aaaa1111-1111-4111-8111-111111111111", "Private appointment", "personal", "#b3492f", "2026-07-26T09:00:00.000Z", "2026-07-26T10:00:00.000Z", {
      originCalendarID: "personal", description: "Private provider notes", location: "Private provider room", url: "https://private.example.test",
      ...(mode === "generated" ? { recurrence: "FREQ=DAILY;COUNT=3" } : {}),
    });
    let source = { ...calendars[0]!, provider, role: "owner" };
    await mockAuthenticatedReads(page, { ...events, events: [current] }, [source]);
    await page.route("**/api/v1/calendars", route => respond(route, [source]));
    await page.route(/\/api\/v1\/events(?:\?.*)?$/, route => {
      expect(route.request().method()).toBe("GET");
      return respond(route, { ...events, events: [current] });
    });
    await page.route("**/api/v1/events/*/provider-state*", route => respond(route, { state: null, version: null }));
    await page.route("**/api/v1/events/*/delivery*", route => respond(route, { eventId: current.id, localRevision: current.revision, targets: [] }));
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
    await page.getByRole("button", { name: /Private appointment/ }).first().click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Event title" }).fill("My typed title");
    if (mode === "full") {
      await page.getByRole("button", { name: "Expand event editor", exact: true }).click();
      await expect(page).toHaveURL(/\/event\//);
    }
    const emit = () => page.evaluate(() => {
      (window as unknown as { privacyStream: { onmessage: (event: { data: string }) => void } }).privacyStream.onmessage({ data: JSON.stringify({ type: "external_sync" }) });
    });
    current = { ...current, title: provider !== "google" ? "Public permitted title" : "Busy", description: null, location: null, url: null, organizer: "", revision: 3, providerReadRetiredRevision: 2 };
    source = { ...source, role: provider !== "google" ? "owner" : "viewer" };
    await emit();
    if (provider === "google") {
      await expect(page.getByRole("textbox", { name: "Event title" })).toHaveCount(0);
      await expect(page.getByText("This event is read-only", { exact: true }).first()).toBeVisible();
    } else await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("My typed title");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${provider}-editor-${mode}-readonly.png`), fullPage: false });
    source = { ...source, role: "owner" };
    await emit();
    await expect(page.getByRole("textbox", { name: "Event title" })).toHaveValue("My typed title");
    await expect.poll(() => page.locator("input, textarea").evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).not.toContain("Private provider notes");
    expect(page.url()).not.toContain("Private+provider");
    expect(page.url()).not.toContain("Private%20provider");
    await page.screenshot({ path: testInfo.outputPath(`${provider}-editor-${mode}.png`), fullPage: false });
    if (mode !== "full") {
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect(page.getByRole("button", { name: provider !== "google" ? /Public permitted title/ : /Busy/ }).first()).toBeFocused();
    }
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
}
for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K14 CalDAV event alarm editor preserves retry: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    const imported = event("00000000-0000-4000-8000-000000000184", "CalDAV alarm event", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [imported] }, [{ ...calendars[0]!, provider: "caldav", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "caldav", organizer: null, isOrganizer: false, attendees: [], attendeesComplete: true, ownResponse: null, reminders: { provider: "caldav", alarms: [{ action: "DISPLAY", trigger: "-PT30M", related: null, repeat: null, duration: null }] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), reminderEdit: { provider: "caldav", expectedRevision: 7, minutesBeforeStart: 30 },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-reminders`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    const eventTrigger = page.getByRole("button", { name: /CalDAV alarm event/ }).first();
    await eventTrigger.click();
    const trigger = page.getByRole("button", { name: "Edit CalDAV event alarms" });
    await trigger.click();
    const editor = page.getByRole("dialog", { name: "CalDAV event alarms", exact: true });
    const minutes = editor.getByRole("textbox", { name: "Reminder 1 minutes before start" });
    await expect(minutes).toHaveValue("30");
    await expect(editor.getByRole("textbox", { name: "Reminder 2 minutes before start" })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Add reminder" })).toBeDisabled();
    await expect(editor.getByText(/may be shared with other calendar users/)).toBeVisible();
    await minutes.fill("-5");
    await editor.getByRole("button", { name: "Save CalDAV event alarms" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("whole minutes");
    expect(writes).toHaveLength(0);
    await minutes.fill("15");
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(await editor.evaluate(node => { const rect = node.getBoundingClientRect(); return [[rect.left + 24, rect.top + 50], [rect.right - 24, rect.top + 200], [rect.right - 24, rect.bottom - 30]].every(([x, y]) => node.contains(document.elementFromPoint(x, y))); })).toBe(true);
    await editor.screenshot({ path: `/tmp/musubi-caldav-alarm-editor-${theme}.png` });
    await editor.getByRole("button", { name: "Save CalDAV event alarms" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(minutes).toHaveValue("15");
    await editor.getByRole("button", { name: "Save CalDAV event alarms" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("CalDAV confirmation is still pending");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "caldav", alarms: { minutesBeforeStart: 15 } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused();
    expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K14 CalDAV saved alarm discard: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const id = "00000000-0000-4000-8000-000000000141", operation = "00000000-0000-4000-8000-000000000142";
    const saved = event(id, "Alarm appointment", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const writes: unknown[] = [];
    const target = { targetId: "00000000-0000-4000-8000-000000000144", calendarId: "00000000-0000-4000-8000-000000000143", calendarName: "CalDAV", provider: "caldav", connected: true, owned: true, operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict", alarmDiscardRevision: 1 };
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, { eventId: id, localRevision: 1, targets: [writes.length > 1 ? { ...target, alarmDiscardRevision: undefined, alarmDiscarded: true, status: "not-needed", issue: null } : target] }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/discard-alarm`, route => {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) {
        target.alarmDiscardRevision = 2;
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Delivery revision changed" }) });
      }
      return respond(route, { eventId: id, localRevision: 1, targets: [{ ...target, alarmDiscardRevision: undefined, alarmDiscarded: true, status: "not-needed", issue: null }] });
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Alarm appointment/ }).first().click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    await page.getByRole("button", { name: "Discard saved alarm change", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Discard saved alarm change", exact: true });
    await expect(dialog.getByText(/does not undo a change/)).toBeVisible();
    expect(writes).toHaveLength(0);
    await expectNoAccessibilityViolations(page);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.getByRole("button", { name: "Discard saved alarm change", exact: true }).press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("Check the refreshed status");
    await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    await page.getByRole("button", { name: "Discard saved alarm change", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "Discard saved alarm change", exact: true }).press("Enter");
    await expect(page.getByText(/Saved alarm change discarded. The current CalDAV event/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard saved alarm change", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    expect(writes).toEqual([{ expectedRevision: 1 }, { expectedRevision: 2 }]); expect(errors).toEqual([]);
  });
}

test("K14 CalDAV lost alarm discard retains a usable focus target on Escape", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000151", operation = "00000000-0000-4000-8000-000000000152";
  const saved = event(id, "Alarm appointment", "personal", "#b3492f", "2026-07-23T07:30:00Z", "2026-07-23T08:30:00Z");
  await mockAuthenticatedReads(page, { ...events, events: [saved] });
  let discarded = false;
  const target = { targetId: "00000000-0000-4000-8000-000000000154", calendarId: "00000000-0000-4000-8000-000000000153", calendarName: "CalDAV", provider: "caldav", connected: true, owned: true, operationId: operation, action: "update", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-23T09:00:00Z", retryAt: null, issue: "conflict" };
  await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, { eventId: id, localRevision: 1, targets: [{ ...target, ...(discarded ? { status: "not-needed", alarmDiscarded: true } : { alarmDiscardRevision: 1 }) }] }));
  await page.route(`**/api/v1/events/${id}/delivery/${operation}/discard-alarm`, route => { discarded = true; return route.abort("connectionreset"); });
  await page.goto("/app/p/my-calendar/month?date=2026-07-26");
  await page.getByRole("button", { name: /Alarm appointment/ }).first().click();
  await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
  await page.getByRole("button", { name: "Discard saved alarm change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discard saved alarm change", exact: true });
  await dialog.getByRole("button", { name: "Discard saved alarm change", exact: true }).press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Could not reach the server");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard saved alarm change", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeFocused();
  await expectNoAccessibilityViolations(page);
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Google availability explicit selection and unknown results: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mockAuthenticatedReads(page);
    await page.route("**/api/v1/server", route => respond(route, { email: true, pushPublicKey: null, socials: [], socialsWeb: [], syncProviders: ["google"], googleAvailability: true }));
    const source = { id: "00000000-0000-4000-8000-000000000101", generation: 1, label: "Team availability", accountLabel: "Google work", enabled: false, reconnectRequired: false };
    await page.route("**/api/v1/availability/sources", route => respond(route, { sources: [source] }));
    await page.route(`**/api/v1/availability/sources/${source.id}`, route => {
      expect(route.request().postDataJSON()).toEqual({ enabled: true, expectedGeneration: 1 });
      source.enabled = true; source.generation++;
      return respond(route, { sources: [source] });
    });
    const requests: unknown[] = [];
    await page.route("**/api/v1/availability", route => {
      const range = route.request().postDataJSON(); requests.push(range);
      const result = requests.length === 1 ? { status: "available", intervals: [{ start: "2026-10-25T00:30:00Z", end: "2026-10-25T02:30:00Z" }] } : requests.length === 2 ? { status: "unavailable" } : { status: "available", intervals: [] };
      return respond(route, { start: range.start, end: range.end, observedAt: "2026-10-24T12:00:00Z", sources: [{ sourceId: source.id, generation: source.generation, ...result }] });
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Check availability", exact: true });
    await expect(trigger).toBeDisabled(); expect(requests).toHaveLength(0);
    await page.getByRole("switch", { name: "Use Team availability for availability" }).click();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Check availability", exact: true });
    await dialog.getByLabel("From (UTC)", { exact: true }).fill("2026-10-25");
    await dialog.getByLabel("Until (UTC, exclusive)", { exact: true }).fill("2026-10-26");
    const read = dialog.getByRole("button", { name: "Read busy intervals" });
    await read.click();
    await expect(dialog.getByText("2026-10-25T00:30:00Z – 2026-10-25T02:30:00Z")).toBeVisible();
    expect(requests[0]).toEqual({ start: "2026-10-25T00:00:00Z", end: "2026-10-26T00:00:00Z", sourceIds: [source.id] });
    await expect(dialog.getByRole("button", { name: /Edit|RSVP|Reminder/ })).toHaveCount(0);
    await dialog.evaluate(async node => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await expectNoAccessibilityViolations(page);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.screenshot({ path: `/tmp/musubi-availability-${theme}.png` });
    await read.click();
    await expect(dialog.getByText("Unavailable — free time is unknown", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Busy", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("No busy intervals in the requested range")).toHaveCount(0);
    await read.click();
    await expect(dialog.getByText("No busy intervals in the requested range")).toBeVisible();
    await dialog.getByRole("button", { name: "Close availability", exact: true }).click();
    await expect(trigger).toBeFocused(); expect(requests).toHaveLength(3); expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K12 explicit UTC whole-series clock conversion: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const known = event("00000000-0000-4000-8000-000000000194", "UTC clock series", "personal", "red", "2026-10-23T00:30:00Z", "2026-10-23T01:30:00Z", {
      recurrence: "RRULE:FREQ=DAILY;COUNT=2", seriesID: null, originalStart: null,
      timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-10-23T02:30:00.000", endLocal: "2026-10-23T03:30:00.000" },
    });
    await mockAuthenticatedReads(page, { ...events, events: [known] });
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/events/${known.id}/scope`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return respond(route, { operationID: body.operationID, changed: true, events: [{ id: known.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false });
    });
    await page.goto("/app/p/my-calendar/month?date=2026-10-24");
    await page.locator('[data-day-key="2026-10-24"]').getByRole("button", { name: /UTC clock series/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Expand event editor", exact: true }).click();
    await chooseTimeZone(page.getByRole("combobox", { name: "Event time zone", exact: true }), "UTC");
    await expect(page.getByLabel("Start time", { exact: true })).toHaveValue("02:30");
    const editor = page.getByRole("dialog", { name: "Edit series", exact: true });
    await expect(editor.getByText("Changes apply to the whole series.")).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await editor.screenshot({ path: testInfo.outputPath("utc-series-editor.png") });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ scope: "series", action: "update", expectedRevision: 1, patch: {}, time: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-23T02:30:00.000", endLocal: "2026-10-23T03:30:00.000" } });
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K13 CalDAV RSVP editor preserves retry: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    const imported = event("00000000-0000-4000-8000-000000000192", "CalDAV RSVP meeting", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [imported] }, [{ ...calendars[0]!, provider: "caldav", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "caldav", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [{ name: "Guest", address: "guest@example.test", self: true, role: "required", response: "needsAction" }], attendeesComplete: true, ownResponse: "needsAction", reminders: { provider: "caldav", alarms: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), rsvpEdit: { provider: "caldav", expectedRevision: 7 },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-rsvp`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    const eventTrigger = page.getByRole("button", { name: /CalDAV RSVP meeting/ }).first();
    await eventTrigger.click();
    await page.getByRole("button", { name: "Respond in calendar", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Respond in calendar", exact: true });
    await expect(editor.getByRole("button", { name: "Send response to organizer" })).toBeDisabled();
    await chooseSelectOption(page, "Your response", "Tentative");
    await editor.getByRole("button", { name: "About responses" }).hover(); await expect(page.getByRole("tooltip")).toContainText("Organizer delivery cannot be verified");
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await editor.screenshot({ path: `/tmp/musubi-k12-live/caldav-rsvp-browser-${theme}.png` });
    await editor.getByRole("button", { name: "Send response to organizer" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(editor.getByRole("combobox", { name: "Your response" })).toContainText("Tentative");
    await editor.getByRole("button", { name: "Send response to organizer" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Calendar confirmation is still pending");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "caldav", response: "tentative", notificationPolicy: "server-reply" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused(); expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme, outcome] of [[1280, "light", "success"], [390, "dark", "success"], [1280, "light", "cancel"], [390, "dark", "escape"]] as const) {
  test(`Graph create adoption is an explicit local choice: ${theme} ${width} ${outcome}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)") && !message.text().includes("net::ERR_FAILED")) errors.push(message.text()); });
    const id = "00000000-0000-4000-8000-000000000271", operation = "00000000-0000-4000-8000-000000000272";
    const saved = event(id, "Original Graph draft", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [saved] });
    const target = { targetId: "00000000-0000-4000-8000-000000000273", calendarId: "00000000-0000-4000-8000-000000000274", calendarName: "Outlook", provider: "microsoft", connected: true, owned: true, operationId: operation, action: "create", status: "conflict", revision: 1, latestRevision: 1, updatedAt: "2026-07-26T11:00:00Z", retryAt: null, issue: "conflict" };
    let adopted = false; const writes: unknown[] = [];
    const receipt = () => ({ eventId: id, localRevision: adopted ? 2 : 1, targets: [{ ...target, ...(adopted ? { status: "not-needed", issue: null, graphCreateAdopted: true } : {}) }] });
    await page.route(`**/api/v1/events/${id}/delivery`, route => respond(route, receipt()));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/conflict`, route => respond(route, { eventId: id, operationId: operation, latestOperationId: operation, localRevision: 1, action: "create", local: { ...saved, description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=4" }, remote: { ...saved, title: "Current provider family", description: null, location: null, recurrence: "RRULE:FREQ=DAILY;COUNT=3" }, remoteEtag: 'W/"snapshot"', canResolve: true, reason: null, graphCreateAdoption: { stateVersion: "a".repeat(64), occurrenceCount: 3 } }));
    await page.route(`**/api/v1/events/${id}/delivery/${operation}/resolve`, route => {
      writes.push(route.request().postDataJSON());
      if (outcome !== "success") { adopted = true; return route.abort("failed"); }
      if (writes.length === 1) return respond(route, { error: "Temporary failure" }, 503);
      adopted = true; return respond(route, receipt());
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Original Graph draft/ }).first().click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Review changes", exact: true }); await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Review remote changes", exact: true });
    await expect(dialog.getByRole("button", { name: "Recreate remote copy" })).toHaveCount(0);
    await expect(dialog.getByText(/No provider write is sent/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expectNoAccessibilityViolations(page);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.screenshot({ path: `/tmp/musubi-k12-live/graph-adoption-browser-${theme}.png` });
    expect(writes).toHaveLength(0);
    await dialog.getByRole("button", { name: "Use provider version" }).press("Enter");
    if (outcome !== "success") {
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
      if (outcome === "cancel") await dialog.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
      else await dialog.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeFocused();
      expect(writes).toHaveLength(1);
      expect(errors).toEqual([]);
      return;
    }
    await expect(dialog.getByRole("alert")).toContainText("Temporary failure");
    await dialog.getByRole("button", { name: "Use provider version" }).press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Provider version accepted in Musubi. No provider write was sent.", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ kind: "graph-create-adoption", mutationID: expect.any(String), expectedRevision: 1, stateVersion: "a".repeat(64) });
    await expect(page.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Availability grid explicit static intervals and DST projection: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mockAuthenticatedReads(page, { ...events, events: [] });
    await page.route("**/api/v1/server", route => respond(route, { email: true, pushPublicKey: null, socials: [], socialsWeb: [], syncProviders: ["google"], googleAvailability: true }));
    const id = "00000000-0000-4000-8000-000000000171";
    await page.route("**/api/v1/availability/sources", route => respond(route, { sources: [{ id, generation: 1, enabled: true, label: "Team availability", accountLabel: "Google work", reconnectRequired: false }] }));
    const reads: any[] = [];
    await page.route("**/api/v1/availability", route => {
      const range = route.request().postDataJSON(); reads.push(range);
      const day = new Date(new Date(range.start).getTime() + 10 * 3600000).toISOString();
      return respond(route, { start: range.start, end: range.end, observedAt: "2026-07-26T07:00:00Z", sources: [{ sourceId: id, generation: 1, status: "available", intervals: [{ start: day, end: new Date(new Date(day).getTime() + 3600000).toISOString() }] }] });
    });
    await page.goto("/app/p/my-calendar/day?date=2026-07-26");
    await expect(page.getByRole("button", { name: "Availability", exact: true })).toBeVisible();
    expect(reads).toHaveLength(0); await expect(page.locator("[data-availability-interval]")).toHaveCount(0);
    await page.getByRole("button", { name: "Availability", exact: true }).click();
    const popover = page.getByRole("dialog", { name: "Grid availability" });
    await popover.getByRole("switch", { name: "Show selected availability" }).click();
    await page.keyboard.press("Escape");
    const block = page.getByRole("note", { name: /Busy, Team availability/ });
    await expect(block).toBeVisible();
    expect(reads[0].sourceIds).toEqual([id]);
    await expect(block).not.toHaveAttribute("data-time-event"); await expect(block.getByRole("button")).toHaveCount(0);
    await block.click(); await expect(page.getByRole("heading", { name: "New event", exact: true })).toHaveCount(0);
    await block.hover(); await page.mouse.down(); await page.mouse.move(width - 60, 650, { steps: 8 }); await page.mouse.up();
    await expect(page.getByRole("heading", { name: "New event", exact: true })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/musubi-grid-${theme}.png` });
    await page.getByRole("button", { name: "Availability", exact: true }).click();
    await page.getByRole("button", { name: "Sources and intervals", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check availability", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Availability", exact: true })).toBeFocused();
    await page.goto("/app/p/my-calendar/day?date=2026-10-25");
    await page.getByRole("button", { name: "Availability", exact: true }).click();
    await page.getByRole("switch", { name: "Show selected availability" }).click(); await page.keyboard.press("Escape");
    await expect(page.getByText(/Availability cannot be shown in the grid on clock-change days/)).toHaveCount(0);
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute("aria-label", /2026-10-25, 09:00–10:00/);
    await expect(page.locator("[data-availability-interval]")).toHaveCount(1);
    await expect(block).not.toHaveAttribute("data-time-event");
    await expect(block.getByRole("button")).toHaveCount(0);
    expect(errors).toEqual([]); await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

test("Availability grid keeps capped event lanes usable and selection pending across Connections closure", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockAuthenticatedReads(page, { ...events, events: [1, 2, 3, 4].map(index => event(`grid-overlap-${index}`, `Overlap ${index}`, "personal", "#b3492f", "2026-07-26T08:00:00Z", "2026-07-26T09:00:00Z")) });
  await page.route("**/api/v1/server", route => respond(route, { email: true, pushPublicKey: null, socials: [], socialsWeb: [], syncProviders: ["google"], googleAvailability: true }));
  const source = { id: "00000000-0000-4000-8000-000000000171", generation: 1, enabled: false, label: "Team availability", accountLabel: "Google work", reconnectRequired: false };
  let sourceReads = 0; let commit!: () => Promise<void>;
  await page.route("**/api/v1/availability/sources", route => { sourceReads++; return respond(route, { sources: [source] }); });
  await page.route(`**/api/v1/availability/sources/${source.id}`, route => { commit = async () => { source.enabled = route.request().postDataJSON().enabled; source.generation++; await respond(route, { sources: [source] }); }; });
  await page.route("**/api/v1/availability", route => { const range = route.request().postDataJSON(); return respond(route, { start: range.start, end: range.end, observedAt: range.start, sources: [{ sourceId: source.id, generation: source.generation, status: "available", intervals: [{ start: "2026-07-26T07:00:00Z", end: "2026-07-26T10:00:00Z" }] }] }); });
  await page.goto("/app/p/my-calendar/day?date=2026-07-26");
  await page.getByRole("button", { name: "Availability", exact: true }).click();
  await page.getByRole("switch", { name: "Show selected availability" }).click(); await page.keyboard.press("Escape");
  await expect(page.getByText(/No availability sources selected/)).toBeVisible();
  const openConnections = async () => { await page.getByRole("button", { name: "Availability", exact: true }).click(); await page.getByRole("button", { name: "Sources and intervals", exact: true }).click(); };
  await openConnections();
  const select = page.getByRole("switch", { name: "Use Team availability for availability" });
  await select.click(); await expect.poll(() => !!commit).toBe(true);
  const readsBeforeClose = sourceReads;
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.locator("[data-availability-interval]")).toHaveCount(0);
  await openConnections(); await expect(select).toBeDisabled(); expect(sourceReads).toBe(readsBeforeClose);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await commit(); await expect(page.locator("[data-availability-interval]")).toHaveCount(1);
  for (const index of [1, 2, 3, 4]) {
    const block = page.locator(`[data-time-event="grid-overlap-${index}"]`);
    await block.click({ position: { x: 8, y: 20 } });
    await expect(page.getByRole("heading", { name: `Overlap ${index}`, exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(block).toBeFocused();
  }
  await openConnections(); await select.click(); await expect(select).toBeDisabled();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByText(/Availability selection is changing. No free time is confirmed yet/)).toBeVisible();
  await expect(page.locator("[data-availability-interval]")).toHaveCount(0);
  await commit(); await expect(page.getByText(/No availability sources selected/)).toBeVisible();
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  for (const mode of ["one-off", "occurrence", "series", "initial-series"]) test(`K13 Graph ${mode} RSVP editor preserves retry: ${theme} ${width}`, async ({ page }) => {
    const occurrence = mode !== "one-off", series = mode === "series" || mode === "initial-series";
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !message.text().includes("503 (Service Unavailable)")) errors.push(message.text()); });
    const imported = event("00000000-0000-4000-8000-000000000192", "Graph RSVP meeting", "personal", "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z");
    await mockAuthenticatedReads(page, { ...events, events: [imported] }, [{ ...calendars[0]!, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    let observations = 0;
    await page.route(`**/api/v1/events/${imported.id}/provider-state*`, route => respond(route, {
      state: { provider: "microsoft", organizer: { name: "Host", address: "host@example.test", self: false }, isOrganizer: false, attendees: [{ name: "Guest", address: "guest@example.test", self: true, role: "required", response: "needsAction" }], attendeesComplete: true, ownResponse: "needsAction", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "opaque", privacy: "private", status: "active", eventType: occurrence ? "occurrence" : "singleInstance", conferenceURLs: [] },
      version: (++observations === 1 ? "b" : "a").repeat(64), rsvpEdit: { provider: "microsoft", expectedRevision: 7, ...(occurrence ? { scope: mode === "initial-series" ? "series" : "occurrence" } : {}), ...(series ? { series: { version: "c".repeat(64), ownResponse: "notResponded" } } : {}) },
    }));
    const writes: any[] = [];
    await page.route(`**/api/v1/events/${imported.id}/provider-rsvp`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    let checked = false, checks = 0;
    const delivery = () => ({ eventId: imported.id, localRevision: 7, targets: [{ targetId: "00000000-0000-4000-8000-000000000193", calendarId: "00000000-0000-4000-8000-000000000194", calendarName: "Outlook", provider: "microsoft", connected: true, owned: true, operationId: writes[0]?.operationID ?? "00000000-0000-4000-8000-000000000195", action: "update", status: checked ? "unconfirmed" : "conflict", revision: 7, latestRevision: 7, updatedAt: "2026-07-26T12:00:00Z", retryAt: null, issue: checked ? "unconfirmed" : "conflict", graphRsvpPhase: checked ? "absent" : "accepted" }] });
    await page.route(`**/api/v1/events/${imported.id}/delivery`, route => respond(route, delivery()));
    await page.route(`**/api/v1/events/${imported.id}/delivery/*/retry`, route => { checks++; checked = true; return respond(route, delivery(), 202); });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    const eventTrigger = page.getByRole("button", { name: /Graph RSVP meeting/ }).first();
    await eventTrigger.click();
    const responseTitle = series ? "Respond in Outlook" : occurrence ? "Respond to this occurrence" : "Respond in Outlook";
    await page.getByRole("button", { name: responseTitle, exact: true }).click();
    const editor = page.getByRole("dialog", { name: responseTitle, exact: true });
    if (occurrence && !series) await expect(editor.getByText("This Outlook response applies only to this occurrence.")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Send response to organizer" })).toBeDisabled();
    if (mode === "series") await chooseSelectOption(page, "Response applies to", "Entire series");
    if (mode === "initial-series") await expect(editor.getByText("Response applies to: Entire series")).toBeVisible();
    if (series) await expect(editor.getByText(/Existing exceptions keep their own response/)).toBeVisible();
    await chooseSelectOption(page, "Your response", "Tentative");
    await editor.getByRole("button", { name: "About responses" }).hover(); await expect(page.getByRole("tooltip")).toContainText("Organizer delivery cannot be verified");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await editor.screenshot({ path: `/tmp/musubi-k12-live/microsoft-${mode}-rsvp-browser-${theme}.png` });
    await editor.getByRole("button", { name: "Send response to organizer" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(editor.getByRole("combobox", { name: "Your response" })).toContainText("Tentative");
    await editor.getByRole("button", { name: "Send response to organizer" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Check Delivery details for Outlook acceptance");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toEqual({ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "microsoft", response: "tentative", notificationPolicy: "send-response", ...(series ? { scope: "series", expectedSeriesVersion: "c".repeat(64) } : occurrence ? { scope: "occurrence" } : {}) });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(eventTrigger).toBeFocused();
    await eventTrigger.click();
    await page.getByRole("button", { name: "More event actions" }).click(); await page.getByRole("menuitem", { name: "Delivery details", exact: true }).click();
    const receiptDialog = page.getByRole("dialog", { name: "Delivery", exact: true });
    await expect(receiptDialog.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
    await receiptDialog.getByRole("button", { name: "Check response", exact: true }).press("Enter");
    await expect(receiptDialog.getByText(/Outlook meeting copy unavailable/)).toBeVisible();
    expect(checks).toBe(1); expect(writes).toHaveLength(2); expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K12 imported all-day exclusion restoration: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const known = event("00000000-0000-4000-8000-000000000201", "Imported excluded dates", "personal", "red", "2026-03-28T00:00:00Z", "2026-03-28T00:00:00Z", {
      recurrence: "RRULE:FREQ=DAILY;COUNT=4\nEXDATE;VALUE=DATE:20260329,20260330", seriesID: null, originalStart: null, isAllDay: true, timeModel: { kind: "all-day" },
    });
    await mockAuthenticatedReads(page, { ...events, events: [known] });
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/events/${known.id}/scope`, route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return respond(route, { operationID: body.operationID, changed: true, events: [{ id: known.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false });
    });
    await page.goto("/app/p/my-calendar/month?date=2026-03-29");
    await page.locator('[data-day-key="2026-03-28"]').getByRole("button", { name: /Imported excluded dates/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Expand event editor", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit series", exact: true });
    await expect(editor.getByText("Changes apply to the whole series.")).toBeVisible();
    await editor.getByRole("button", { name: "Restore 2026-03-29", exact: true }).click();
    await expect(editor.getByRole("combobox", { name: "Repeat", exact: true })).toBeFocused();
    await expect(editor.getByRole("button", { name: "Restore 2026-03-30", exact: true })).toBeVisible();
    const retainedDate = await editor.getByText("2026-03-30", { exact: true }).boundingBox();
    const restoreButton = await editor.getByRole("button", { name: "Restore 2026-03-30", exact: true }).boundingBox();
    expect(retainedDate).not.toBeNull(); expect(restoreButton).not.toBeNull();
    expect(retainedDate!.x + retainedDate!.width).toBeLessThanOrEqual(restoreButton!.x);
    await expectNoAccessibilityViolations(page);
    await editor.screenshot({ path: testInfo.outputPath("restored-excluded-date.png") });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ scope: "series", action: "update", expectedRevision: 1, patch: { recurrence: "RRULE:FREQ=DAILY;COUNT=4\nEXDATE;VALUE=DATE:20260330" } });
    expect(writes[0]).not.toHaveProperty("time");
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`K14 explicit CalDAV series alarm: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const master = event("00000000-0000-4000-8000-000000000303", "CalDAV finite alarm series", "personal", "red", "2026-03-28T22:00:00Z", "2026-03-29T00:00:00Z", {
      revision: 7, recurrence: "RRULE:FREQ=DAILY;COUNT=4", timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-28T23:00:00.000", endLocal: "2026-03-29T01:00:00.000" },
    });
    await mockAuthenticatedReads(page, { ...events, events: [master] }, [{ ...calendars[0]!, provider: "caldav", accountID: "fixture", accountLabel: "Fixture" }]);
    let stale = false;
    await page.route(`**/api/v1/events/${master.id}/provider-state*`, route => respond(route, {
      state: { provider: "caldav", organizer: null, isOrganizer: false, attendees: [], attendeesComplete: true, ownResponse: null, reminders: { provider: "caldav", alarms: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] },
      version: "a".repeat(64), reminderEdit: { provider: "caldav", scope: "series", expectedRevision: stale ? 8 : 7, minutesBeforeStart: 15 },
    }));
    const writes: unknown[] = [];
    await page.route(`**/api/v1/events/${master.id}/provider-reminders`, route => { const body = route.request().postDataJSON(); writes.push(body); return respond(route, { operationID: body.operationID, replayed: false, status: "pending", localCommitted: true }, 202); });
    await page.goto("/app/p/my-calendar/month?date=2026-03-29");
    const occurrence = page.locator('[data-day-key="2026-03-29"]').getByRole("button", { name: /CalDAV finite alarm series/ }).last();
    await occurrence.click();
    await expect(page.getByRole("button", { name: "Edit CalDAV event alarms" })).toHaveCount(0);
    const seriesAction = page.getByRole("button", { name: "Series alarm settings" });
    await expect(seriesAction).toBeVisible();
    stale = true;
    await seriesAction.click();
    await expect(page.getByRole("dialog", { name: "CalDAV series alarm", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Could not refresh provider details/)).toBeVisible();
    stale = false;
    await seriesAction.click();
    const editor = page.getByRole("dialog", { name: "CalDAV series alarm", exact: true });
    await expect(editor.getByText(/Applies to every occurrence in this series/)).toBeVisible();
    await editor.getByRole("textbox", { name: "Reminder 1 minutes before start" }).fill("30");
    await expectNoAccessibilityViolations(page);
    await editor.screenshot({ path: testInfo.outputPath("series-alarm.png") });
    await editor.getByRole("button", { name: "Save CalDAV series alarm" }).click();
    await expect(editor.getByRole("status")).toContainText("confirmation is still pending");
    expect(writes).toEqual([{ operationID: expect.any(String), expectedRevision: 7, expectedStateVersion: "a".repeat(64), provider: "caldav", scope: "series", alarms: { minutesBeforeStart: 30 } }]);
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(occurrence).toBeFocused();
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) for (const action of ["create", "update", "delete"] as const) {
  test(`Google organizer explicit ${action}: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000291", eventID = "00000000-0000-4000-8000-000000000292";
    const saved = { ...event(eventID, "Organizer meeting", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-26T11:00:00.000", endLocal: "2026-07-26T12:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "google", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/calendars/${calendarID}/provider-organizer`, route => respond(route, { provider: "google", calendarID, sendUpdates: "all" }));
    await page.route(`**/api/v1/events/${eventID}/provider-state*`, route => respond(route, { state: { provider: "google", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "needsAction" }], attendeesComplete: true, ownResponse: null, reminders: { provider: "google", useDefault: true, overrides: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "google", calendarID, expectedRevision: 4 } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => { const body = route.request().postDataJSON(); writes.push(body); if (action === "create" && writes.length === 1) return respond(route, { error: "Choose external guests", organizerAdmissionRejected: true }, 400); return writes.length === (action === "create" ? 2 : 1) ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, eventID: body.eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202); });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    let trigger: Locator;
    if (action === "create") {
      if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Calendars", exact: true }).click();
      trigger = page.getByRole("button", { name: "Create Google meeting", exact: true }); await trigger.click();
    } else {
      await page.getByRole("button", { name: /Organizer meeting/ }).first().click();
      trigger = page.getByRole("button", { name: "Manage Google meeting", exact: true }); await trigger.click();
    }
    const editor = page.getByRole("dialog", { name: action === "create" ? "Create meeting" : "Manage Google meeting", exact: true });
    if (action === "create") { await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Guest planning"); await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("owner@example.test"); await editor.getByRole("button", { name: "Create and send invitations" }).click(); await expect(editor.getByRole("alert")).toContainText("Choose external guests"); await expect(editor.getByRole("textbox", { name: "Guest email addresses" })).toBeEnabled(); await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("guest@example.test"); }
    if (action === "update") await editor.getByRole("textbox", { name: "Notes", exact: true }).fill("New explicit note");
    await expectNoAccessibilityViolations(page); expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expectOrganizerPaintedAbovePopover(editor);
    await editor.screenshot({ path: `/tmp/musubi-k12-live/google-organizer-${action}-${theme}.png` });
    if (action === "delete") {
      await editor.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
      const confirmation = page.getByRole("dialog", { name: "Cancel Google meeting", exact: true });
      await expectOrganizerPaintedAbovePopover(confirmation);
      expect(writes).toHaveLength(0);
      await confirmation.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
      await expect(confirmation.getByRole("alert")).toContainText("Temporary failure");
      await confirmation.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
    } else {
      await editor.getByRole("button", { name: action === "create" ? "Create and send invitations" : "Save and notify guests" }).press("Enter");
      await expect(editor.getByRole("alert")).toContainText("Temporary failure");
      await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
      await editor.getByRole("button", { name: "Retry saved meeting action" }).press("Enter");
    }
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(action === "create" ? 3 : 2); expect(writes.at(-1)).toEqual(writes.at(-2)); expect(writes[0]).toMatchObject({ action, provider: "google", sendUpdates: "all", calendarID }); if (action === "create") { expect(writes[1].operationID).not.toBe(writes[0].operationID); expect(writes[1].guests[0].email).toBe("guest@example.test"); }
    if (action === "update") expect(writes[0].patch).toEqual({ description: "New explicit note" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  for (const remove of [false, true]) test(`K12 single CalDAV RDATE ${remove ? "remove" : "add"}: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const known = event("00000000-0000-4000-8000-000000000901", "Additional series date", "personal", "red", "2026-03-28T00:00:00Z", "2026-03-28T00:00:00Z", {
      recurrence: "RRULE:FREQ=DAILY;COUNT=2" + (remove ? "\nRDATE;VALUE=DATE:20260402" : ""), seriesID: null, originalStart: null, isAllDay: true, timeModel: { kind: "all-day" },
    });
    await mockAuthenticatedReads(page, { ...events, events: [known] }, [{ ...calendars[0]!, provider: "caldav", accountID: "fixture", accountLabel: "CalDAV" }]);
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/events/${known.id}/scope`, route => { const body = route.request().postDataJSON(); writes.push(body); return respond(route, { operationID: body.operationID, changed: true, events: [{ id: known.id, revision: 2 }], deleted: [], localCommitted: true, replayed: false }); });
    await page.goto("/app/p/my-calendar/month?date=2026-03-29");
    await page.locator('[data-day-key="2026-03-29"]').getByRole("button", { name: /Additional series date/ }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Expand event editor", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit series", exact: true });
    await expect(editor.getByText("Changes apply to the whole series.")).toBeVisible();
    if (remove) await editor.getByRole("button", { name: "Remove additional date", exact: true }).click();
    else {
      await editor.getByRole("button", { name: /^Additional series date:/ }).click();
      await page.getByRole("textbox", { name: "Exact date", exact: true }).fill("02/04/2026");
      await page.getByRole("textbox", { name: "Exact date", exact: true }).press("Enter");
      await expect(editor.getByRole("button", { name: "Remove additional date", exact: true })).toBeVisible();
    }
    await expectNoAccessibilityViolations(page);
    await editor.screenshot({ path: testInfo.outputPath("single-additional-date.png") });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ scope: "series", action: "update", expectedRevision: 1, patch: { recurrence: "RRULE:FREQ=DAILY;COUNT=2" + (remove ? "" : "\nRDATE;VALUE=DATE:20260402") } });
    expect(writes[0]).not.toHaveProperty("time"); expect(writes[0]).not.toHaveProperty("originalStart");
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) for (const action of ["create", "update", "delete"] as const) {
  test(`CalDAV organizer explicit ${action}: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000291", eventID = "00000000-0000-4000-8000-000000000292";
    const saved = { ...event(eventID, "Organizer meeting", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-26T11:00:00.000", endLocal: "2026-07-26T12:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "caldav", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/calendars/${calendarID}/provider-organizer`, route => respond(route, { provider: "caldav", calendarID, notificationPolicy: "server-invite", createTime: "utc-or-all-day" }));
    await page.route(`**/api/v1/events/${eventID}/provider-state*`, route => respond(route, { state: { provider: "caldav", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "needsAction" }], attendeesComplete: true, ownResponse: null, reminders: { provider: "caldav", alarms: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "caldav", calendarID, expectedRevision: 4, actions: action === "delete" ? ["delete"] : ["update"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => { const body = route.request().postDataJSON(); writes.push(body); if (action === "create" && writes.length === 1) return respond(route, { error: "Choose external guests", organizerAdmissionRejected: true }, 400); return writes.length === (action === "create" ? 2 : 1) ? respond(route, { error: "Temporary failure" }, 503) : respond(route, { operationID: body.operationID, eventID: body.eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202); });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    let trigger: Locator;
    if (action === "create") {
      if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Calendars", exact: true }).click();
      trigger = page.getByRole("button", { name: "Create CalDAV meeting", exact: true }); await trigger.click();
    } else {
      await page.getByRole("button", { name: /Organizer meeting/ }).first().click();
      trigger = page.getByRole("button", { name: "Manage CalDAV meeting", exact: true }); await trigger.click();
    }
    const editor = page.getByRole("dialog", { name: action === "create" ? "Create meeting" : "Manage CalDAV meeting", exact: true });
    if (action === "create") { await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Guest planning"); await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("owner@example.test"); await editor.getByRole("button", { name: "Create and send invitations" }).click(); await expect(editor.getByRole("alert")).toContainText("Choose external guests"); await expect(editor.getByRole("textbox", { name: "Guest email addresses" })).toBeEnabled(); await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("guest@example.test"); }
    if (action === "delete") await expect(editor.getByRole("button", { name: "Save and notify guests" })).toHaveCount(0);
    if (action === "update") await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    if (action !== "create") await expect(editor.getByLabel("Start", { exact: true })).toHaveCount(0);
    else { await expect(editor.getByRole("combobox", { name: "Event time zone" })).toHaveAttribute("value", "Europe/Prague"); await expect(editor.getByRole("combobox", { name: "Event time zone" })).toBeEnabled(); }
    if (action === "update") await editor.getByRole("textbox", { name: "Notes", exact: true }).fill("New explicit note");
    await expectNoAccessibilityViolations(page); expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expectOrganizerPaintedAbovePopover(editor);
    await editor.screenshot({ path: `/tmp/musubi-k12-live/caldav-organizer-${action}-${theme}.png` });
    if (action === "delete") {
      await editor.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
      const confirmation = page.getByRole("dialog", { name: "Cancel CalDAV meeting", exact: true });
      await expectOrganizerPaintedAbovePopover(confirmation);
      expect(writes).toHaveLength(0);
      await confirmation.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
      await expect(confirmation.getByRole("alert")).toContainText("Temporary failure");
      await confirmation.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
    } else {
      await editor.getByRole("button", { name: action === "create" ? "Create and send invitations" : "Save and notify guests" }).press("Enter");
      await expect(editor.getByRole("alert")).toContainText("Temporary failure");
      await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
      await editor.getByRole("button", { name: "Retry saved meeting action" }).press("Enter");
    }
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(action === "create" ? 3 : 2); expect(writes.at(-1)).toEqual(writes.at(-2)); expect(writes[0]).toMatchObject({ action, provider: "caldav", notificationPolicy: "server-invite", calendarID }); if (action === "create") { expect(writes[1].operationID).not.toBe(writes[0].operationID); expect(writes[1].guests[0].email).toBe("guest@example.test"); }
    if (action === "update") expect(writes[0].patch).toEqual({ description: "New explicit note" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) for (const action of ["update", "delete"] as const) {
  test(`Google bound occurrence organizer ${action}: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000391", eventID = "00000000-0000-4000-8000-000000000392", parentID = "00000000-0000-4000-8000-000000000393";
    const saved = { ...event(eventID, "Bound organizer occurrence", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, seriesID: parentID, originalStart: { kind: "instant", value: "2026-07-25T09:00:00.000Z" }, timeModel: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-26T11:00:00.000", endLocal: "2026-07-26T12:00:00.000" } };
    const master = { ...saved, id: parentID, title: "Organizer series", revision: 9, seriesID: null, originalStart: null, recurrence: "RRULE:FREQ=DAILY;COUNT=3" };
    await mockAuthenticatedReads(page, { ...events, events: [master, saved] }, [{ ...calendars[0]!, id: calendarID, provider: "google", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state*`, route => respond(route, { state: { provider: "google", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: null, reminders: { provider: "google", useDefault: true, overrides: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "google", calendarID, expectedRevision: 4, scope: "occurrence", instanceVersion: "b".repeat(64) } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => { const body = route.request().postDataJSON(); writes.push(body); return respond(route, { operationID: body.operationID, eventID: body.eventID, replayed: false, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202); });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Bound organizer occurrence/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage this occurrence", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage this occurrence", exact: true });
    await expect(editor.getByLabel("Start", { exact: true })).toHaveCount(0);
    await expect(editor.getByLabel("All day", { exact: true })).toHaveCount(0);
    await expect(editor.getByLabel("Guest email addresses")).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    if (action === "update") {
      await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Changed occurrence");
      await editor.getByRole("button", { name: "Save and notify guests" }).press("Enter");
    } else {
      await editor.getByRole("button", { name: "Cancel this occurrence and notify guests" }).click();
      expect(writes).toHaveLength(0);
      await page.getByRole("dialog", { name: "Cancel this occurrence", exact: true }).getByRole("button", { name: "Cancel this occurrence and notify guests" }).press("Enter");
    }
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ eventID, calendarID, action, provider: "google", sendUpdates: "all", scope: "occurrence", expectedRevision: 4, expectedInstanceVersion: "b".repeat(64) });
    if (action === "update") expect(writes[0].patch).toEqual({ title: "Changed occurrence" });
    expect(writes[0]).not.toHaveProperty("originalStart"); expect(writes[0]).not.toHaveProperty("guests");
    await expectOrganizerPaintedAbovePopover(editor);
    await editor.screenshot({ path: `/tmp/musubi-k12-live/google-organizer-instance-${action}-${theme}.png` });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}


test("CalDAV task editor retires coalesced baseline and preserves explicit clear", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    class TaskPrivacyStream {
      onmessage: ((event: { data: string }) => void) | null = null;
      readyState = 1;
      constructor() { (window as unknown as { taskPrivacyStream: TaskPrivacyStream }).taskPrivacyStream = this; }
      close() { this.readyState = 2; }
      addEventListener() {}
      removeEventListener() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = TaskPrivacyStream;
  });
  await mockAuthenticatedReads(page, events, [{ ...calendars[0]!, provider: "caldav", supportsTasks: true, role: "owner" }]);
  let current = { id: "11111111-1111-4111-8111-111111111111", creatorID: "alex", calendarID: "personal", title: "Private task baseline", description: "Private copied notes", status: "needs-action", isAllDay: false, sequence: 3, percentComplete: 0, priority: 0, providerReadRetiredGeneration: null as number | null };
  await page.route("**/api/v1/tasks", route => respond(route, { tasks: [current] }));
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/tasks/*", route => {
    writes.push(route.request().postDataJSON());
    return respond(route, { ...current, ...writes.at(-1) });
  });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/tasks?date=2026-07-26`);
  await page.getByRole("button", { name: /Private task baseline/ }).click();
  await page.getByRole("dialog", { name: "Private task baseline", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("");
  const emit = () => page.evaluate(() => (window as unknown as { taskPrivacyStream: { onmessage: (event: { data: string }) => void } }).taskPrivacyStream.onmessage({ data: JSON.stringify({ type: "external_sync" }) }));
  current = { ...current, title: "Fresh permitted task", description: "Fresh copied notes", providerReadRetiredGeneration: 1 };
  await emit();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Fresh permitted task");
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("");
  current = { ...current, title: "Second permitted task", description: "Second copied notes", providerReadRetiredGeneration: 2 };
  await emit();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Second permitted task");
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("caldav-task-retirement.png") });
  await page.getByRole("button", { name: "Save task", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit task" })).toHaveCount(0);
  expect(writes).toEqual([expect.objectContaining({ title: "Second permitted task", description: null, expectedProviderReadRetiredGeneration: 2 })]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) for (const kind of ["zoned", "all-day"] as const) {
  test(`CalDAV organizer retime ${kind}: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000311", eventID = "00000000-0000-4000-8000-000000000312";
    const saved = { ...event(eventID, "Retime meeting", calendarID, "red", kind === "all-day" ? "2026-07-26T00:00:00Z" : "2026-07-26T09:00:00Z", kind === "all-day" ? "2026-07-26T00:00:00Z" : "2026-07-26T10:00:00Z"), revision: 4, isAllDay: kind === "all-day", timeModel: kind === "all-day" ? { kind } : { kind, timeZone: "Europe/Prague", startLocal: "2026-07-26T11:00:00.000", endLocal: "2026-07-26T12:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "caldav", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state*`, route => respond(route, { state: { provider: "caldav", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "ACCEPTED" }], attendeesComplete: true, ownResponse: null, reminders: { provider: "caldav", alarms: [] }, availability: "opaque", privacy: "private", status: "confirmed", eventType: "default", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "caldav", calendarID, expectedRevision: 4, actions: ["update"], timeEdit: true } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => { const body = route.request().postDataJSON(); writes.push(body); return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202); });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Retime meeting/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage CalDAV meeting", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage CalDAV meeting", exact: true });
    await expect(editor.getByRole("checkbox", { name: "All day" })).toBeDisabled();
    if (kind === "zoned") { await expect(editor.getByRole("combobox", { name: "Event time zone" })).toHaveAttribute("value", "Europe/Prague"); await expect(editor.getByRole("combobox", { name: "Event time zone" })).toBeDisabled(); }
    await editor.getByLabel("Start", { exact: true }).fill(kind === "all-day" ? "2026-07-27" : "2026-07-27T11:00");
    await editor.getByLabel("End", { exact: true }).fill(kind === "all-day" ? "2026-07-28" : "2026-07-27T12:00");
    await expect(editor).toContainText("Their existing responses will reset");
    await expectNoAccessibilityViolations(page); expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expectOrganizerPaintedAbovePopover(editor);
    await editor.screenshot({ path: `/tmp/musubi-k12-live/caldav-organizer-retime-${kind}-${theme}.png` });
    await editor.getByRole("button", { name: "Save and notify guests" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByLabel("Start", { exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Retry saved meeting action" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0].patch).toEqual({ time: kind === "all-day" ? { kind, startDate: "2026-07-27", endDate: "2026-07-28" } : { kind, timeZone: "Europe/Prague", startLocal: "2026-07-27T11:00:00.000", endLocal: "2026-07-27T12:00:00.000" } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space"); await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}


for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook organizer explicit create: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000291";
    await mockAuthenticatedReads(page, { ...events, events: [] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/calendars/${calendarID}/provider-organizer`, route => respond(route, { provider: "microsoft", calendarID, notificationPolicy: "server-invite", createTime: "utc-or-all-day", actions: ["create"] }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      if (writes.length === 1) return respond(route, { error: "Choose external guests", organizerAdmissionRejected: true }, 400);
      if (writes.length === 2) return respond(route, { error: "Temporary failure" }, 503);
      return respond(route, { operationID: body.operationID, eventID: body.eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Calendars", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Create Outlook meeting", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Create meeting", exact: true });
    await expect(editor.getByRole("combobox", { name: "Event time zone" })).toHaveAttribute("value", "Europe/Prague");
    await expect(editor.getByRole("combobox", { name: "Event time zone" })).toBeEnabled();
    await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Guest planning");
    await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("owner@example.test");
    await editor.getByRole("button", { name: "Create and send invitations" }).click();
    await expect(editor.getByRole("alert")).toContainText("Choose external guests");
    await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("guest@example.test");
    await expectNoAccessibilityViolations(page);
    await expectOrganizerPaintedAbovePopover(editor);
    await editor.screenshot({ path: testInfo.outputPath(`outlook-organizer-${theme}.png`) });
    await editor.getByRole("button", { name: "Create and send invitations" }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Temporary failure");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Retry saved meeting action" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(3); expect(writes[2]).toEqual(writes[1]);
    expect(writes[1]).toMatchObject({ action: "create", provider: "microsoft", notificationPolicy: "server-invite", time: { timeZone: "UTC" } });
    expect(writes[1]).not.toHaveProperty("sendUpdates"); expect(writes[1].operationID).not.toBe(writes[0].operationID);
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}


for (const confirmation of ["unavailable", "missing"] as const) {
  test(`SessionGate API 401 with ${confirmation} session confirmation`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      // Chromium reports the deliberately injected HTTP failures as console
      // errors; every other browser error remains a test failure.
      if (message.type() === "error" && !/Failed to load resource: the server responded with a status of (401|503)/.test(message.text())) {
        errors.push(message.text());
      }
    });
    // Catch every API request before installing specific fixtures: this isolated
    // regression must never reach the live authenticated API behind Vite.
    await page.route(url => url.pathname.startsWith("/api/"), route => respond(route, {}));
    const item = event("session-check", "Session check event", "personal", "#b3492f",
      "2026-07-08T09:00:00+02:00", "2026-07-08T10:00:00+02:00");
    await mockAuthenticatedReads(page, { ...events, events: [item] });
    await page.route("**/api/v1/availability/sources", route => respond(route, { sources: [] }));
    let checking = false;
    let recovered = false;
    let signOuts = 0;
    let checks = 0;
    await page.route("**/api/auth/get-session", route => {
      if (!checking || recovered) return respond(route, session);
      checks++;
      return confirmation === "unavailable"
        ? respond(route, { message: "Temporary session service failure" }, 503)
        : respond(route, null);
    });
    await page.route("**/api/auth/sign-out", route => {
      signOuts++;
      return respond(route, { success: true });
    });
    await page.route("**/api/v1/events", route => {
      if (route.request().method() !== "PATCH" || recovered) return route.fallback();
      checking = true;
      return respond(route, { error: "Unauthorized", message: "Sign in required" }, 401);
    });
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month/event/session-check?date=2026-07-08`);
    await expect(page).toHaveTitle(/Musubi/);
    const title = page.getByRole("textbox", { name: "Event title" });
    await title.fill("Keep my draft");
    const checked = page.waitForResponse(response => response.url().endsWith("/api/auth/get-session")
      && response.status() === (confirmation === "unavailable" ? 503 : 200));
    await title.press("Control+Enter");
    await checked;
    await expect.poll(() => checks).toBeGreaterThan(0);
    if (confirmation === "unavailable") {
      await expect(page.getByRole("alert")).toContainText("Sign in required");
      await expect(title).toHaveValue("Keep my draft");
      // A subsequent real editor interaction must still work after the failed
      // check settles, rather than merely catching the frame before sign-out.
      recovered = true;
      await title.press("Control+Enter");
      await expect(title).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
      expect(signOuts).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem("musubi:last-session") !== null)).toBe(true);
      await expect(page).toHaveURL(/\/app\//);
    } else {
      await expect(page).toHaveURL(/\/login/);
      expect(signOuts).toBeGreaterThan(0);
      expect(await page.evaluate(() => localStorage.getItem("musubi:last-session"))).toBeNull();
      await expect(page.getByRole("heading", { name: "My calendar" })).toHaveCount(0);
    }
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/musubi-session-check-${confirmation}.png` });
  });
}


for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  for (const entry of ["toolbar", "calendar"] as const) {
    test(`shared meeting creation from ${entry}: ${theme} ${width}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await setTestTheme(page, theme);
      // Every request stays inside this fixture, including invitation writes.
      await page.route(url => url.pathname.startsWith("/api/"), route => respond(route, {}));
      const googleID = "00000000-0000-4000-8000-000000000391";
      const outlookID = "00000000-0000-4000-8000-000000000392";
      const connected = [
        { ...calendars[0]!, id: googleID, name: "Studio", provider: "google", accountId: "google-fixture", accountLabel: "studio@example.test" },
        { ...calendars[0]!, id: outlookID, name: "Team", provider: "microsoft", accountId: "outlook-fixture", accountLabel: "team@example.test" },
      ];
      await mockAuthenticatedReads(page, { ...events, events: [] }, [calendars[0]!, ...connected]);
      await page.route(`**/api/v1/calendars/${googleID}/provider-organizer`, route => respond(route, { provider: "google", calendarID: googleID, sendUpdates: "all" }));
      await page.route(`**/api/v1/calendars/${outlookID}/provider-organizer`, route => respond(route, { provider: "microsoft", calendarID: outlookID, notificationPolicy: "server-invite", createTime: "utc-or-all-day", actions: ["create"] }));
      const writes: Record<string, unknown>[] = [], errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/v1/provider-organizer", route => {
        const body = route.request().postDataJSON(); writes.push(body);
        return respond(route, { operationID: body.operationID, eventID: body.eventID, replayed: false, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
      });
      await page.goto("/app/p/my-calendar/month?date=2026-07-26");
      let trigger: Locator;
      if (entry === "toolbar") {
        trigger = page.getByRole("button", { name: "Create event, meeting or task", exact: true });
        await trigger.click();
        await page.getByRole("menuitem", { name: "Meeting", exact: true }).click();
      } else {
        if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
        await page.getByRole("button", { name: "Calendars", exact: true }).click();
        trigger = page.getByRole("button", { name: "Create Outlook meeting", exact: true });
        await trigger.click();
      }
      const editor = page.getByRole("dialog", { name: "Create meeting", exact: true });
      const info = editor.getByRole("button", { name: "Meeting invitation information" });
      await expect(editor).not.toContainText("Guest notification delivery cannot be verified");
      await info.click();
      const help = page.getByRole("region", { name: "Meeting invitation information" });
      await expect(help).toContainText("Guest notification delivery cannot be verified");
      await expectNoAccessibilityViolations(page);
      expect(await help.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await help.screenshot({ path: testInfo.outputPath("meeting-information.png") });
      await page.keyboard.press("Escape");
      await expect(help).toHaveCount(0);
      await expect(info).toBeFocused();
      await expect(editor).toBeVisible();
      const calendar = editor.getByRole("combobox", { name: "Calendar", exact: true });
      await expect(calendar).toContainText(entry === "calendar" ? "Team" : "Studio");
      await calendar.click();
      await expect(page.getByRole("option")).toHaveCount(2);
      await page.getByRole("option", { name: /Studio/ }).click();
      await expect(calendar).toBeFocused();
      await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Shared meeting draft");
      await editor.getByRole("textbox", { name: "Guest email addresses" }).fill("guest@example.test");
      await editor.getByLabel("Start", { exact: true }).fill("2026-07-26T11:00");
      await editor.getByLabel("End", { exact: true }).fill("2026-07-26T12:00");
      await chooseTimeZone(editor.getByRole("combobox", { name: "Event time zone" }), "Europe/Prague");
      await calendar.click();
      await page.getByRole("option", { name: /Team/ }).click();
      await expect(calendar).toBeFocused();
      await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Shared meeting draft");
      await expect(editor.getByRole("textbox", { name: "Guest email addresses" })).toHaveValue("guest@example.test");
      await expect(editor.getByLabel("Start", { exact: true })).toHaveValue(/2026-07-26T11:00/);
      await expect(editor.getByRole("combobox", { name: "Event time zone" })).toHaveAttribute("value", "Europe/Prague");
      await expect(editor.getByRole("combobox", { name: "Event time zone" })).toBeEnabled();
      await expectNoAccessibilityViolations(page);
      expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await editor.screenshot({ path: testInfo.outputPath("shared-meeting.png") });
      await editor.getByRole("button", { name: "Create and send invitations" }).click();
      await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ calendarID: outlookID, provider: "microsoft", action: "create", time: { timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" }, content: { title: "Shared meeting draft" } });
      await editor.getByRole("button", { name: "Close", exact: true }).click();
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}


for (const [width, theme] of [[1280, "dark"], [390, "light"], [320, "dark"]] as const) {
  test(`Google availability setup discovers a shared calendar: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 916 });
    await setTestTheme(page, theme);
    await mockAuthenticatedReads(page);
    await page.route("**/api/v1/server", route => respond(route, { email: true, pushPublicKey: null, socials: [], socialsWeb: [], syncProviders: ["google", "microsoft", "caldav"], googleAvailability: true }));
    let discovered = false;
    let refreshes = 0;
    let intervalReads = 0;
    const source = { id: "00000000-0000-4000-8000-000000000101", generation: 1, label: "Team availability", accountLabel: "Google work", enabled: false, reconnectRequired: false };
    await page.route("**/api/v1/availability/sources", route => respond(route, { sources: discovered ? [source] : [] }));
    await page.route("**/api/v1/availability", route => { intervalReads++; return respond(route, {}); });
    await page.route("**/api/v1/users/connections/sync", route => {
      refreshes++; discovered = true; return respond(route, {});
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    const connections = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(connections.getByText("No shared busy-time calendars yet")).toBeVisible();
    await expect(connections.getByRole("button", { name: "Check availability", exact: true })).toHaveCount(0);
    await expect(connections.getByRole("checkbox", { name: "Include Tasks" })).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
    expect(await connections.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await connections.screenshot({ path: `/tmp/musubi-connections-${theme}-${width}.png` });
    const setup = connections.getByRole("button", { name: "How to set up" });
    await setup.click();
    const dialog = page.getByRole("dialog", { name: "Set up Google availability", exact: true });
    await expect(dialog.getByText("See only free/busy (hide details)")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Google sharing guide" })).toHaveAttribute("href", "https://support.google.com/calendar/answer/37082?hl=en");
    await expectNoAccessibilityViolations(page);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.screenshot({ path: `/tmp/musubi-availability-setup-${theme}-${width}.png` });
    await dialog.getByRole("button", { name: "Close availability setup" }).click();
    await expect(setup).toBeFocused();
    await setup.click();
    await dialog.getByRole("button", { name: "Refresh connected calendars", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(connections.getByRole("switch", { name: "Use Team availability for availability" })).not.toBeChecked();
    await expect(connections.getByRole("button", { name: "Check availability", exact: true })).toBeDisabled();
    await expect(setup).toBeFocused();
    expect(refreshes).toBe(1);
    expect(intervalReads).toBe(0);
  });
}


for (const [width, theme, count] of [[1280, "dark", 5], [1280, "light", 24], [390, "dark", 24]] as const) {
  test(`Delivery inbox keeps closing space: ${theme} ${width} ${count}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 916 });
    await setTestTheme(page, theme);
    await mockAuthenticatedReads(page);
    await page.route("**/api/v1/event-deliveries", route => respond(route, {
      items: Array.from({ length: count }, (_, i) => ({ eventId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, savedTitle: `Saved meeting ${i + 1}` })), nextCursor: null,
    }));
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const dialog = page.getByRole("dialog", { name: "Notifications", exact: true });
    const last = dialog.getByRole("button", { name: `Saved meeting ${count} Delivery needs attention`, exact: true });
    await expect(last).toBeAttached();
    await last.focus();
    await last.press("Escape");
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(dialog.getByRole("button", { name: "Refresh notifications" })).toBeFocused();
    const measurements = await last.evaluate(element => {
      const body = element.closest('[role="dialog"]')!.querySelector('[data-notifications-body]')!;
      body.scrollTop = body.scrollHeight;
      return { bodyBottom: body.getBoundingClientRect().bottom, lastBottom: element.getBoundingClientRect().bottom };
    });
    // Anchored notifications use the shared popover 16px inset.
    expect(measurements.bodyBottom - measurements.lastBottom).toBeGreaterThanOrEqual(15);
    expect(measurements.bodyBottom - measurements.lastBottom).toBeLessThanOrEqual(18);
    await expectNoAccessibilityViolations(page);
    await dialog.screenshot({ path: testInfo.outputPath("inbox-bottom-spacing.png") });
  });
}


for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Account avatar and contextual help: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 916 });
    await setTestTheme(page, theme);
    await mockAuthenticatedReads(page);
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    if (width < 600) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "User menu for Web QA" }).click();
    await page.getByRole("menuitem", { name: "Manage account", exact: true }).click();
    const account = page.getByRole("dialog", { name: "Settings", exact: true });
    const avatar = account.getByRole("button", { name: "Change photo", exact: true });
    await expect(avatar).toBeVisible();
    await expect(avatar).not.toContainText("Change photo");
    await account.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
    const box = await avatar.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(64);
    expect(Math.abs(box!.width - box!.height)).toBeLessThanOrEqual(2);
    await expectNoAccessibilityViolations(page);
    await account.screenshot({ path: testInfo.outputPath("clickable-avatar.png") });
    await account.getByRole("button", { name: /Display name/ }).click();
    const editor = page.getByRole("dialog", { name: "Display name", exact: true });
    const input = editor.getByRole("textbox", { name: "Display name", exact: true });
    await expect(input).toBeFocused();
    await expect(editor).not.toContainText("How people recognize you in shared calendars.");
    const help = editor.getByRole("button", { name: "Help for Display name", exact: true });
    if (width < 600) await help.click(); else await help.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("How people recognize you in shared calendars.");
    if (width >= 600) await expect(input).toBeFocused();
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath("contextual-help.png") });
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(account.getByRole("button", { name: /Display name/ })).toBeFocused();
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`task shared recurrence editor: ${theme} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 916 });
    await setTestTheme(page, theme);
    await mockAuthenticatedReads(page);
    let saved: Record<string, unknown> | undefined;
    await page.route("**/api/v1/tasks", route => {
      if (route.request().method() === "POST") {
        saved = { ...route.request().postDataJSON(), creatorID: session.user.id };
        return respond(route, saved);
      }
      return respond(route, { tasks: saved ? [saved] : [] });
    });
    await page.goto("/app/p/my-calendar/tasks?date=2026-07-26");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Weekly UI review");
    await page.getByRole("button", { name: "Start date: Choose date", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose start date" }).getByRole("button", { name: "Today", exact: true }).click();
    await page.getByText("Recurrence", { exact: true }).click();
    await page.getByRole("combobox", { name: "Repeat", exact: true }).click();
    await page.getByRole("option", { name: "Every week", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Recurrence rule" })).not.toBeVisible();
    await expectNoAccessibilityViolations(page);
    const footerGap = await page.getByRole("button", { name: "Save task", exact: true }).evaluate(button => {
      const footer = button.closest('[data-slot="dialog-footer"]')!;
      const body = footer.previousElementSibling!;
      return button.getBoundingClientRect().top - body.getBoundingClientRect().bottom;
    });
    expect(footerGap).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: testInfo.outputPath("task-recurrence.png"), fullPage: true });
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New task" })).not.toBeVisible();
    expect(saved?.recurrence).toMatch(/^FREQ=WEEKLY;BYDAY=/);
    expect(saved?.start).toBeTruthy();
    await page.getByRole("button", { name: /Weekly UI review/ }).click();
    await page.getByRole("dialog", { name: "Weekly UI review", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByText("Recurrence", { exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Every week");
  });
}

for (const width of [1280, 390]) {
  test(`Kanban preserves layout and moves tasks between phases at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAuthenticatedReads(page);
    let task = { id: "kanban-task", creatorID: session.user.id, calendarID: "personal", title: "Kanban review", status: "needs-action", percentComplete: 0, priority: 5, sequence: 0, isAllDay: false, recurrence: "FREQ=WEEKLY", start: null, due: null, completedAt: null };
    let failMove = false;
    let responseGate: Promise<void> | undefined;
    let releaseResponse: (() => void) | undefined;
    const other = { ...task, id: "kanban-other", title: "Existing card", status: "in-process" };
    await page.route("**/api/v1/tasks", route => respond(route, { tasks: [task, other] }));
    await page.route("**/api/v1/tasks/kanban-task", async route => {
      if (failMove) { await route.fulfill({ status: 500, body: "Failed" }); return; }
      await responseGate;
      task = { ...task, ...route.request().postDataJSON() };
      await respond(route, task);
    });
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/tasks?date=2026-07-26`);
    await page.getByRole("radio", { name: "Kanban", exact: true }).click();
    await expect(page).toHaveURL(/taskLayout=kanban/);
    await page.reload();
    const board = page.getByRole("region", { name: "Tasks", exact: true });
    for (const name of ["Needs action", "In progress", "Completed", "Cancelled"]) {
      await expect(board.getByRole("region", { name, exact: true })).toBeAttached();
    }
    if (width === 1280) {
      for (const scroller of await board.locator("[data-kanban-column-scroll]").all()) {
        expect(await scroller.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      const handle = page.getByRole("button", { name: "Drag Kanban review to another status; press Enter to open task details" });
      await board.getByRole("button", { name: "Kanban review", exact: true }).click();
      const taskDetail = page.getByRole("dialog", { name: "Kanban review", exact: true });
      await expect(taskDetail).toBeVisible();
      await taskDetail.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Edit task" })).toBeVisible();
      await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
      await page.getByRole("button", { name: "Close task editor" }).click();
      await taskDetail.getByRole("button", { name: "Close task", exact: true }).click();
      const start = await handle.locator("xpath=ancestor::li").boundingBox();
      const target = await board.getByRole("region", { name: "In progress", exact: true }).boundingBox();
      if (!start || !target) throw new Error("Missing drag geometry");
      const beginDrag = async () => {
        await page.mouse.move(start.x + 12, start.y + 12);
        await page.mouse.down();
        await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 12 });
        await expect(page.locator("[data-drag-preview]")).toBeVisible();
        await expect(board.locator("[data-drop-placeholder]")).toBeVisible();
        await expect(board.getByRole("region", { name: "In progress", exact: true }).locator("ul > li").first()).toHaveAttribute("data-drop-placeholder", "true");
      };
      await beginDrag();
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
      expect(task.status).toBe("needs-action");
      failMove = true;
      await beginDrag();
      await page.mouse.up();
      await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
      expect(task.status).toBe("needs-action");
      await expect(page.getByText("This task could not be updated. It is still unchanged — try again.")).toBeVisible();
      await page.getByRole("button", { name: "Close task editor" }).click();
      failMove = false;
      responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
      await beginDrag();
      await page.mouse.up();
      await expect(page.locator("[data-drag-preview]")).toHaveCount(0);
      await expect(board.getByRole("region", { name: "In progress", exact: true }).getByRole("button", { name: "Kanban review", exact: true })).toBeVisible();
      expect(task.status).toBe("needs-action"); // Server has not responded yet.
      await expect(handle).toBeDisabled();
      await expect(handle).toHaveAttribute("aria-busy", "true");
      await expect(handle).toHaveAttribute("data-loading", "");
      for (const action of await board.getByRole("button", { name: "Add task", exact: true }).all()) {
        await expect(action).toBeDisabled();
        await expect(action).toHaveCSS("opacity", "1");
      }
      releaseResponse?.();
      await expect.poll(() => task.status).toBe("in-process");
    } else {
      await board.getByRole("button", { name: "Kanban review", exact: true }).click();
      await page.getByRole("combobox", { name: "Task status", exact: true }).click();
      await page.getByRole("option", { name: "In progress", exact: true }).click();
      await page.getByRole("button", { name: "Close task", exact: true }).click();
    }
    await expect(board.getByRole("region", { name: "In progress", exact: true }).getByRole("button", { name: /^Kanban review/ })).toBeVisible();
    expect(task.recurrence).toBe("FREQ=WEEKLY");
    await page.getByRole("radio", { name: "List", exact: true }).click();
    await expect(page).toHaveURL(/taskLayout=list/);
    await expect(page.getByRole("heading", { name: "In progress 2", exact: true })).toBeVisible();
  });
}

test("wheel changes only the month view by one period", async ({ page }) => {
  await mockAuthenticatedReads(page);
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
  const area = page.locator("[data-calendar-area]");
  await expect(page.getByRole("grid", { name: /July 2026 calendar/ })).toBeVisible();
  await area.hover({ position: { x: 100, y: 70 } });
  await page.mouse.wheel(0, 100);
  await expect(page).toHaveURL(/date=2026-08-/);
  await page.getByRole("radio", { name: "Day", exact: true }).click();
  const dayURL = page.url();
  await area.hover({ position: { x: 100, y: 200 } });
  await page.mouse.wheel(0, 100);
  await expect(page).toHaveURL(dayURL);
});

for (const kind of ["event", "task"] as const) {
  test(`account search refreshes ${kind} results and their open detail after access changes`, async ({ page }) => {
    await page.addInitScript(() => {
      class SearchStream {
        onmessage: ((event: { data: string }) => void) | null = null;
        constructor() { (window as unknown as { searchStream: SearchStream }).searchStream = this; }
        close() {}
      }
      (window as unknown as { EventSource: unknown }).EventSource = SearchStream;
    });
    await mockAuthenticatedReads(page, { ...events, events: [] }, calendars.map(calendar => ({ ...calendar, role: "reader" })));
    let title = "Private search item";
    let description = "Private search notes";
    let removed = false;
    const item = event("search-event", title, "personal", "#b3492f", "2031-07-20T09:00:00.000Z", "2031-07-20T10:00:00.000Z");
    await page.route("**/api/v1/events?**", route => respond(route, { ...events, events: kind === "event" && !removed ? [{ ...item, title, description }] : [] }));
    await page.route("**/api/v1/events", route => respond(route, { ...events, events: kind === "event" && !removed ? [{ ...item, title, description }] : [] }));
    await page.route("**/api/v1/tasks", route => respond(route, { tasks: kind === "task" && !removed ? [{ id: "search-task", creatorID: "owner", calendarID: "personal", title, description, status: "needs-action", isAllDay: false, sequence: 0, priority: 0, percentComplete: 0 }] : [] }));
    await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
    await page.getByRole("button", { name: "Search events and actions" }).click();
    const palette = page.getByRole("dialog", { name: "Search Musubi" });
    await palette.getByRole("searchbox").fill("Private search");
    await expect(palette.getByRole("button", { name: /Private search item/ })).toBeVisible();
    const refresh = () => page.evaluate(() => (window as unknown as { searchStream: { onmessage: (event: { data: string }) => void } }).searchStream.onmessage({ data: JSON.stringify({ type: "external_sync" }) }));
    title = "Permitted search item"; description = "Permitted search notes";
    await refresh();
    await expect(palette.getByRole("button", { name: /Private search item/ })).toHaveCount(0);
    await palette.getByRole("searchbox").fill("Permitted search");
    await palette.getByRole("button", { name: /Permitted search item/ }).click();
    const detail = page.getByRole("dialog", { name: title, exact: true });
    await expect(detail).toContainText(description);
    await expect(detail.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    title = "Busy"; description = "";
    await refresh();
    await expect(page.getByRole("dialog", { name: "Busy", exact: true })).toBeVisible();
    await expect(page.getByText("Permitted search notes", { exact: true })).toHaveCount(0);
    removed = true;
    await refresh();
    await expect(page.getByText(`This ${kind} is no longer available.`)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Busy", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: kind === "task" ? "Close task" : "Close event", exact: true }).click();
    await expect(page.getByRole("button", { name: "Search events and actions", exact: true })).toBeFocused();
  });
}

test("dated tasks appear in month and week and open task details", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await mockAuthenticatedReads(page);
  let datedTask = {
    id: "calendar-task-fixture", creatorID: "user-web-qa", calendarID: "personal",
    title: "Calendar task deadline", status: "needs-action", start: "2026-07-27T08:00:00.000Z",
    due: "2026-07-28T16:00:00.000Z", isAllDay: false, priority: 5,
    percentComplete: 0, sequence: 0, description: "Task details from the calendar",
  };
  await page.route("**/api/v1/tasks", route => respond(route, { tasks: [datedTask,
    { ...datedTask, id: "undated", title: "Undated task", start: null, due: null },
  ] }));
  await page.route("**/api/v1/tasks/calendar-task-fixture", async route => {
    expect(route.request().method()).toBe("PUT");
    datedTask = { ...datedTask, ...route.request().postDataJSON() };
    await respond(route, datedTask);
  });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-27`);
  const markers = page.locator('[data-event-id^="calendar-task:calendar-task-fixture:"]');
  await expect(markers).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Undated task/ })).toHaveCount(0);
  await expect(markers.first()).not.toHaveAttribute("data-draggable");
  await markers.first().click();
  const detail = page.getByRole("dialog", { name: "Calendar task deadline" });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Task details from the calendar")).toBeVisible();
  await expect(detail.getByRole("combobox", { name: "Task status" })).toBeVisible();
  await detail.getByRole("combobox", { name: "Task status" }).click();
  await page.getByRole("option", { name: "Completed", exact: true }).click();
  await expect(detail.getByRole("combobox", { name: "Task status" })).toContainText("Completed");
  const emptyCell = page.locator('[data-day-key="2026-07-29"]');
  await emptyCell.click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Create event", exact: true })).toHaveCount(0);
  await expect(markers.first()).toHaveAttribute("data-task-completed", "");
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-27`);
  await expect(page.getByRole("button", { name: /Task deadline, Calendar task deadline/ })).toBeVisible();
  await expect(page.locator('[data-time-event="calendar-task:calendar-task-fixture:start"]')).toBeVisible();
  await page.screenshot({ path: "/tmp/musubi-calendar-tasks-web.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /Task deadline, Calendar task deadline/ }).click();
  await expect(page.getByRole("dialog", { name: "Calendar task deadline" })).toBeVisible();
  const mobileDetail = page.getByRole("dialog", { name: "Calendar task deadline" });
  await expect(mobileDetail.getByRole("combobox", { name: "Task status" })).toContainText("Completed");
  expect(datedTask.status).toBe("completed");
  await settleLayout(page);
  await page.screenshot({ path: "/tmp/musubi-calendar-tasks-web-mobile.png" });
  await expect(mobileDetail.getByRole("button", { name: "Close task" })).toBeInViewport();
  expect(errors).toEqual([]);
});


test("a draft in a crowded month cell keeps every chip above the next week", async ({ page }) => {
  await page.setViewportSize({ width: 1455, height: 896 });
  const crowded = Array.from({ length: 8 }, (_, index) => event(
    `draft-crowded-${index}`, `Crowded draft event ${index + 1}`, "personal", "#b3492f",
    `2026-07-23T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
    `2026-07-23T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
  ));
  await mockAuthenticatedReads(page, { ...events, events: crowded });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-07-26`);
  const cell = page.locator('[data-day-key="2026-07-23"]');
  const following = page.locator('[data-day-key="2026-07-30"]');
  const before = await following.boundingBox();
  await cell.click({ position: { x: 14, y: 14 } });
  await expect(cell.locator('[data-draft]')).toHaveCount(1);
  await expect(cell.getByRole("button", { name: /more$/ })).toBeVisible();
  await expect.poll(() => cell.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('[data-event-id], [data-draft], button')]
      .every(item => item.getBoundingClientRect().bottom <= bounds.bottom);
  })).toBe(true);
  expect((await following.boundingBox())!.y).toBeCloseTo(before!.y, 0);
  await expect(page.getByRole("textbox", { name: "Event title" })).toBeVisible();
});

test("toolbar task creation stays in the current week and uses an inspector", async ({ page }) => {
  await mockAuthenticatedReads(page);
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-26`);
  await page.getByRole("button", { name: "Create event, meeting or task" }).click();
  await page.getByRole("menuitem", { name: "Task", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New task" });
  await expect(editor).toBeVisible();
  await expect(page).toHaveURL(/\/week\?date=2026-07-26/);
  await expect(editor.getByRole("heading", { name: "New task" })).toBeVisible();
  const box = await editor.boundingBox();
  expect(box!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await editor.getByRole("button", { name: "Close task editor" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(/\/week\?date=2026-07-26/);
});

test("page item switches persist and separate meetings from events", async ({ page }) => {
  const personal = event("personal-filter", "Personal filter item", "personal", "#b3492f", "2026-08-06T09:00:00Z", "2026-08-06T10:00:00Z");
  const meeting = { ...personal, id: "meeting-filter", title: "Provider meeting filter item", isMeeting: true };
  await mockAuthenticatedReads(page, { ...events, events: [personal, meeting] });
  let savedPage = { ...defaultPage };
  await page.route("**/api/v1/pages", route => respond(route, [savedPage]));
  await page.route("**/api/v1/pages/*", async route => {
    const body = route.request().postDataJSON();
    savedPage = { ...savedPage, config: body.config, name: body.name, revision: savedPage.revision + 1 };
    await respond(route, savedPage);
  });
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/month?date=2026-08-06`);
  await expect(page.getByRole("button", { name: /Personal filter item/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit My calendar" }).click();
  const dialog = page.getByRole("dialog", { name: "Page settings" });
  await dialog.getByRole("switch", { name: "Events", exact: true }).click();
  await dialog.getByRole("switch", { name: "Tasks", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Personal filter item/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Provider meeting filter item/ }).first()).toBeVisible();
  expect(savedPage.config.filters).toEqual([{ type: "item-types", value: ["meetings"] }]);
  const reloadedPages = page.waitForResponse(response => response.url().endsWith("/api/v1/pages") && response.request().method() === "GET");
  await page.reload();
  expect((await (await reloadedPages).json())[0].config.filters).toEqual([{ type: "item-types", value: ["meetings"] }]);
  await expect(page.getByRole("button", { name: /Personal filter item/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Provider meeting filter item/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit My calendar" }).click();
  await expect(dialog.getByRole("switch", { name: "Events", exact: true })).not.toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Meetings", exact: true })).toBeChecked();
});

test("floating event editor preserves its draft, supports movement and nested pickers", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockAuthenticatedReads(page);
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-26`);
  await openCreateEvent(page);
  const editor = page.getByRole("dialog", { name: "Create event", exact: true });
  const title = editor.getByRole("textbox", { name: "Event title" });
  await title.fill("A walk by the river");
  await editor.getByRole("button", { name: "Float window", exact: true }).click();
  await expect(editor).toHaveAttribute("data-presentation", "floating");
  await expect(title).toHaveValue("A walk by the river");
  await settleLayout(page);
  const before = (await editor.boundingBox())!;
  expect(before.width).toBe(540);
  expect(before.x).toBeGreaterThan(24);
  expect(before.y).toBeGreaterThan(24);
  const header = editor.locator('[data-inspector-header]');
  const head = (await header.boundingBox())!;
  await page.mouse.move(head.x + 100, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + 200, head.y + 80, { steps: 8 });
  await page.mouse.up();
  expect((await editor.boundingBox())!.x).toBeCloseTo(before.x + 100, 0);
  expect((await editor.boundingBox())!.y).toBeCloseTo(before.y + 60, 0);
  const mover = editor.getByRole("button", { name: "Move window with arrow keys" });
  await mover.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  expect((await editor.boundingBox())!.x).toBeCloseTo(before.x + 68, 0);
  await page.screenshot({ path: testInfo.outputPath("floating-event.png") });
  await page.setViewportSize({ width: 1050, height: 720 });
  await expect.poll(async () => { const box = (await editor.boundingBox())!; return box.x + box.width <= 1026 && box.y + box.height <= 696; }).toBe(true);
  await expect(title).toHaveValue("A walk by the river");
  // A child picker must remain above and inside the inspector's focus scope.
  await editor.getByRole("button", { name: /^Date:/ }).click();
  await expect(page.getByRole("button", { name: "Today", exact: true }).last()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Dock to side" }).click();
  await expect(editor).toHaveAttribute("data-presentation", "panel");
  await expect(title).toHaveValue("A walk by the river");
  await editor.getByRole("button", { name: "Close new event" }).click();
  await expect(page.getByRole("dialog", { name: "Discard new event?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).last().click();
  await expect(title).toHaveValue("A walk by the river");
});

test("local floating default persists and falls back to a panel on smaller screens", async ({ page }, testInfo) => {
  await setTestTheme(page, "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockAuthenticatedReads(page);
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/week?date=2026-07-26`);
  const writes: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/v1/settings") && request.method() !== "GET") writes.push(request.method()); });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsDialog.getByRole("radio", { name: "Floating window", exact: true }).click();
  expect(writes).toEqual([]);
  await settingsDialog.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath("window-preference.png") });
  await settingsDialog.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Create event, meeting or task" }).click();
  await page.getByRole("menuitem", { name: "Task", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(editor).toHaveAttribute("data-presentation", "floating");
  await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Bring a picnic");
  await editor.getByRole("button", { name: "Dock to side" }).click();
  // Manual docking changes this window, not the browser's default.
  await editor.getByRole("button", { name: "Close task editor" }).click();
  await page.getByRole("button", { name: "Create event, meeting or task" }).click();
  await page.getByRole("menuitem", { name: "Task", exact: true }).click();
  await expect(editor).toHaveAttribute("data-presentation", "floating");
  await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Bring a picnic");
  for (const width of [800, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(editor).toHaveAttribute("data-presentation", width < 1024 ? "panel" : "floating");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Bring a picnic");
    if (width < 1024) {
      await expect(editor).toHaveAttribute("aria-modal", "true");
      await expect(editor.getByRole("button", { name: "Float window" })).toHaveCount(0);
      await expect(editor.getByRole("button", { name: "Dock to side" })).toHaveCount(0);
    }
    await settleLayout(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: testInfo.outputPath(`task-${width}.png`) });
  }
});

test("task inspector keeps compact form spacing at tall heights and retains floating mode when editing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1256 });
  await mockAuthenticatedReads(page);
  const task = { id: "floating-task", creatorID: session.user.id, calendarID: "personal", title: "Pack for the weekend", status: "needs-action", percentComplete: 0, priority: 5, sequence: 0, isAllDay: false, start: null, due: null, completedAt: null };
  await page.route("**/api/v1/tasks", route => respond(route, { tasks: [task] }));
  await page.goto(`/app/p/${DEFAULT_PAGE_ID}/tasks?date=2026-07-26`);
  await page.getByRole("button", { name: "Pack for the weekend Personal", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Pack for the weekend", exact: true });
  await detail.getByRole("button", { name: "Float window" }).click();
  await settleLayout(page);
  for (const name of ["Task status", "Task priority"]) {
    await detail.getByRole("combobox", { name, exact: true }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await detail.getByRole("heading", { name: task.title }).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(detail).toBeVisible();
  }
  await detail.getByRole("button", { name: "Move window with arrow keys" }).focus();
  await page.keyboard.press("Shift+ArrowRight");
  const placement = (await detail.boundingBox())!;
  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit task", exact: true });
  await expect(editor).toHaveAttribute("data-presentation", "floating");
  expect((await editor.boundingBox())!.x).toBeCloseTo(placement.x, 0);
  await editor.getByRole("button", { name: "Dock to side" }).click();
  await settleLayout(page);
  const title = editor.getByRole("textbox", { name: "Title", exact: true });
  const calendar = editor.getByRole("combobox", { name: "Calendar", exact: true });
  const titleBox = (await title.boundingBox())!;
  const calendarBox = (await calendar.boundingBox())!;
  expect(calendarBox.y - titleBox.y - titleBox.height).toBeLessThan(70);
  expect(titleBox.y).toBeLessThan(160);
  await page.screenshot({ path: testInfo.outputPath("task-form-tall.png") });
  await editor.getByRole("button", { name: "Close task editor" }).click();
  await expect(detail).toHaveAttribute("data-presentation", "panel");
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook organizer guarded cancellation: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook review meeting", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "singleInstance", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, actions: ["delete"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook review meeting/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage Outlook meeting", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage Outlook meeting", exact: true });
    await expect(editor.getByRole("button", { name: "Save and notify guests" })).toHaveCount(0);
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Cancel meeting and notify guests" }).click();
    const confirmation = page.getByRole("dialog", { name: "Cancel Outlook meeting", exact: true });
    await expect(confirmation).toContainText("Outlook will be asked to cancel this meeting");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    expect(writes).toHaveLength(0);
    await expectOrganizerPaintedAbovePopover(confirmation);
    await expectNoAccessibilityViolations(page);
    expect(await confirmation.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/outlook-cancellation-${theme}.png` });
    await confirmation.getByRole("button", { name: "Cancel meeting and notify guests" }).press("Enter");
    await expect(confirmation.getByRole("alert")).toContainText("Response lost");
    await confirmation.getByRole("button", { name: "Cancel meeting and notify guests" }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "delete", notificationPolicy: "server-invite", expectedRevision: 4 });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook recurring cancellation keeps scope and request identity: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000371", eventID = "00000000-0000-4000-8000-000000000372";
    const saved = { ...event(eventID, "Weekly Outlook meeting", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4 };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] }, version: "a".repeat(64), outlookCancellation: { calendarID, expectedRevision: 4, seriesVersion: "b".repeat(64), scopes: ["occurrence", "series"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await page.getByRole("button", { name: /Weekly Outlook meeting/ }).first().click();
    const trigger = page.getByRole("button", { name: "Cancel Outlook meeting", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Cancel recurring meeting", exact: true });
    await expect(dialog).toContainText("notify their guests");
    await expect(dialog.getByRole("button", { name: "This and following events" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Entire series", exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);
    await expectOrganizerPaintedAbovePopover(dialog);
    await expectNoAccessibilityViolations(page);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/outlook-recurring-cancel-${theme}.png` });
    await dialog.getByRole("button", { name: "This occurrence", exact: true }).press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("Response lost");
    await expect(dialog.getByRole("button", { name: "Entire series", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "This occurrence", exact: true }).press("Enter");
    const queued = page.getByRole("dialog", { name: "Cancellation queued", exact: true });
    await expect(queued).toContainText("Check Delivery details");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "delete", scope: "occurrence", notificationPolicy: "server-invite", expectedRevision: 4, expectedSeriesVersion: "b".repeat(64) });
    await queued.getByRole("button", { name: "Done", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook organizer content update: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook review meeting", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "singleInstance", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, actions: ["update", "delete"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook review meeting/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage Outlook meeting", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage Outlook meeting", exact: true });
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeEnabled();
    await expect(editor.getByRole("textbox", { name: "Guest email addresses", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Start time", exact: true })).toHaveCount(0);
    await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Updated Outlook meeting");
    await editor.getByRole("textbox", { name: "Notes", exact: true }).fill("Bring the agenda");
    await expectOrganizerPaintedAbovePopover(editor);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-content-${theme}.png` });
    await editor.getByRole("button", { name: "Save and notify guests", exact: true }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Retry saved meeting action", exact: true }).press("Enter");
    await expect(editor.getByRole("status")).toContainText("Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4 });
    expect(writes[0].patch).toEqual({ title: "Updated Outlook meeting", description: "Bring the agenda" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook occurrence content update: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook recurring appointment", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, ...(width === 390 ? { seriesID: "00000000-0000-4000-8000-000000000369", originalStart: { kind: "instant", value: "2026-07-25T09:00:00.000Z" } } : {}), timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: width === 1280 ? [] : [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook recurring appointment/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage this occurrence", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage this occurrence", exact: true });
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeEnabled();
    await expect(editor.getByRole("textbox", { name: "Guest email addresses", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Start time", exact: true })).toHaveCount(0);
    await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Updated Outlook meeting");
    await editor.getByRole("textbox", { name: "Notes", exact: true }).fill("Bring the agenda");
    if (width === 1280) await expect(editor.getByRole("button", { name: "Meeting invitation information" })).toHaveCount(0);
    await expectOrganizerPaintedAbovePopover(editor);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-occurrence-${theme}.png` });
    await editor.getByRole("button", { name: width === 1280 ? "Save" : "Save and notify guests", exact: true }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Retry saved meeting action", exact: true }).press("Enter");
    await expect(editor.getByRole("status")).toContainText(width === 1280 ? "Event change saved" : "Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4, scope: "occurrence", expectedSeriesVersion: "c".repeat(64) });
    expect(writes[0].patch).toEqual({ title: "Updated Outlook meeting", description: "Bring the agenda" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook series content update: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook recurring appointment", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, ...(width === 390 ? { seriesID: "00000000-0000-4000-8000-000000000369", originalStart: { kind: "instant", value: "2026-07-25T09:00:00.000Z" } } : {}), timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: width === 1280 ? [] : [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] }, version: "a".repeat(64), outlookSeriesContent: { calendarID, expectedRevision: 4, seriesVersion: "d".repeat(64), content: { title: "Whole series title", description: "Series notes", location: "Series room" } }, organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook recurring appointment/ }).first().click();
    const trigger = page.getByRole("button", { name: "Edit series", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Edit series", exact: true });
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Whole series title");
    await expect(editor).toContainText("Individual occurrence changes are preserved");
    await expect(editor.getByRole("textbox", { name: "Guest email addresses", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Start time", exact: true })).toHaveCount(0);
    await editor.getByRole("textbox", { name: "Title", exact: true }).fill("Updated Outlook meeting");
    await editor.getByRole("textbox", { name: "Notes", exact: true }).fill("Bring the agenda");
    if (width === 1280) await expect(editor.getByRole("button", { name: "Meeting invitation information" })).toHaveCount(0);
    await expectOrganizerPaintedAbovePopover(editor);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-series-${theme}.png` });
    await editor.getByRole("button", { name: width === 1280 ? "Save" : "Save and notify guests", exact: true }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Retry saved meeting action", exact: true }).press("Enter");
    await expect(editor.getByRole("status")).toContainText(width === 1280 ? "Event change saved" : "Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4, scope: "series", expectedSeriesVersion: "d".repeat(64) });
    expect(writes[0].patch).toEqual({ title: "Updated Outlook meeting", description: "Bring the agenda" });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook occurrence time update: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook recurring appointment", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, ...(width === 390 ? { seriesID: "00000000-0000-4000-8000-000000000369", originalStart: { kind: "instant", value: "2026-07-25T09:00:00.000Z" } } : {}), timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: width === 1280 ? [] : [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"], timeEdit: true, timeZone: "Europe/Prague" } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook recurring appointment/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage this occurrence", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage this occurrence", exact: true });
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeEnabled();
    await expect(editor.getByRole("textbox", { name: "Guest email addresses", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Start time", exact: true })).toHaveCount(0);
    await expect(editor.getByLabel("Start", { exact: true })).toHaveValue("2026-07-26T11:00");
    await expect(editor.getByRole("checkbox", { name: "All day" })).toBeDisabled();
    await editor.getByLabel("Start", { exact: true }).fill("2026-07-26T13:00");
    await editor.getByLabel("End", { exact: true }).fill("2026-07-26T14:00");
    if (width === 1280) await expect(editor.getByRole("button", { name: "Meeting invitation information" })).toHaveCount(0);
    await expectOrganizerPaintedAbovePopover(editor);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-zones-${theme}.png` });
    await editor.getByRole("button", { name: width === 1280 ? "Save" : "Save and notify guests", exact: true }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Retry saved meeting action", exact: true }).press("Enter");
    await expect(editor.getByRole("status")).toContainText(width === 1280 ? "Event change saved" : "Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4, scope: "occurrence", expectedSeriesVersion: "c".repeat(64) });
    expect(writes[0].patch).toEqual({ time: { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-07-26T13:00:00.000", endLocal: "2026-07-26T14:00:00.000" } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook all-day occurrence update: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook all-day appointment", calendarID, "red", "2026-07-26T00:00:00Z", "2026-07-26T00:00:00Z"), revision: 4, isAllDay: true, ...(width === 390 ? { seriesID: "00000000-0000-4000-8000-000000000369", originalStart: { kind: "date", value: "2026-07-25" } } : {}), timeModel: { kind: "all-day" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: width === 1280 ? [] : [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] }, version: "a".repeat(64), organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"], timeEdit: true, timeKind: "all-day" } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook all-day appointment/ }).first().click();
    const trigger = page.getByRole("button", { name: "Manage this occurrence", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Manage this occurrence", exact: true });
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeEnabled();
    await expect(editor.getByRole("textbox", { name: "Guest email addresses", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Start time", exact: true })).toHaveCount(0);
    await expect(editor.getByLabel("Start", { exact: true })).toHaveValue("2026-07-26");
    await expect(editor.getByRole("checkbox", { name: "All day" })).toBeDisabled();
    await editor.getByLabel("Start", { exact: true }).fill("2026-07-27");
    await editor.getByLabel("End", { exact: true }).fill("2026-07-28");
    if (width === 1280) await expect(editor.getByRole("button", { name: "Meeting invitation information" })).toHaveCount(0);
    await expectOrganizerPaintedAbovePopover(editor);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-allday-${theme}.png` });
    await editor.getByRole("button", { name: width === 1280 ? "Save" : "Save and notify guests", exact: true }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Retry saved meeting action", exact: true }).press("Enter");
    await expect(editor.getByRole("status")).toContainText(width === 1280 ? "Event change saved" : "Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4, scope: "occurrence", expectedSeriesVersion: "c".repeat(64) });
    expect(writes[0].patch).toEqual({ time: { kind: "all-day", startDate: "2026-07-27", endDate: "2026-07-28" } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook series time update: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362";
    const saved = { ...event(eventID, "Outlook recurring appointment", calendarID, "red", "2026-07-26T09:00:00Z", "2026-07-26T10:00:00Z"), revision: 4, ...(width === 390 ? { seriesID: "00000000-0000-4000-8000-000000000369", originalStart: { kind: "instant", value: "2026-07-25T09:00:00.000Z" } } : {}), timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-07-26T09:00:00.000", endLocal: "2026-07-26T10:00:00.000" } };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, { state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: width === 1280 ? [] : [{ name: "Guest", role: "required", address: "guest@example.test", self: false, response: "accepted" }], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] }, version: "a".repeat(64), outlookSeriesContent: { calendarID, expectedRevision: 4, seriesVersion: "d".repeat(64), content: { title: "Whole series title", description: "Series notes", location: "Series room" }, time: { kind: "zoned", timeZone: "Pacific/Chatham", startLocal: "2026-07-20T09:00:00", endLocal: "2026-07-20T10:00:00" } }, organizerEdit: { provider: "microsoft", calendarID, expectedRevision: 4, scope: "occurrence", seriesVersion: "c".repeat(64), actions: ["update"] } }));
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/provider-organizer", route => {
      const body = route.request().postDataJSON(); writes.push(body);
      return writes.length === 1 ? respond(route, { error: "Response lost" }, 503) : respond(route, { operationID: body.operationID, eventID, replayed: true, status: "pending", localCommitted: true, notificationDelivery: "unknown" }, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("button", { name: /Outlook recurring appointment/ }).first().click();
    const trigger = page.getByRole("button", { name: "Edit series", exact: true }); await trigger.click();
    const editor = page.getByRole("dialog", { name: "Edit series", exact: true });
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Whole series title");
    await expect(editor).toContainText("Dates stay the same");
    await expect(editor.getByRole("textbox", { name: "Guest email addresses", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Start time", exact: true })).toHaveCount(0);
    await expect(editor.getByLabel("Start", { exact: true })).toHaveValue("09:00:00.000");
    await editor.getByLabel("Start", { exact: true }).fill("13:00");
    await editor.getByLabel("End", { exact: true }).fill("14:30");
    if (width === 1280) await expect(editor.getByRole("button", { name: "Meeting invitation information" })).toHaveCount(0);
    await expectOrganizerPaintedAbovePopover(editor);
    await expectNoAccessibilityViolations(page);
    expect(await editor.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-series-time-${theme}.png` });
    await editor.getByRole("button", { name: width === 1280 ? "Save" : "Save and notify guests", exact: true }).press("Enter");
    await expect(editor.getByRole("alert")).toContainText("Response lost");
    await expect(editor.getByRole("textbox", { name: "Title", exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Cancel meeting and notify guests" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Retry saved meeting action", exact: true }).press("Enter");
    await expect(editor.getByRole("status")).toContainText(width === 1280 ? "Event change saved" : "Guest notification delivery remains unknown");
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]).toMatchObject({ provider: "microsoft", action: "update", notificationPolicy: "server-invite", expectedRevision: 4, scope: "series", expectedSeriesVersion: "d".repeat(64) });
    expect(writes[0].patch).toEqual({ time: { kind: "zoned", timeZone: "Pacific/Chatham", startLocal: "2026-07-20T13:00:00.000", endLocal: "2026-07-20T14:30:00.000" } });
    await editor.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused(); expect(errors).toEqual([]);
  });
}
for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) {
  test(`Outlook selected occurrence move: ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await setTestTheme(page, theme);
    const calendarID = "00000000-0000-4000-8000-000000000361", eventID = "00000000-0000-4000-8000-000000000362", secondID = "00000000-0000-4000-8000-000000000363";
    const saved = { ...event(eventID, "Outlook weekly planning", calendarID, "red", "2026-07-26T07:00:00Z", "2026-07-26T08:00:00Z"), revision: 4 };
    await mockAuthenticatedReads(page, { ...events, events: [saved] }, [{ ...calendars[0]!, id: calendarID, provider: "microsoft", accountID: "fixture", accountLabel: "Fixture" }]);
    await page.route(`**/api/v1/events/${eventID}/provider-state?outlookOrganizer=10&outlookRsvp=2`, route => respond(route, {
      state: { provider: "microsoft", organizer: { name: "Owner", address: "owner@example.test", self: true }, isOrganizer: true, attendees: [], attendeesComplete: true, ownResponse: "organizer", reminders: { provider: "microsoft", isOn: true, minutesBeforeStart: 15 }, availability: "busy", privacy: "normal", status: "active", eventType: "occurrence", conferenceURLs: [] },
      version: "a".repeat(64), outlookOccurrenceMove: { calendarID },
    }));
    const occurrences = [eventID, secondID].map((id, i) => ({ eventID: id, start: `2026-10-0${1 + i * 3}T07:00:00.000Z`, end: `2026-10-0${1 + i * 3}T08:00:00.000Z` }));
    await page.route(`**/api/v1/events/${eventID}/outlook-move/options?outlookOrganizer=10`, route => respond(route, { eventID, calendarID, version: "b".repeat(64), title: "Weekly planning", meeting: width === 390, timeZone: "Pacific/Chatham", preserved: { edited: 1, cancelled: 1, unavailable: 0 }, occurrences }));
    let result: any = null;
    const writes: any[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.route(`**/api/v1/events/${eventID}/outlook-move?outlookOrganizer=10`, route => respond(route, result));
    await page.route("**/api/v1/outlook-moves/preview?outlookOrganizer=10", route => {
      const request = route.request().postDataJSON(); writes.push(request);
      result = { operationID: request.operationID, eventID, title: "Weekly planning", meeting: width === 390, timeZone: "Pacific/Chatham", status: "preview", expiresAt: "2026-09-23T14:00:00Z", offsetMinutes: 30,
        items: occurrences.map(n => ({ ...n, newStart: n.start.replace("07:00", "07:30"), newEnd: n.end.replace("08:00", "08:30"), status: "pending" })) };
      return respond(route, result);
    });
    await page.route("**/api/v1/outlook-moves/*/start?outlookOrganizer=10", route => {
      writes.push({ start: true }); result.status = width === 390 ? "stopped" : "completed";
      result.items[0].status = "completed"; result.items[1].status = width === 390 ? "failed" : "completed";
      return respond(route, result, 202);
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page).toHaveTitle(/Musubi/);
    await page.getByRole("button", { name: /Outlook weekly planning/ }).first().click();
    const trigger = page.getByRole("button", { name: "Move selected occurrences", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Move selected occurrences", exact: true });
    await dialog.getByText("Oct 1, 2026", { exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: /Oct 1, 2026/ })).toBeChecked();
    await dialog.getByRole("checkbox", { name: /Oct 4, 2026/ }).press("Space");
    await expect(dialog.getByRole("checkbox", { name: /Oct 4, 2026/ })).toBeChecked();
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: `/tmp/outlook-move-select-${theme}.png` });
    expect(writes).toHaveLength(0);
    await dialog.getByRole("button", { name: "Preview 2 occurrences" }).press("Enter");
    await expect(dialog).toContainText("20:45–21:45 → 21:15–22:15");
    await expect(dialog).toContainText("The series rule, edited occurrences and cancelled dates stay unchanged.");
    await expectOrganizerPaintedAbovePopover(dialog);
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expectNoAccessibilityViolations(page);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/outlook-move-preview-${theme}.png` });
    expect(writes).toHaveLength(1);
    await dialog.getByRole("button", { name: width === 390 ? "Move 2 occurrences & notify guests" : "Move 2 occurrences", exact: true }).press("Enter");
    await expect(dialog.getByRole("status")).toContainText(width === 390 ? "Move stopped" : "2 occurrences moved");
    if (width === 390) await expect(dialog).toContainText("Not moved");
    await page.screenshot({ path: `/tmp/outlook-move-result-${theme}.png` });
    await dialog.getByRole("button", { name: "Close", exact: true }).press("Space");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.getByRole("status")).toContainText(width === 390 ? "Move stopped" : "2 occurrences moved");
    expect(writes).toHaveLength(2); expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Notifications identify other members and recover delivery: ${theme} desktop`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 916 });
    await setTestTheme(page, theme);
    await mockAuthenticatedReads(page);
    const id = "00000000-0000-4000-8000-000000000501";
    let visible = true;
    const changed = event(id, "Autumn planning", "studio", "red", "2026-10-23T09:00:00Z", "2026-10-23T10:00:00Z", { revision: 3 });
    await page.route("**/api/v1/events", route => respond(route, { events: visible ? [changed] : [], deletedIds: visible ? [] : [id], serverTime: new Date().toISOString() }));
    await page.route("**/api/v1/event-deliveries", route => respond(route, { items: [{ eventId: id, savedTitle: "Autumn planning" }], nextCursor: null }));
    await page.addInitScript(() => {
      class NotificationSource {
        onmessage: ((event: { data: string }) => void) | null = null;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          const host = window as unknown as { __notificationSources: NotificationSource[] };
          host.__notificationSources ??= [];
          host.__notificationSources.push(this);
          setTimeout(() => this.onopen?.(), 0);
        }
        close() {}
      }
      (window as unknown as { EventSource: unknown }).EventSource = NotificationSource;
    });
    await page.goto("/app/p/my-calendar/month?date=2026-07-26");
    await expect(page.getByRole("button", { name: /^Notifications · 1/ })).toBeVisible();
    const emit = async (actorID?: string) => page.evaluate(({ id, actorID }) => {
      const source = (window as unknown as { __notificationSources: { onmessage: (event: { data: string }) => void }[] }).__notificationSources.at(-1)!;
      source.onmessage({ data: JSON.stringify({ type: "event_updated", payload: { id, revision: 3, actorID, title: "Never expose SSE snapshot" } }) });
    }, { id, actorID });
    await emit("user-web-qa");
    await emit();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
    await expect(panel.getByRole("button", { name: /Changed by another member/ })).toHaveCount(0);
    await emit("another-member");
    await expect(panel.getByRole("button", { name: /Autumn planning Changed by another member/ })).toBeVisible();
    await expect(panel).not.toContainText("Never expose SSE snapshot");
    await emit("another-member");
    await expect(panel.getByRole("button", { name: /Changed by another member/ })).toHaveCount(1);
    await expectNoAccessibilityViolations(page);
    await panel.screenshot({ path: `/tmp/musubi-notifications-${theme}.png` });
    await panel.getByRole("button", { name: "Mark all as read" }).click();
    await expect(panel.getByText("1 need attention")).toBeVisible();
    await panel.getByRole("button", { name: /Autumn planning Changed by another member/ }).click();
    const detail = page.getByRole("dialog", { name: "Autumn planning", exact: true });
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Close event", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    visible = false;
    await panel.getByRole("button", { name: "Refresh notifications" }).click();
    await expect(panel.getByRole("button", { name: /Changed by another member/ })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Autumn planning Delivery needs attention/ })).toBeVisible();
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Manual server refresh preserves calendar context: ${theme} desktop`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 916 });
    await setTestTheme(page, theme);
    await mockAuthenticatedReads(page);
    let release: (() => void) | undefined;
    let reads = 0;
    let refreshing = false;
    await page.route("**/api/v1/calendars", async route => {
      reads++;
      if (refreshing) await new Promise<void>(resolve => { release = resolve; });
      await respond(route, calendars);
    });
    await page.goto("/app/p/my-calendar/day?date=2026-07-26");
    const refresh = page.getByRole("button", { name: "Refresh from server", exact: true });
    await expect(refresh).toBeVisible();
    await expect(page.getByText("Connected to server", { exact: true })).toBeVisible();
    const previousReads = reads, url = page.url();
    refreshing = true;
    await refresh.press("Enter");
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => reads).toBeGreaterThan(previousReads);
    expect(page.url()).toBe(url);
    refreshing = false;
    release?.();
    await expect(refresh).toBeEnabled();
    await expect(page.getByText("Connected to server", { exact: true })).toBeVisible();
    await expect(refresh).toBeFocused();
    expect(page.url()).toBe(url);
    await expectNoAccessibilityViolations(page);
  });
}
