import { TaskCreateSchema, TaskUpdateSchema, TaskPatchRequestSchema, TaskMutationResponseSchema, TaskDeleteResponseSchema, TaskDeliverySchema, TaskDeliveryInboxSchema, requireTaskRevision, type Task } from "@musubi/types";
import { ProviderOrganizerCalendarSchema, ProviderRsvpReceiptSchema, type ProviderRsvpEdit, type ProviderOrganizerRequest } from "@musubi/types";
import { ProviderEventStateResponseSchema, ProviderReminderReceiptSchema, type AnyProviderReminderEdit } from "@musubi/types";
import {
  EventScopeResponseSchema,
  EventScopeRequestSchema,
  type EventScopeRequest,
  EventDeliverySchema,
  EventDeliveryInboxSchema,
  EventDeliveryConflictSchema,
  type EventDeliveryResolutionRequest,
  eventCreateOperation,
  type EventWriteRequest,
  eventUpdateOperation,
  requireEventRevision,
} from "@musubi/types";
import {
  AdminAnnouncementsResponseSchema,
  AttendeesResponseSchema,
  CalendarMembersResponseSchema,
  CalendarsResponseSchema,
  EventsResponseSchema,
  FederationConnectionsResponseSchema,
  ImportedCalendarSchema,
  InvitePreviewSchema,
  InvitesResponseSchema,
  PageResponseSchema,
  PagesResponseSchema,
  PushSubscriptionsSchema,
  RemindersResponseSchema,
  RemoveEventResponseSchema,
  ServerCapabilitiesSchema,
  SettingsDocumentResponseSchema,
  SettingsResponseSchema,
  TasksResponseSchema,
} from "./contracts";
import {
  AnnouncementSchema,
  AnnouncementsResponseSchema,
  CalendarSchema,
  EventSchema,
  InviteSchema,
  type AnnouncementInput,
  type Calendar,
  type CreatePageRequest,
  type Event,
  type PatchSettingsRequest,
  type ReminderRule,
  type ReorderPagesRequest,
  type SavePageRequest,
  type TaskCreate,
  type TaskUpdate,
} from "@musubi/types";
import type { AttendanceChoice } from "~/calendar/attendance";
import { z } from "zod";
import { apiRawJsonRequest, apiRequest, apiTextRequest } from "./http";

/**
 * Route a request at a connected Musubi server instead of the home one.
 *
 * Passing a `connectionId` sends it through the home federation gateway, which
 * attaches the member token server-side (ADR-005) — the browser never holds a
 * cross-server credential, and the request stays same-origin.
 */
function route(
  connectionId: string | undefined,
  path: `/api/v1/${string}`,
): `/api/${string}` {
  return connectionId ? `/api/v1/federation/s/${connectionId}${path}` : path;
}

export function getCalendars(signal?: AbortSignal) {
  return apiRequest("/api/v1/calendars", {
    responseSchema: CalendarsResponseSchema,
    signal,
  });
}

export function getEvents(
  range?: { end: Date; start: Date },
  signal?: AbortSignal,
) {
  const search = range
    ? `?${new URLSearchParams({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      })}`
    : "";
  return apiRequest(`/api/v1/events${search}`, {
    responseSchema: EventsResponseSchema,
    signal,
  });
}

export function getTasks(signal?: AbortSignal) {
  return apiRequest("/api/v1/tasks", {
    responseSchema: TasksResponseSchema,
    signal,
  });
}

export async function createTask(task: TaskCreate) {
  const result = await apiRequest("/api/v1/tasks", { body: TaskCreateSchema.parse(task), method: "POST", responseSchema: TaskMutationResponseSchema });
  return result.task;
}

export async function updateTask(id: string, task: TaskUpdate) {
  const { expectedRevision, expectedProviderReadRetiredGeneration } = TaskUpdateSchema.parse(task);
  const patch = TaskCreateSchema.omit({ calendarID: true, id: true }).parse(task);
  const body = TaskPatchRequestSchema.parse({ patch, expectedRevision: requireTaskRevision({ revision: expectedRevision }), expectedProviderReadRetiredGeneration });
  const result = await apiRequest(`/api/v1/tasks/${encodeURIComponent(id)}`, { body, method: "PATCH", responseSchema: TaskMutationResponseSchema });
  return result.task;
}

export function removeTask(task: Task, unlinkCalendarID?: string) {
  return apiRequest(`/api/v1/tasks/${encodeURIComponent(task.id)}`, { body: { expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0, unlinkCalendarID }, method: "DELETE", responseSchema: TaskDeleteResponseSchema });
}

