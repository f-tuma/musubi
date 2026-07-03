import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '@musubi/config';
import * as schema from './schema';
export * from './queries/calendars';
export * from './queries/users';
export * from './queries/events';
export * from './queries/invites';
export * from './queries/sessions';
export * from './queries/settings';
export * from './queries/google';
export * from './schema';
export * as schema from './schema';

export const db = drizzle(config.db.databaseUrl, { schema });
