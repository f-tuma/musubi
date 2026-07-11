import * as SQLite from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';

const expo = SQLite.openDatabaseSync('db.db');

export const db = drizzle(expo);
// Raw handle for the few reads that must be SYNCHRONOUS (the settings snapshot
// at store creation — the theme has to be right on the very first frame).
export const sqlite = expo;