export async function linkTask(task: Task, calendarID: string) {
  const result = await apiRequest(`/api/v1/tasks/${encodeURIComponent(task.id)}/link`, { body: { calendarID, expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 }, method: "POST", responseSchema: TaskMutationResponseSchema });
  return result.task;
}

export async function forkTask(task: Task, calendarID: string, operationId: string) {
  const result = await apiRequest(`/api/v1/tasks/${encodeURIComponent(task.id)}/fork`, { headers: { "Idempotency-Key": operationId }, body: { calendarID, expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 }, method: "POST", responseSchema: TaskMutationResponseSchema });
  return result.task;
}

export function getTaskDelivery(taskId: string, signal?: AbortSignal) {
  return apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/delivery`, { responseSchema: TaskDeliverySchema, signal });
}
export function getTaskDeliveryInbox(cursor?: string, signal?: AbortSignal) {
  const search = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  return apiRequest(`/api/v1/task-deliveries${search}`, { responseSchema: TaskDeliveryInboxSchema, signal });
}
export function retryTaskDelivery(taskId: string, operationId: string) {
  return apiRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/delivery/${encodeURIComponent(operationId)}/retry`, { body: {}, method: "POST", responseSchema: TaskDeliverySchema });
}

export function getPages(signal?: AbortSignal) {
  return apiRequest("/api/v1/pages", {
    responseSchema: PagesResponseSchema,
    signal,
  });
}

export function createPage(request: CreatePageRequest) {
  return apiRequest("/api/v1/pages", {
    body: request,
    method: "POST",
    responseSchema: PageResponseSchema,
  });
}

export function savePage(id: string, request: SavePageRequest) {
  return apiRequest(`/api/v1/pages/${id}`, {
    body: request,
    method: "PATCH",
    responseSchema: PageResponseSchema,
  });
}

export function reorderPages(request: ReorderPagesRequest) {
  return apiRequest("/api/v1/pages/reorder", {
    body: request,
    method: "PUT",
    responseSchema: PagesResponseSchema,
  });
}

export function deletePage(id: string) {
  return apiRequest(`/api/v1/pages/${id}`, {
    method: "DELETE",
    responseSchema: z.object({ id: z.string() }),
  });
}

export function getSettings(signal?: AbortSignal) {
  return apiRequest("/api/v1/users/settings", {
    responseSchema: SettingsResponseSchema,
    signal,
  });
}

export function getSettingsDocument(signal?: AbortSignal) {
  return apiRequest("/api/v1/users/settings/document", {
    responseSchema: SettingsDocumentResponseSchema,
    signal,
  });
}

export function patchSettings(request: PatchSettingsRequest) {
  return apiRequest("/api/v1/users/me/settings", {
    body: request,
    method: "PATCH",
    responseSchema: SettingsDocumentResponseSchema,
  });
}

export function getReminders(signal?: AbortSignal) {
  return apiRequest("/api/v1/reminders", {
    responseSchema: RemindersResponseSchema,
    signal,
  });
}

/** `rule: null` clears an event override, or puts a calendar back to inheriting. */
export function putReminderRule(
  scope: "calendars" | "events",
  id: string,
  rule: ReminderRule | null,
) {
  return apiRequest(`/api/v1/reminders/${scope}/${id}`, {
    body: { rule },
    method: "PUT",
    responseSchema: z.void(),
  });
}

export function subscribePush(subscription: {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}) {
  return apiRequest("/api/v1/push/subscriptions", {
    body: subscription,
    method: "POST",
    responseSchema: z.void(),
  });
}

/**
 * Which subscriptions this server still holds for the reader.
 *
 * Only diagnostics asks. It answers the one question a browser cannot settle on
 * its own: the server drops a subscription the moment a send comes back 410,
 * and never tells the browser, whose own object survives either way.
 */
export function getPushSubscriptions(signal?: AbortSignal) {
  return apiRequest("/api/v1/push/subscriptions", {
    responseSchema: PushSubscriptionsSchema,
    signal,
  });
}

export function unsubscribePush(input: { endpoint: string }) {
  return apiRequest("/api/v1/push/subscriptions", {
    body: input,
    method: "DELETE",
    responseSchema: z.void(),
  });
}

export function createCalendar(calendar: Calendar) {
  return apiRequest("/api/v1/calendars", {
    body: calendar,
    method: "POST",
    responseSchema: CalendarSchema,
  });
}

