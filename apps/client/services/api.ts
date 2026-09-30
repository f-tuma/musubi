import { TaskForkAttempts } from "@musubi/calendar";
import { uuidv7 } from "uuidv7";
import { useTaskRefreshStore } from "@/store/useTaskRefreshStore";
import {
  TaskDeliverySchema,
  TaskMutationResponseSchema, TaskPatchRequestSchema, TaskDeleteResponseSchema, requireTaskRevision,
  TaskSchema, type Task, type TaskStatus, TaskCreateSchema, type TaskCreate, type TaskUpdate,
  ProviderOrganizerCalendarSchema, ProviderOrganizerReceiptSchema, type ProviderOrganizerRequest,
  ProviderRsvpReceiptSchema, type ProviderRsvpEdit,
  ProviderEventStateResponseSchema, ProviderReminderReceiptSchema, type AnyProviderReminderEdit,
  OutlookMoveOptionsSchema, OutlookMoveRequestSchema, OutlookMoveResultSchema, type OutlookMoveRequest,
  AvailabilitySourcesSchema, AvailabilityResponseSchema, AvailabilityRequestSchema, type AvailabilityRequest,
  AnnouncementsResponseSchema,
  CLIENT_VERSION_HEADER,
  PRODUCT_VERSION,
  CalendarInvitePreviewSchema,
  CalendarSchema,
  EventSchema,
  EventDeliverySchema,
  EventDeliveryInboxSchema,
  EventDeliveryConflictSchema,
  type EventDeliveryResolutionRequest,
  eventCreateOperation,
  type EventWriteRequest,
  EventScopeResponseSchema,
  EventScopeRequestSchema,
  type EventScopeRequest,
  eventUpdateOperation,
  requireEventRevision,
  EventMutationError,
  InviteSchema,
  RemindersDocumentSchema,
  SettingsDocumentSchema,
  type Calendar,
  type CalendarInvitePreview,
  type Event,
  type GoogleCheck,
  type Invite,
  type PatchSettingsRequest,
  type RemindersDocument,
  type SettingsDocument,
} from "@musubi/types";
import {
  CalendarsResponse,
  EventsResponse,
  InvitesResponse,
  readWire,
} from "@/services/wire";
import { useServer } from "@/contexts/ServerContext";
import { apiVersion } from "@/constants/url";
import {
  fedFetch,
  remoteForCalendar,
  setHomeRequester,
} from "@/services/federation";
import { setReminderWriter } from "@/services/notifications";
import { OutlookMoveRequestError } from "@/lib/outlookMoveSession";
import { SettingsConflictError } from "@/lib/settingsConflict";
import { notifySessionExpired } from "@/lib/signOut";
import { fetchWithTimeout } from "@/lib/network";
import type { AttendanceChoice } from "@/lib/attendance";

// Federation: calendars shared from another Musubi server live at that server.
// Calendar-scoped calls check the registry and, when the calendar is remote,
// run against its origin with our member token — same endpoints, same shapes.
const remoteOf = (calendarID: string | null | undefined) =>
  remoteForCalendar(calendarID);
const eventHome = (event: Event) =>
  event.originCalendarID ?? event.calendars?.[0];

// Names + avatars only — the API deliberately sends no attendee emails.
export type Attendee = {
  id: string;
  name: string;
  image?: string | null;
  status: "declined" | "going" | "maybe";
};

// Every endpoint below did the same check inline; keep it in one place.
// `asserts error is null` preserves the narrowing the inline `if (error) throw`
// gave — after the call, TS knows `data` is non-null.
function throwOnError(
  error: {
    status?: number | string;
    message?: string;
    statusText?: string;
    error?: unknown;
    reason?: unknown;
    localCommitted?: unknown;
    current?: unknown;
    currentRevision?: unknown;
    code?: unknown;
  } | null,
): asserts error is null {
  if (error) {
    // Dead session — hand off to the recovery flow (registered by the signed-in
    // layout; a no-op on auth screens). Still throws so the caller fails loudly.
    if (error.status === 401) notifySessionExpired();
    console.error("API error", error);
    if (typeof error.localCommitted === "boolean")
      throw EventMutationError.from(error);
    if (
      ["unsupported", "denied", "unknown"].includes(String(error.reason)) &&
      typeof error.error === "string"
    ) {
      throw new Error(error.error); // same server reason as web; keep the draft open
    }
    throw new Error(`${error.status}: ${error.message ?? error.statusText}`);
  }
}

