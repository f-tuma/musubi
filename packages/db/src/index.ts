import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '@musubi/config';
import * as schema from './schema';
export * from './queries/calendars';
export * from './queries/users';
export * from './queries/events';
export * from './queries/event-outbox';
export * from './queries/event-delivery-status';
export * from './queries/event-delivery-inbox';
export * from './queries/event-delivery-retry';
export * from './queries/event-delivery-resolution';
export * from './queries/event-outbox-delivery';
export * from './queries/event-outbox-projection';
export * from './queries/event-outbox-deletions';
export * from './queries/invites';
export * from './queries/sessions';
export * from './queries/settings';
export * from './queries/reminders';
export * from './queries/push';
export * from './queries/notifications';
export * from './queries/pages';
export * from './queries/external';
export * from './queries/caldav';
export * from './queries/oauth';
export * from './queries/federation';
export * from './queries/announcements';
export * from './queries/tasks';
export * from './queries/task-outbox';
export * from './queries/task-delivery-status';
export * from './schema';
export * as schema from './schema';

export const db = drizzle(config.db.databaseUrl, { schema });
export * from './queries/event-time-edit';
export * from "./queries/event-time-create";
export * from './queries/event-scope';
export * from './queries/provider-event-state';
export * from "./queries/provider-reminders";

export type { GoogleOccurrenceContext, GoogleOccurrencePrepared, GoogleOccurrenceIntent } from "./queries/google-occurrence-scope";

export * from "./queries/caldav-series-scope";
export * from "./queries/caldav-split";
export * from "./queries/caldav-split-delivery";

export * from "./queries/provider-rsvp";
export * from "./queries/graph-rsvp-occurrence";

export * from "./queries/graph-family";

export * from "./queries/graph-series-create";

export * from "./queries/event-create-receipt";

export * from "./queries/provider-reminder-instance";

export * from "./queries/external-access";

export * from "./queries/google-mirror-removal";

export * from "./queries/caldav-alarms";
export * from "./queries/availability";

export * from "./queries/microsoft-access";
export * from "./queries/provider-organizer";
export * from "./queries/outlook-moves";
export * from "./queries/outlook-move-plan";


export * from "./queries/caldav-access";

export * from "./queries/graph-series-delete";
export * from "./queries/graph-meeting-cancel";

export * from "./queries/graph-occurrence-content";
export * from "./queries/graph-series-time";