export function updateCalendar(calendar: Calendar, connectionId?: string) {
  return apiRequest(route(connectionId, "/api/v1/calendars"), {
    body: calendar,
    method: "PUT",
    responseSchema: CalendarSchema,
  });
}

export function removeCalendar(calendar: Calendar, connectionId?: string) {
  return apiRequest(route(connectionId, "/api/v1/calendars"), {
    body: calendar,
    method: "DELETE",
    responseSchema: CalendarSchema,
  });
}

export function importCalendar(
  ics: string,
  name: string,
  color: string,
  provider?: string,
  accountId?: string,
) {
  const query = new URLSearchParams({ color, name });
  if (provider && accountId) {
    query.set("provider", provider);
    query.set("accountId", accountId);
  }
  return apiRawJsonRequest(`/api/v1/calendars/import?${query.toString()}`, {
    body: ics,
    contentType: "text/calendar",
    responseSchema: ImportedCalendarSchema,
  });
}

export function exportCalendar(calendarId: string, connectionId?: string) {
  return apiTextRequest(
    route(connectionId, `/api/v1/calendars/${calendarId}/export`),
  );
}

export function getCalendarMembers(
  calendarId: string,
  signal?: AbortSignal,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/${calendarId}/members`),
    { responseSchema: CalendarMembersResponseSchema, signal },
  );
}

export function getCalendarInvites(
  calendarId: string,
  signal?: AbortSignal,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/${calendarId}/invites`),
    { responseSchema: InvitesResponseSchema, signal },
  );
}

export function createInvite(
  input: {
    calendarID: string;
    expiresAt: Date | null;
    maxUses: number | null;
  },
  connectionId?: string,
) {
  return apiRequest(route(connectionId, "/api/v1/calendars/invites"), {
    // id/uses are server-assigned; the schema still requires them on the wire.
    body: { ...input, id: "new", uses: 0 },
    method: "POST",
    responseSchema: InviteSchema,
  });
}

/** Send an existing invite link to an address. The link itself does not change. */
export function sendInvite(
  inviteId: string,
  email: string,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/invites/${inviteId}/send`),
    { body: { email }, method: "POST", responseSchema: z.void() },
  );
}

export function revokeInvite(inviteId: string, connectionId?: string) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/invites/${inviteId}`),
    { method: "DELETE", responseSchema: z.void() },
  );
}

export function setMemberRole(
  calendarId: string,
  userId: string,
  role: string,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/${calendarId}/members/${userId}`),
    { body: { role }, method: "PUT", responseSchema: z.void() },
  );
}

export function kickMember(
  calendarId: string,
  userId: string,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/${calendarId}/members/${userId}`),
    { method: "DELETE", responseSchema: z.void() },
  );
}

export function leaveCalendar(calendarId: string, connectionId?: string) {
  return apiRequest(
    route(connectionId, `/api/v1/calendars/members/${calendarId}`),
    { method: "DELETE", responseSchema: z.void() },
  );
}

export function uploadAvatar(base64: string) {
  return apiRequest("/api/v1/users/avatar", {
    body: { data: base64 },
    method: "POST",
    responseSchema: z.object({ url: z.string() }),
  });
}

/** Invite preview on this server (the token is the capability — no session needed). */
export function getInvitePreview(token: string, signal?: AbortSignal) {
  return apiRequest(`/api/v1/calendars/tokens/${token}`, {
    responseSchema: InvitePreviewSchema,
    signal,
  });
}

/** Join a calendar on this server. */
export function joinCalendar(calendarId: string, token: string) {
  return apiRequest(`/api/v1/calendars/members/${calendarId}`, {
    body: { token },
    method: "POST",
    responseSchema: z.unknown(),
  });
}

// Cross-server invites: the home server previews and accepts on our behalf, so
// the member token it receives never reaches the browser (ADR-005).
export function getFederatedInvitePreview(
  server: string,
  token: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ server, token });
  return apiRequest(`/api/v1/federation/preview?${query.toString()}`, {
    responseSchema: InvitePreviewSchema,
    signal,
  });
}

export function connectFederatedServer(server: string, token: string) {
  return apiRequest("/api/v1/federation/connect", {
    body: { server, token },
    method: "POST",
    responseSchema: z.object({ server: z.string() }).loose(),
  });
}

export function getFederationConnections(signal?: AbortSignal) {
  return apiRequest("/api/v1/federation/connections", {
    responseSchema: FederationConnectionsResponseSchema,
    signal,
  });
}