export class EventDeliveryRequestError extends Error {
  constructor(readonly status: number, message: string, readonly organizerAdmissionRejected = false) {
    super(message);
    this.name = "EventDeliveryRequestError";
  }
}

const taskForkAttempts = new TaskForkAttempts(uuidv7);

export function useApi() {
  const { authClient: baseAuthClient, apiUrl } = useServer();
  // Better Auth's facade has no request timeout. Wrap its fetch entry point so
  // a weak connection resolves into the same friendly error path as offline,
  // instead of leaving buttons spinning indefinitely.
  const authClient = {
    async $fetch<T>(url: string, options: any = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const callerSignal = options.signal as AbortSignal | undefined;
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 18_000);
      try {
        return await baseAuthClient.$fetch<T>(url, {
          ...options,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", abort);
      }
    },
  };

  // Federation talks to the home server now (the gateway holds the member
  // token), so hand the registry an authenticated requester. Path-based, so the
  // federation module needs neither apiUrl nor the auth client.
  setHomeRequester(async <T>(path: string, init?: RequestInit) => {
    const { error, data } = await authClient.$fetch<T>(`${apiUrl}${path}`, {
      method: init?.method ?? "GET",
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.body ? { body: init.body } : {}),
    });
    throwOnError(error);
    return data as T;
  });

  // Same reason: a reminder rule is written from modals and background tasks
  // that have no business receiving an api object.
  setReminderWriter(async (scope, id, rule) => {
    const { error } = await authClient.$fetch(
      `${apiUrl}/api/${apiVersion}/reminders/${scope}/${id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule }),
      },
    );
    throwOnError(error);
  });

  // Capture this hook's authenticated requester. Delivery must not use the
  // module-global federation requester, which can belong to a newer identity.
  async function deliveryRequest(path: string, connectionId?: string, body?: unknown) {
    const routed = connectionId ? `/api/v1/federation/s/${encodeURIComponent(connectionId)}${path}` : path;
    const { error, data } = await authClient.$fetch<unknown>(`${apiUrl}${routed}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
    if (error) {
      if (error.status === 401) notifySessionExpired();
      throw new EventDeliveryRequestError(Number(error.status), "Could not verify or change this delivery. Refresh the status and check the connection.", Number(error.status) === 400 && (error as { organizerAdmissionRejected?: unknown }).organizerAdmissionRejected === true);
    }
    return data;
  }

  // Bulk moves belong to this captured home account, never the mutable federation requester.
  async function outlookMoveRequest(path: `/api/v1/${string}`, body?: unknown, signal?: AbortSignal) {
    const { error, data } = await authClient.$fetch<unknown>(`${apiUrl}${path}?outlookOrganizer=10`, {
      method: body === undefined ? "GET" : "POST", signal,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (error) {
      if (Number(error.status) === 401) notifySessionExpired();
      throw new OutlookMoveRequestError(Number(error.status));
    }
    return data;
  }

  async function availabilityRequest(path: string, method: "GET" | "PUT" | "POST", body?: unknown, signal?: AbortSignal) {
    const { error, data } = await authClient.$fetch<unknown>(`${apiUrl}/api/v1/availability${path}`, { method, signal, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    throwOnError(error);
    return data;
  }
  return {
    async getOutlookMoveOptions(eventID: string, signal?: AbortSignal) { return OutlookMoveOptionsSchema.parse(await outlookMoveRequest(`/api/v1/events/${encodeURIComponent(eventID)}/outlook-move/options`, undefined, signal)); },
    async getLatestOutlookMove(eventID: string, signal?: AbortSignal) { return OutlookMoveResultSchema.nullable().parse(await outlookMoveRequest(`/api/v1/events/${encodeURIComponent(eventID)}/outlook-move`, undefined, signal)); },
    async getOutlookMove(operationID: string, signal?: AbortSignal) { return OutlookMoveResultSchema.parse(await outlookMoveRequest(`/api/v1/outlook-moves/${encodeURIComponent(operationID)}`, undefined, signal)); },
    async previewOutlookMove(request: OutlookMoveRequest, signal?: AbortSignal) { return OutlookMoveResultSchema.parse(await outlookMoveRequest("/api/v1/outlook-moves/preview", OutlookMoveRequestSchema.parse(request), signal)); },
    async startOutlookMove(operationID: string, signal?: AbortSignal) { return OutlookMoveResultSchema.parse(await outlookMoveRequest(`/api/v1/outlook-moves/${encodeURIComponent(operationID)}/start`, {}, signal)); },
    async getAvailabilitySources(signal?: AbortSignal) { return AvailabilitySourcesSchema.parse(await availabilityRequest("/sources", "GET", undefined, signal)); },
    async selectAvailabilitySource(id: string, enabled: boolean, expectedGeneration: number, signal?: AbortSignal) { return AvailabilitySourcesSchema.parse(await availabilityRequest(`/sources/${encodeURIComponent(id)}`, "PUT", { enabled, expectedGeneration }, signal)); },
    async getAvailability(range: AvailabilityRequest, signal?: AbortSignal) { return AvailabilityResponseSchema.parse(await availabilityRequest("", "POST", AvailabilityRequestSchema.parse(range), signal)); },
    async getTaskDelivery(taskId: string) { return TaskDeliverySchema.parse(await deliveryRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/delivery`)); },
    async retryTaskDelivery(taskId: string, operationId: string) { return TaskDeliverySchema.parse(await deliveryRequest(`/api/v1/tasks/${encodeURIComponent(taskId)}/delivery/${encodeURIComponent(operationId)}/retry`, undefined, {})); },
    async getEventDelivery(eventId: string, connectionId?: string) {
      return EventDeliverySchema.parse(await deliveryRequest(`/api/v1/events/${eventId}/delivery`, connectionId));
    },
    async getEventDeliveryInbox(cursor?: string, connectionId?: string) {
      return EventDeliveryInboxSchema.parse(await deliveryRequest(`/api/v1/event-deliveries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, connectionId));
    },
    async getEventDeliveryConflict(eventId: string, operationId: string, connectionId?: string) {
      return EventDeliveryConflictSchema.parse(await deliveryRequest(`/api/v1/events/${eventId}/delivery/${operationId}/conflict`, connectionId));
    },
    async discardEventAlarm(eventId: string, operationId: string, expectedRevision: number, connectionId?: string) {
      return EventDeliverySchema.parse(await deliveryRequest(`/api/v1/events/${eventId}/delivery/${operationId}/discard-alarm`, connectionId, { expectedRevision }));
    },
    async getOrganizerCalendar(calendarID: string) { return ProviderOrganizerCalendarSchema.parse(await deliveryRequest(`/api/v1/calendars/${calendarID}/provider-organizer`)); },
    async editProviderOrganizer(request: ProviderOrganizerRequest) { return ProviderOrganizerReceiptSchema.parse(await deliveryRequest("/api/v1/provider-organizer", undefined, request)); },
    async retryEventDelivery(eventId: string, operationId: string, connectionId?: string) {
      return EventDeliverySchema.parse(await deliveryRequest(`/api/v1/events/${eventId}/delivery/${operationId}/retry`, connectionId, {}));
    },
    async resolveEventDelivery(eventId: string, operationId: string, request: EventDeliveryResolutionRequest, connectionId?: string) {
      return EventDeliverySchema.parse(await deliveryRequest(`/api/v1/events/${eventId}/delivery/${operationId}/resolve`, connectionId, request));
    },
    async createCalendar(calendar: Calendar) {
      const { error, data } = await authClient.$fetch<Calendar>(
        `${apiUrl}/api/${apiVersion}/calendars`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(calendar),
        },
      );

      throwOnError(error);

      // Pass the server response through whole — rebuilding the object here
      // silently dropped `role: "owner"`, so the creator didn't get owner
      // actions (invite, roles) until the next full sync.
      return readWire(CalendarSchema, data, "POST /calendars");
    },

    async getTasks(): Promise<Task[]> {
      const { error, data } = await authClient.$fetch<{ tasks: unknown[] }>(`${apiUrl}/api/${apiVersion}/tasks`);
      throwOnError(error);
      return readWire(TaskSchema.array(), data.tasks, "GET /tasks");
    },

    async createTask(task: TaskCreate): Promise<Task | null> {
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(TaskCreateSchema.parse(task)),
      });
      throwOnError(error);
      const result = readWire(TaskMutationResponseSchema, data, "POST /tasks");
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async updateTask(task: Task, update: TaskUpdate): Promise<Task | null> {
      const patch = TaskCreateSchema.omit({ calendarID: true, id: true }).parse(update);
      const body = TaskPatchRequestSchema.parse({ patch, expectedRevision: requireTaskRevision({ revision: update.expectedRevision ?? task.revision }), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 });
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      throwOnError(error);
      const result = readWire(TaskMutationResponseSchema, data, "PATCH /tasks");
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async removeTask(task: Task, unlinkCalendarID?: string): Promise<Task | null> {
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0, unlinkCalendarID }) });
      throwOnError(error);
      const result = readWire(TaskDeleteResponseSchema, data, "DELETE /tasks");
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async linkTask(task: Task, calendarID: string): Promise<Task | null> {
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks/${encodeURIComponent(task.id)}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calendarID, expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 }) });
      throwOnError(error);
      const result = readWire(TaskMutationResponseSchema, data, "POST /tasks/link");
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async forkTask(task: Task, calendarID: string): Promise<Task | null> {
      const session = await baseAuthClient.getSession();
      const actorID = session.data?.user.id;
      if (!actorID) throw new Error("Sign in before copying a task.");
      const operationId = taskForkAttempts.get(JSON.stringify([apiUrl, actorID]), task, calendarID);
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks/${encodeURIComponent(task.id)}/fork`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": operationId }, body: JSON.stringify({ calendarID, expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 }) });
      throwOnError(error);
      const result = readWire(TaskMutationResponseSchema, data, "POST /tasks/fork");
      taskForkAttempts.acknowledge(operationId);
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async setTaskPriority(task: Task, priority: number): Promise<Task | null> {
      const body = TaskPatchRequestSchema.parse({ patch: { priority }, expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 });
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      throwOnError(error);
      const result = readWire(TaskMutationResponseSchema, data, "PATCH /tasks priority");
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async setTaskStatus(task: Task, status: TaskStatus): Promise<Task | null> {
      const body = TaskPatchRequestSchema.parse({ patch: { status, percentComplete: status === "completed" ? 100 : task.status === "completed" ? 0 : task.percentComplete, completedAt: status === "completed" ? task.completedAt ?? new Date() : null }, expectedRevision: requireTaskRevision(task), expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 });
      const { error, data } = await authClient.$fetch(`${apiUrl}/api/${apiVersion}/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      throwOnError(error);
      const result = readWire(TaskMutationResponseSchema, data, "PATCH /tasks status");
      useTaskRefreshStore.getState().refresh();
      return result.task;
    },

    async getCalendars() {
      const { error, data } = await authClient.$fetch<Calendar[]>(
        `${apiUrl}/api/${apiVersion}/calendars`,
        {
          method: "GET",
        },
      );

      throwOnError(error);
      return readWire(CalendarsResponse, data, "GET /calendars");
    },

    async getCalendar(calendarID: string) {
      const { error, data } = await authClient.$fetch<Calendar>(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}`,
        {
          method: "GET",
        },
      );

      throwOnError(error);
      return readWire(CalendarSchema, data, "GET /calendars/:id");
    },

    async getCalendarFromToken(token: string) {
      const { error, data } = await authClient.$fetch<CalendarInvitePreview>(
        `${apiUrl}/api/${apiVersion}/calendars/tokens/${token}`,
        {
          method: "GET",
        },
      );

      throwOnError(error);
      return readWire(
        CalendarInvitePreviewSchema,
        data,
        "GET /calendars/tokens/:token",
      );
    },

    async createEvent(event: EventWriteRequest) {
      const operation = eventCreateOperation(event);
      const remote = remoteOf(eventHome(event));
      if (remote) {
        const data = await fedFetch<Event>(
          remote,
          `/api/${apiVersion}${operation.path}`,
          {
            method: "POST",
            body: JSON.stringify(operation.body),
          },
        );
        return readWire(EventSchema, data, "POST /events (federated)");
      }
      const { error, data } = await authClient.$fetch<Event>(
        `${apiUrl}/api/${apiVersion}${operation.path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(operation.body),
        },
      );

      throwOnError(error);

      return readWire(EventSchema, data, "POST /events");
    },

    async linkEvent(
      eventID: string,
      calendarID: string,
      expectedRevision: number,
    ) {
      const remote = remoteOf(calendarID);
      if (remote) {
        const data = await fedFetch<Event>(
          remote,
          `/api/${apiVersion}/events/${eventID}/link`,
          {
            method: "POST",
            body: JSON.stringify({ calendarID, expectedRevision }),
          },
        );
        return readWire(EventSchema, data, "POST /events/:id/link (federated)");
      }
      const { error, data } = await authClient.$fetch<Event>(
        `${apiUrl}/api/${apiVersion}/events/${eventID}/link`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ calendarID, expectedRevision }),
        },
      );

      throwOnError(error);

      return readWire(EventSchema, data, "POST /events/:id/link");
    },

    async forkEvent(
      eventID: string,
      calendarID: string,
      expectedRevision: number,
    ) {
      const remote = remoteOf(calendarID);
      if (remote) {
        const data = await fedFetch<Event>(
          remote,
          `/api/${apiVersion}/events/${eventID}/fork`,
          {
            method: "POST",
            body: JSON.stringify({ calendarID, expectedRevision }),
          },
        );
        return readWire(EventSchema, data, "POST /events/:id/fork (federated)");
      }
      const { error, data } = await authClient.$fetch<Event>(
        `${apiUrl}/api/${apiVersion}/events/${eventID}/fork`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ calendarID, expectedRevision }),
        },
      );

      throwOnError(error);

      return readWire(EventSchema, data, "POST /events/:id/fork");
    },

    async updateCalendar(calendar: Calendar) {
      const remote = remoteOf(calendar.id);
      if (remote) {
        return readWire(
          CalendarSchema,
          await fedFetch<Calendar>(remote, `/api/${apiVersion}/calendars`, {
            method: "PUT",
            body: JSON.stringify(calendar),
          }),
          "PUT /calendars (federated)",
        );
      }
      const { error, data } = await authClient.$fetch<Calendar>(
        `${apiUrl}/api/${apiVersion}/calendars`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(calendar),
        },
      );
      throwOnError(error);

      return readWire(CalendarSchema, data, "PUT /calendars");
    },

    async removeCalendar(calendar: Calendar) {
      const remote = remoteOf(calendar.id);
      if (remote) {
        const data = await fedFetch<{ id: string }>(
          remote,
          `/api/${apiVersion}/calendars`,
          {
            method: "DELETE",
            body: JSON.stringify(calendar),
          },
        );
        return data.id;
      }
      const { error, data } = await authClient.$fetch<{ id: string }>(
        `${apiUrl}/api/${apiVersion}/calendars`,
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
          },

          body: JSON.stringify(calendar),
        },
      );
      throwOnError(error);

      return data.id;
    },

    async applyEventScope(event: Event, request: EventScopeRequest) {
      const path = `/api/${apiVersion}/events/${encodeURIComponent(event.id)}/scope`;
      const body = JSON.stringify(EventScopeRequestSchema.parse(request));
      const remote = remoteOf(eventHome(event));
      if (remote) return readWire(EventScopeResponseSchema, await fedFetch(remote, path, { method: "POST", body }), "POST event scope (federated)");
      const { error, data } = await authClient.$fetch(`${apiUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
      throwOnError(error);
      return readWire(EventScopeResponseSchema, data, "POST event scope");
    },

    async updateEvent(event: Event) {
      const operation = eventUpdateOperation(event);
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return readWire(
          EventSchema,
          await fedFetch<Event>(remote, `/api/${apiVersion}${operation.path}`, {
            method: operation.method,
            body: JSON.stringify(operation.body),
          }),
          `${operation.method} ${operation.path} (federated)`,
        );
      }
      const { error, data } = await authClient.$fetch<Event>(
        `${apiUrl}/api/${apiVersion}${operation.path}`,
        {
          method: operation.method,
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(operation.body),
        },
      );
      throwOnError(error);

      return readWire(EventSchema, data, `${operation.method} ${operation.path}`);
    },

    async removeEvent(event: Event, unlinkCalendarID?: string) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return fedFetch<{
          id: string;
          calendars: string[];
          removed: boolean;
          revision?: number;
          event?: Event;
        }>(remote, `/api/${apiVersion}/events`, {
          method: "DELETE",
          body: JSON.stringify({
            id: event.id,
            expectedRevision: requireEventRevision(event),
            ...(unlinkCalendarID ? { unlinkCalendarID } : {}),
          }),
        });
      }
      const { error, data } = await authClient.$fetch<{
        id: string;
        calendars: string[];
        removed: boolean;
        revision?: number;
        event?: Event;
      }>(`${apiUrl}/api/${apiVersion}/events`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },

        body: JSON.stringify({
          id: event.id,
          expectedRevision: requireEventRevision(event),
          ...(unlinkCalendarID ? { unlinkCalendarID } : {}),
        }),
      });
      throwOnError(error);

      return data;
    },

    async editProviderReminders(event: Event, request: AnyProviderReminderEdit) {
      const path = `/api/${apiVersion}/events/${encodeURIComponent(event.id)}/provider-reminders`;
      const remote = remoteOf(eventHome(event));
      if (remote) return readWire(ProviderReminderReceiptSchema, await fedFetch(remote, path, { method: "POST", body: JSON.stringify(request) }), "POST provider reminders (federated)");
      const { error, data } = await authClient.$fetch(`${apiUrl}${path}`, { method: "POST", body: request });
      throwOnError(error);
      return readWire(ProviderReminderReceiptSchema, data, "POST provider reminders");
    },
    async editProviderRsvp(event: Event, request: ProviderRsvpEdit) {
      const path = `/api/${apiVersion}/events/${encodeURIComponent(event.id)}/provider-rsvp`;
      const remote = remoteOf(eventHome(event));
      if (remote) return readWire(ProviderRsvpReceiptSchema, await fedFetch(remote, path, { method: "POST", body: JSON.stringify(request) }), "POST provider RSVP (federated)");
      const { error, data } = await authClient.$fetch(`${apiUrl}${path}`, { method: "POST", body: request });
      throwOnError(error);
      return readWire(ProviderRsvpReceiptSchema, data, "POST provider RSVP");
    },

    async getProviderEventState(event: Event) {
      const path = `/api/${apiVersion}/events/${encodeURIComponent(event.id)}/provider-state`;
      const remote = remoteOf(eventHome(event));
      if (remote) return readWire(ProviderEventStateResponseSchema, await fedFetch(remote, path, { method: "GET" }), "GET provider state (federated)");
      const { error, data } = await authClient.$fetch(`${apiUrl}${path}?outlookOrganizer=10&outlookRsvp=2`, { method: "GET" });
      throwOnError(error);
      return readWire(ProviderEventStateResponseSchema, data, "GET provider state");
    },

    async getEventAttendees(event: Event) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return (
          (await fedFetch<Attendee[]>(
            remote,
            `/api/${apiVersion}/events/${event.id}/attendees`,
            { method: "GET" },
          )) ?? []
        );
      }
      const { error, data } = await authClient.$fetch<Attendee[]>(
        `${apiUrl}/api/${apiVersion}/events/${event.id}/attendees`,
        {
          method: "GET",
        },
      );

      throwOnError(error);

      return data ?? [];
    },

    async setAttendance(event: Event, status: AttendanceChoice) {
      const remote = remoteOf(eventHome(event));
      if (remote) {
        return (
          (await fedFetch<Attendee[]>(
            remote,
            `/api/${apiVersion}/events/${event.id}/attendance`,
            {
              method: "PUT",
              body: JSON.stringify({ status }),
            },
          )) ?? []
        );
      }
      const { error, data } = await authClient.$fetch<Attendee[]>(
        `${apiUrl}/api/${apiVersion}/events/${event.id}/attendance`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );

      throwOnError(error);

      return data ?? [];
    },

    async getEvents(since?: Date) {
      const qs = since
        ? `?since=${encodeURIComponent(since.toISOString())}`
        : "";

      const { error, data } = await authClient.$fetch<{
        events: Event[];
        deletedIds: string[];
        serverTime: string;
      }>(`${apiUrl}/api/${apiVersion}/events${qs}`, {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
      });

      throwOnError(error);

      return readWire(EventsResponse, data, "GET /events");
    },

    async createInvite(invite: Invite) {
      const remote = remoteOf(invite.calendarID);
      if (remote) {
        return readWire(
          InviteSchema,
          await fedFetch<Invite>(
            remote,
            `/api/${apiVersion}/calendars/invites`,
            {
              method: "POST",
              body: JSON.stringify(invite),
            },
          ),
          "POST /calendars/invites (federated)",
        );
      }
      const { error, data } = await authClient.$fetch<Invite>(
        `${apiUrl}/api/${apiVersion}/calendars/invites`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(invite),
        },
      );

      throwOnError(error);

      return readWire(InviteSchema, data, "POST /calendars/invites");
    },

    // Raw iCalendar body — plain fetch (the $fetch helpers assume JSON bodies).
    // Home server only: importing always creates a native calendar here.
    async importCalendar(ics: string, name: string, color: string) {
      const { data } = await baseAuthClient.getSession();
      const qs = `?name=${encodeURIComponent(name)}&color=${encodeURIComponent(color)}`;
      const res = await fetchWithTimeout(
        `${apiUrl}/api/${apiVersion}/calendars/import${qs}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data?.session?.token}`,
            [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
            "content-type": "text/calendar",
          },
          body: ics,
        },
      );
      if (!res.ok) throw new Error(`${res.status}: import failed`);
      return res.json() as Promise<Calendar & { imported: number }>;
    },

    // Returns raw ICS text — plain fetch, not $fetch/fedFetch (both assume JSON).
    // A remote calendar is exported through the home gateway, so the home
    // session authenticates it and the member token stays server-side.
    async exportCalendar(calendarID: string): Promise<string> {
      const remote = remoteOf(calendarID);
      const path = remote
        ? `/api/${apiVersion}/federation/s/${remote.id}/api/${apiVersion}/calendars/${calendarID}/export`
        : `/api/${apiVersion}/calendars/${calendarID}/export`;
      const token = (await baseAuthClient.getSession()).data?.session?.token;
      const res = await fetchWithTimeout(`${apiUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
        },
      });
      if (!res.ok) throw new Error(`${res.status}: export failed`);
      return res.text();
    },

    async getInvites(calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        return readWire(
          InvitesResponse,
          (await fedFetch<Invite[]>(
            remote,
            `/api/${apiVersion}/calendars/${calendarID}/invites`,
            { method: "GET" },
          )) ?? [],
          "GET /calendars/:id/invites (federated)",
        );
      }
      const { error, data } = await authClient.$fetch<Invite[]>(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/invites`,
        {
          method: "GET",
        },
      );

      throwOnError(error);

      return readWire(
        InvitesResponse,
        data ?? [],
        "GET /calendars/:id/invites",
      );
    },

    async revokeInvite(calendarID: string, inviteID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(
          remote,
          `/api/${apiVersion}/calendars/invites/${inviteID}`,
          { method: "DELETE" },
        );
        return true;
      }
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/invites/${inviteID}`,
        {
          method: "DELETE",
        },
      );

      throwOnError(error);

      return true;
    },

    async acceptInvite(calendarID: string, token: string) {
      const { error, data } = await authClient.$fetch<Invite>(
        `${apiUrl}/api/${apiVersion}/calendars/members/${calendarID}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );

      throwOnError(error);

      return data;
    },

    async uploadAvatar(base64: string) {
      const { error, data } = await authClient.$fetch<{ url: string }>(
        `${apiUrl}/api/${apiVersion}/users/avatar`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: base64 }),
        },
      );

      throwOnError(error);
      return data.url;
    },

    async leaveCalendar(calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(
          remote,
          `/api/${apiVersion}/calendars/members/${calendarID}`,
          { method: "DELETE" },
        );
        return true;
      }
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/members/${calendarID}`,
        {
          method: "DELETE",
        },
      );

      throwOnError(error);

      return true;
    },

    async getCalendarMembers(calendarID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        return (
          (await fedFetch<
            { id: string; name: string; image?: string | null; role: string }[]
          >(remote, `/api/${apiVersion}/calendars/${calendarID}/members`, {
            method: "GET",
          })) ?? []
        );
      }
      const { data, error } = await authClient.$fetch<
        { id: string; name: string; image?: string | null; role: string }[]
      >(`${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members`, {
        method: "GET",
      });

      throwOnError(error);

      return data ?? [];
    },

    async setMemberRole(
      calendarID: string,
      userID: string,
      role: "viewer" | "editor" | "owner",
    ) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(
          remote,
          `/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
          {
            method: "PUT",
            body: JSON.stringify({ role }),
          },
        );
        return true;
      }
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
        { method: "PUT", body: { role } },
      );

      throwOnError(error);

      return true;
    },

    async removeMember(calendarID: string, userID: string) {
      const remote = remoteOf(calendarID);
      if (remote) {
        await fedFetch(
          remote,
          `/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
          { method: "DELETE" },
        );
        return true;
      }
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/calendars/${calendarID}/members/${userID}`,
        { method: "DELETE" },
      );

      throwOnError(error);

      return true;
    },

    // Reminder rules — one document, because every client needs all of them to
    // resolve anything and they are only the explicit choices.
    /**
     * The reminder rules, or null on a server too old to have them.
     *
     * A 404 here is not a failure, it is an older server answering honestly —
     * self-hosted installs update on their admin's schedule, not the app
     * store's. Returning null lets the caller fall back to what such a server
     * DOES provide, instead of the app quietly scheduling nothing.
     */
    async getReminders() {
      const { data, error } = await authClient.$fetch<RemindersDocument>(
        `${apiUrl}/api/${apiVersion}/reminders`,
        { method: "GET" },
      );

      if (Number(error?.status) === 404) return null;
      throwOnError(error);

      return readWire(RemindersDocumentSchema, data, "GET /reminders");
    },

    async getSettingsDocument() {
      const { data, error } = await authClient.$fetch<SettingsDocument>(
        `${apiUrl}/api/${apiVersion}/users/settings/document`,
        {
          method: "GET",
        },
      );

      throwOnError(error);

      return readWire(
        SettingsDocumentSchema,
        data,
        "GET /users/settings/document",
      );
    },

    async patchSettings(request: PatchSettingsRequest) {
      const { data, error } = await authClient.$fetch<SettingsDocument>(
        `${apiUrl}/api/${apiVersion}/users/me/settings`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        },
      );

      if (Number(error?.status) === 409) throw new SettingsConflictError();
      throwOnError(error);

      return readWire(SettingsDocumentSchema, data, "PATCH /users/me/settings");
    },

    async getAnnouncements() {
      const { error, data } = await authClient.$fetch<unknown>(
        `${apiUrl}/api/${apiVersion}/announcements`,
        {},
      );
      throwOnError(error);
      return readWire(
        AnnouncementsResponseSchema,
        data,
        "/api/v1/announcements",
      );
    },

    async deleteUser() {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users`,
        {
          method: "DELETE",
        },
      );

      throwOnError(error);

      return true;
    },

    async checkGoogleStatus() {
      const { error, data } = await authClient.$fetch<GoogleCheck>(
        `${apiUrl}/api/${apiVersion}/users/connections/google`,
        {
          method: "GET",
        },
      );

      throwOnError(error);

      return data;
    },

    async revokeGoogleConnection() {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/google/revoke`,
        {
          method: "POST",
        },
      );

      throwOnError(error);

      const data = await this.checkGoogleStatus();

      return data;
    },

    async syncProviderCalendars(
      input: { provider?: string; accountId?: string } = {},
    ) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/sync`,
        {
          method: "POST",
          body: input,
        },
      );

      throwOnError(error);
    },

    async connectCaldav(serverUrl: string, username: string, password: string) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/caldav`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverUrl, username, password }),
        },
      );

      throwOnError(error);
    },

    async getCaldavAccounts() {
      const { error, data } = await authClient.$fetch<{
        accounts: { id: string; serverUrl: string; username: string }[];
      }>(`${apiUrl}/api/${apiVersion}/users/connections/caldav`, {
        method: "GET",
      });

      throwOnError(error);

      return data.accounts;
    },

    async disconnectCaldav(accountId: string) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/caldav`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId }),
        },
      );

      throwOnError(error);
    },

    // Federated connections live on the HOME server. Listing and writing them
    // with the raw member token is gone (ADR-005): the registry is read from
    // `/federation/connections`, and the connection is created by
    // `/federation/connect`, both without a credential ever reaching this device.
    async deleteMusubiAccount(server: string) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/musubi`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ server }),
        },
      );
      throwOnError(error);
      return true;
    },

    async disconnectAccount(provider: string, accountId: string) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/disconnect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, accountId }),
        },
      );

      throwOnError(error);
    },

    // Stop syncing ONE external calendar (drop its mirror) without disconnecting
    // the account or touching the calendar on the provider.
    async disconnectExternalCalendar(calendarId: string) {
      const { error } = await authClient.$fetch(
        `${apiUrl}/api/${apiVersion}/users/connections/calendars/disconnect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendarId }),
        },
      );

      throwOnError(error);
    },
  };
}
