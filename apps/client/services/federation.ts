// Federation (Musubi ↔ Musubi), client side. After accepting a cross-server
// invite the app holds a member token for that server and pulls the shared
// calendar(s) alongside the home server's data. Mutations for those calendars
// are routed to their origin server (see services/api.ts).
//
// Registry lives here (not in a store) so services/api.ts can consult it
// without importing stores — the stores import useApi, which would cycle.
import * as SecureStore from "expo-secure-store";
import {
  Calendar,
  CalendarInvitePreview,
  Event,
  shouldRotateMemberToken,
} from "@musubi/types";
import { fetchWithTimeout } from "@/lib/network";

export type FederatedAccount = {
  server: string;   // origin server URL, e.g. https://musubi.example.com
  token: string;    // member token (bearer) issued by that server on accept
  userID: string;   // our shadow-user id on that server
};

const STORE_KEY = "FEDERATED_ACCOUNTS";

let accounts: FederatedAccount[] = [];
let loaded = false;
// calendarID → owning account; rebuilt on every sync so api.ts can route writes
const calendarOrigin = new Map<string, FederatedAccount>();

export async function loadFederatedAccounts(): Promise<FederatedAccount[]> {
  if (!loaded) {
    try {
      accounts = JSON.parse(await SecureStore.getItemAsync(STORE_KEY) ?? "[]");
    } catch {
      accounts = [];
    }
    loaded = true;
  }
  return accounts;
}

async function persist() {
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(accounts));
}

export async function addFederatedAccount(acc: FederatedAccount) {
  await loadFederatedAccounts();
  accounts = [...accounts.filter(a => a.server !== acc.server), acc];
  await persist();
}

/**
 * Replace the registry from the home server — the source of truth, so a
 * connection accepted on one device roams to all of them. SecureStore stays as
 * the offline fallback cache.
 */
export async function setFederatedAccounts(accs: FederatedAccount[]) {
  accounts = accs;
  loaded = true;
  await persist();
}

export async function removeFederatedAccount(server: string) {
  await loadFederatedAccounts();
  accounts = accounts.filter(a => a.server !== server);
  for (const [id, acc] of calendarOrigin) if (acc.server === server) calendarOrigin.delete(id);
  await persist();
}

/** The remote account owning this calendar, or null for home calendars. */
export function remoteForCalendar(calendarID: string | null | undefined): FederatedAccount | null {
  if (!calendarID) return null;
  return calendarOrigin.get(calendarID) ?? null;
}

/** Authenticated JSON request against a federated server. Throws like the home api. */
export async function fedFetch<T>(acc: FederatedAccount, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(`${acc.server}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${acc.token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    console.error("Federation API error", acc.server, path, res.status, body);
    throw new Error(`${res.status}: ${body?.error ?? res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const reviveEvent = (e: any): Event => ({ ...e, start: new Date(e.start), end: new Date(e.end) });
const revivePreviewEvent = (e: any) => ({ ...e, start: new Date(e.start), end: new Date(e.end) });

async function rotateFederatedAccount(acc: FederatedAccount): Promise<FederatedAccount> {
  const res = await fetchWithTimeout(`${acc.server}/api/v1/federation/token/rotate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${acc.token}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`${res.status}: ${body?.error ?? res.statusText}`);
  }

  const { memberToken } = await res.json();
  if (typeof memberToken !== "string") throw new Error("Origin returned an invalid member token.");
  const rotated = { ...acc, token: memberToken };
  await addFederatedAccount(rotated);
  return rotated;
}

/** Public invite preview on a remote server (the token is the credential). */
export async function fetchRemoteCalendarPreview(server: string, inviteToken: string) {
  const res = await fetchWithTimeout(`${server}/api/v1/calendars/tokens/${inviteToken}`);
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  const data = await res.json() as CalendarInvitePreview;
  return { ...data, events: (data.events ?? []).map(revivePreviewEvent) };
}

/**
 * Accept a cross-server invite: the origin server verifies the invite token,
 * creates/reuses our shadow account there, adds us as a member (viewer — the
 * owner promotes us natively) and returns a member token we store for sync.
 */
export async function acceptRemoteInvite(
  server: string,
  inviteToken: string,
  profile: { name: string; email: string; image?: string | null; homeServer: string },
) {
  // A current token proves control of the existing shadow identity. Without
  // it, the origin creates an isolated shadow instead of trusting profile
  // claims to find somebody else's account.
  const existing = (await loadFederatedAccounts()).find(account => account.server === server);
  const res = await fetchWithTimeout(`${server}/api/v1/federation/accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(existing ? { Authorization: `Bearer ${existing.token}` } : {}),
    },
    body: JSON.stringify({ token: inviteToken, profile }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`${res.status}: ${body?.error ?? res.statusText}`);
  }
  const { memberToken, userID, calendar } = await res.json();
  const acc: FederatedAccount = { server, token: memberToken, userID };
  await addFederatedAccount(acc);
  return { account: acc, calendar: calendar as Calendar };
}

/**
 * Pull calendars + events from every federated server (v1: full fetch, no
 * delta). A server that's down keeps its previously cached calendars via
 * `fallbackCalendars` so a temporary outage doesn't wipe local copies.
 */
export async function syncFederatedAccounts(fallbackCalendars: Calendar[]) {
  await loadFederatedAccounts();
  const calendars: Calendar[] = [];
  const events: Event[] = [];
  const syncedServers = new Set<string>();
  const rotatedAccounts: FederatedAccount[] = [];

  for (const storedAccount of [...accounts]) {
    let acc = storedAccount;
    const host = acc.server.replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
    try {
      if (shouldRotateMemberToken(acc.token)) {
        try {
          acc = await rotateFederatedAccount(acc);
          rotatedAccounts.push(acc);
        } catch (error) {
          // Backward compatibility: an older origin has no rotate route.
          // Keep using the still-valid old token; a genuine expiry will then
          // fail the normal authenticated fetch below.
          console.warn(`Federated token rotation failed for ${host}:`, error);
        }
      }
      const cals = await fedFetch<Calendar[]>(acc, "/api/v1/calendars");
      const tagged = cals.map(c => ({
        ...c,
        provider: "musubi",       // groups them in the calendar list UI
        serverUrl: acc.server,    // lets the app show + route by origin
        accountLabel: host,
      }));
      const { events: evs } = await fedFetch<{ events: any[] }>(acc, "/api/v1/events");
      for (const c of tagged) calendarOrigin.set(c.id, acc);
      calendars.push(...tagged);
      events.push(...evs.map(reviveEvent));
      syncedServers.add(acc.server);
    } catch (e) {
      console.warn(`Federated sync failed for ${host}:`, e);
      // keep the last known calendars so the reconcile pass doesn't drop them
      const cached = fallbackCalendars.filter(c => c.provider === "musubi" && c.serverUrl === acc.server);
      for (const c of cached) calendarOrigin.set(c.id, acc);
      calendars.push(...cached);
    }
  }
  return { calendars, events, syncedServers, rotatedAccounts };
}