// Reads on a connected Musubi server go through the home gateway (ADR-005): the
// member token stays server-side, and the browser stays same-origin.
export function getFederatedCalendars(
  connectionId: string,
  signal?: AbortSignal,
) {
  return apiRequest(`/api/v1/federation/s/${connectionId}/api/v1/calendars`, {
    responseSchema: CalendarsResponseSchema,
    signal,
  });
}

/**
 * What a connected server is running.
 *
 * Through the gateway like everything else, so it needs no new route and no
 * credential in the browser. Federation is the one clock nobody here controls
 * — the peer updates when its owner feels like it — and a version nobody can
 * see is a difference nobody can diagnose.
 */
export function getFederatedServerInfo(
  connectionId: string,
  signal?: AbortSignal,
) {
  return apiRequest(`/api/v1/federation/s/${connectionId}/api/v1/server`, {
    responseSchema: ServerCapabilitiesSchema,
    signal,
  });
}

export function getFederatedEvents(connectionId: string, signal?: AbortSignal) {
  return apiRequest(`/api/v1/federation/s/${connectionId}/api/v1/events`, {
    responseSchema: EventsResponseSchema,
    signal,
  });
}

export function getServerCapabilities(signal?: AbortSignal) {
  return apiRequest("/api/v1/server", {
    responseSchema: ServerCapabilitiesSchema,
    signal,
  });
}

export function connectCaldav(input: {
  password: string;
  serverUrl: string;
  username: string;
}) {
  return apiRequest("/api/v1/users/connections/caldav", {
    body: input,
    method: "POST",
    responseSchema: z.unknown(),
    // Connection includes provider discovery and the initial calendar import.
    timeoutMs: 60_000,
  });
}

// Federated servers are not provider accounts — they have their own connection
// record, so disconnecting one takes the origin rather than a provider+account.
export function disconnectFederatedServer(server: string) {
  return apiRequest("/api/v1/users/connections/musubi", {
    body: { server },
    method: "DELETE",
    responseSchema: z.unknown(),
  });
}

/** Bootstrap a provider, one account, or explicitly refresh all own providers. */
export function syncProviderCalendars(
  input: { provider?: string; accountId?: string } = {},
  signal?: AbortSignal,
) {
  return apiRequest("/api/v1/users/connections/sync", {
    body: input,
    method: "POST",
    responseSchema: z.unknown(),
    signal,
    timeoutMs: 60_000,
  });
}

export function disconnectAccount(input: {
  accountId: string;
  provider: string;
}) {
  return apiRequest("/api/v1/users/connections/disconnect", {
    body: input,
    method: "POST",
    responseSchema: z.unknown(),
  });
}

export function disconnectExternalCalendar(calendarId: string) {
  return apiRequest("/api/v1/users/connections/calendars/disconnect", {
    body: { calendarId },
    method: "POST",
    responseSchema: z.object({ id: z.string() }),
  });
}

export function deleteAccount() {
  // Starts the email-confirmed Better Auth deletion; the account is only
  // removed when the user opens the link we email them.
  return apiRequest("/api/v1/users", {
    method: "DELETE",
    responseSchema: z.void(),
  });
}

export function createEvent(event: EventWriteRequest, connectionId?: string) {
  const operation = eventCreateOperation(event);
  return apiRequest(route(connectionId, `/api/v1${operation.path}`), {
    body: operation.body,
    method: "POST",
    responseSchema: EventSchema,
  });
}

export function updateEvent(event: Event, connectionId?: string) {
  const operation = eventUpdateOperation(event);
  return apiRequest(route(connectionId, `/api/v1${operation.path}`), {
    body: operation.body,
    method: operation.method,
    responseSchema: EventSchema,
  });
}

export function removeEvent(event: Event, connectionId?: string) {
  return apiRequest(route(connectionId, "/api/v1/events"), {
    body: { id: event.id, expectedRevision: requireEventRevision(event) },
    method: "DELETE",
    responseSchema: RemoveEventResponseSchema,
  });
}

export function linkEvent(
  eventId: string,
  expectedRevision: number,
  calendarId: string,
  connectionId?: string,
) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/link`), {
    body: { calendarID: calendarId, expectedRevision },
    method: "POST",
    responseSchema: EventSchema,
  });
}

export function forkEvent(
  eventId: string,
  expectedRevision: number,
  calendarId: string,
  connectionId?: string,
) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/fork`), {
    body: { calendarID: calendarId, expectedRevision },
    method: "POST",
    responseSchema: EventSchema,
  });
}

export function getEventAttendees(
  eventId: string,
  signal?: AbortSignal,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/events/${eventId}/attendees`),
    { responseSchema: AttendeesResponseSchema, signal },
  );
}

export function setAttendance(
  eventId: string,
  status: AttendanceChoice,
  connectionId?: string,
) {
  return apiRequest(
    route(connectionId, `/api/v1/events/${eventId}/attendance`),
    {
      body: { status },
      method: "PUT",
      responseSchema: AttendeesResponseSchema,
    },
  );
}

export function getAnnouncements(signal?: AbortSignal) {
  return apiRequest("/api/v1/announcements", {
    // Ze sdíleného balíčku, ne z lokální kopie — je to týž dokument, jaký
    // parsuje mobil, a jeden tvar znamená jedno místo, kde se mění.
    responseSchema: AnnouncementsResponseSchema,
    signal,
  });
}

export function listAdminAnnouncements() {
  return apiRequest("/api/v1/admin/announcements", {
    responseSchema: AdminAnnouncementsResponseSchema,
  });
}

export function createAnnouncement(input: AnnouncementInput) {
  return apiRequest("/api/v1/admin/announcements", {
    body: input,
    method: "POST",
    responseSchema: AnnouncementSchema,
  });
}

export function updateAnnouncement(id: string, input: AnnouncementInput) {
  return apiRequest(`/api/v1/admin/announcements/${id}`, {
    body: input,
    method: "PATCH",
    responseSchema: AnnouncementSchema,
  });
}

export function removeAnnouncement(id: string) {
  return apiRequest(`/api/v1/admin/announcements/${id}`, {
    method: "DELETE",
    responseSchema: z.object({ deleted: z.boolean() }),
  });
}

export function getEventDelivery(eventId: string, signal?: AbortSignal, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/delivery`), {
    responseSchema: EventDeliverySchema, signal,
  });
}

export function getEventDeliveryInbox(cursor?: string, signal?: AbortSignal, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/event-deliveries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`), {
    responseSchema: EventDeliveryInboxSchema, signal,
  });
}

export function retryEventDelivery(eventId: string, operationId: string, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/delivery/${operationId}/retry`), {
    method: "POST", body: {}, responseSchema: EventDeliverySchema,
  });
}

export function getEventDeliveryConflict(eventId: string, operationId: string, signal?: AbortSignal, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/delivery/${operationId}/conflict`), {
    responseSchema: EventDeliveryConflictSchema, signal,
  });
}

export function resolveEventDelivery(eventId: string, operationId: string, body: EventDeliveryResolutionRequest, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/delivery/${operationId}/resolve`), {
    method: "POST", body, responseSchema: EventDeliverySchema,
  });
}

export function applyEventScope(event: Event, request: EventScopeRequest, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${encodeURIComponent(event.id)}/scope`), { body: EventScopeRequestSchema.parse(request), method: "POST", responseSchema: EventScopeResponseSchema });
}

export function getProviderEventState(eventId: string, signal?: AbortSignal, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${encodeURIComponent(eventId)}/provider-state${connectionId ? "" : "?outlookOrganizer=10&outlookRsvp=2"}`), { responseSchema: ProviderEventStateResponseSchema, signal });
}


export function editProviderReminders(eventId: string, request: AnyProviderReminderEdit, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${encodeURIComponent(eventId)}/provider-reminders`), { method: "POST", body: request, responseSchema: ProviderReminderReceiptSchema });
}

export function editProviderRsvp(eventId: string, request: ProviderRsvpEdit, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${encodeURIComponent(eventId)}/provider-rsvp`), { method: "POST", body: request, responseSchema: ProviderRsvpReceiptSchema });
}

export function discardEventAlarm(eventId: string, operationId: string, expectedRevision: number, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/events/${eventId}/delivery/${operationId}/discard-alarm`), { method: "POST", body: { expectedRevision }, responseSchema: EventDeliverySchema });
}

export function getOrganizerCalendar(calendarId: string, signal?: AbortSignal, connectionId?: string) {
  return apiRequest(route(connectionId, `/api/v1/calendars/${calendarId}/provider-organizer`), { signal, responseSchema: ProviderOrganizerCalendarSchema });
}
export async function editProviderOrganizer(request: ProviderOrganizerRequest, connectionId?: string) {
  const { ProviderOrganizerReceiptSchema } = await import("@musubi/types");
  return apiRequest(route(connectionId, "/api/v1/provider-organizer"), { method: "POST", body: request, responseSchema: ProviderOrganizerReceiptSchema });
}
