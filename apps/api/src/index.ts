import { config, logger } from "@musubi/config";
import { auth } from "@musubi/auth";
import { deleteExpiredInvites, deleteExpiredMemberTokens, deleteExpiredSessions, purgeDeletedEvents } from "@musubi/db";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import cors from "cors";
import { middlewareErrorHandler } from "./middleware/error_handler";
import { handlerCreateCalendar, handlerGetCalendars, handlerGetCalendar, handlerRemoveCalendar, handlerUpdateCalendar, handlerJoinCalendar, handlerLeaveCalendar, handlerExportCalendar, handlerImportCalendar, handlerGetCalendarFromToken, handlerGetCalendarMembers, handlerSetMemberRole, handlerKickMember } from "./handlers/calendars";
import { handlerConfirmDeleteUser, handlerDeleteUser, handlerGetAvatar, handlerResetUsers, handlerUploadAvatar } from "./handlers/users";
import { handlerCreateEvent, handlerForkEvent, handlerGetAttendees, handlerGetEvents, handlerLinkEvent, handlerRemoveEvent, handlerSetAttendance, handlerUpdateEvent } from "./handlers/events";
import { requireAuth } from "./middleware/require_auth";
import { rateLimit } from "./middleware/rate_limit";
import { handlerCreateCalendarInvite, handlerGetCalendarInvites, handlerRevokeInvite } from "./handlers/invites";
import { handlerStream } from "./handlers/stream";
import { middlewareLogHandler } from "./middleware/log_handler";
import { handlerGetSettings, handlerSaveSettings } from "./handlers/settings";
import { handlerAppleAppSiteAssociation, handlerServer, handlerServerStatus } from "./handlers/server";
import { handlerResetPasswordPage, handlerDeleteAccountPage } from "./handlers/pages";
import { handlerCheckGoogleStatus, handlerGetGoogleCalendars, handlerRevokeGoogle } from "./handlers/google";
import { handlerCheckCaldavStatus, handlerConnectCaldav, handlerDisconnectCaldav } from "./handlers/caldav";
import { handlerDisconnectAccount, handlerDisconnectExternalCalendar } from "./handlers/connections";
import { handlerDeleteMusubiAccount, handlerFederationAccept, handlerFederationRotateToken, handlerGetMusubiAccounts, handlerInvitePage, handlerSaveMusubiAccount } from "./handlers/federation";
import { syncUser } from "./sync/engine";
import { getExternalSyncUserIDs } from "@musubi/db";
import { middlewareMetrics, recordExternalSyncFailure, startMetricsServer } from "./metrics";

const app = express()
const port = config.api.port;

const allowedOrigins = [
  config.api.url,
  ...(config.api.environment === "dev" ? ["http://localhost:3000", "http://localhost:8081"] : []),
];

// ── Middleware ────────────────────────────────────────────────────────────────

// First so even parser/CORS failures are measured and receive a correlation id.
app.use(middlewareMetrics);
app.use(middlewareLogHandler);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: "512kb" })); // avatars arrive as base64 JSON

// Better Auth owns everything under /api/auth (sign-in/up, sessions, reset).
app.all("/api/auth/{*any}", toNodeHandler(auth));

// ── Routes ────────────────────────────────────────────────────────────────────
// `wrap` adapts an async handler to Express: a rejected promise is forwarded to
// the error middleware (below) instead of crashing the process. Per route it's
// `requireAuth` first (dropped for the few public ones), then `wrap(handler)`.
// Grouped by resource to mirror docs/reference/server.mdx.
const wrap = (handler: (req: any, res: any) => Promise<unknown>): express.RequestHandler =>
  (req, res, next) => { Promise.resolve(handler(req, res)).catch(next); };

// Server (public)
app.get("/api/v1/server", handlerServer);
app.get("/api/v1/server/ok", handlerServerStatus);

// Realtime — Server-Sent Events. Kept outside /api/v1 to match the client's
// EventSource URL (`${apiUrl}/api/stream`). Holds the connection open and
// registers it for notifyCalendarMembers() broadcasts.
app.get("/api/stream", requireAuth, wrap(handlerStream));

// Federation (Musubi ↔ Musubi) — cross-server invite accept (public: the invite
// token is the credential) and the HTML hand-off page for invite links, so every
// server serves its own deep links (no dependency on the hosted domain).
// Public + creates accounts/tokens — cap per-IP so tokens can't be farmed or guessed.
app.post("/api/v1/federation/accept", rateLimit(10, 15 * 60_000), wrap(handlerFederationAccept));
app.post("/api/v1/federation/token/rotate", requireAuth, wrap(handlerFederationRotateToken));
app.get("/invite/:token", handlerInvitePage(config.api.url));
// Self-hosted auth pages — the reset/delete emails link here on this API's own
// origin, so nothing depends on the central website. Public, no auth (the token
// in the query string is the credential, read client-side).
app.get("/reset-password", handlerResetPasswordPage);
app.get("/delete-account", handlerDeleteAccountPage);
// iOS universal links — must live at the domain root, public, no auth.
app.get("/.well-known/apple-app-site-association", handlerAppleAppSiteAssociation);
// The user's connections to other Musubi servers (member tokens, encrypted at
// rest) — stored home-side so a connection accepted on one device roams to all.
app.get("/api/v1/users/connections/musubi", requireAuth, wrap(handlerGetMusubiAccounts));
app.post("/api/v1/users/connections/musubi", requireAuth, wrap(handlerSaveMusubiAccount));
app.delete("/api/v1/users/connections/musubi", requireAuth, wrap(handlerDeleteMusubiAccount));

// Events
app.get("/api/v1/events", requireAuth, wrap(handlerGetEvents));
app.post("/api/v1/events", requireAuth, wrap(handlerCreateEvent));
app.put("/api/v1/events", requireAuth, wrap(handlerUpdateEvent));
app.delete("/api/v1/events", requireAuth, wrap(handlerRemoveEvent));
app.post("/api/v1/events/:eventId/link", requireAuth, wrap(handlerLinkEvent));
app.post("/api/v1/events/:eventId/fork", requireAuth, wrap(handlerForkEvent));
app.get("/api/v1/events/:eventId/attendees", requireAuth, wrap(handlerGetAttendees));
app.put("/api/v1/events/:eventId/attendance", requireAuth, wrap(handlerSetAttendance));

// Calendars — /google must stay before /:id (both one-segment GETs)
app.get("/api/v1/calendars", requireAuth, wrap(handlerGetCalendars));
app.get("/api/v1/calendars/google", requireAuth, wrap(handlerGetGoogleCalendars));
// Public: possession of the (unguessable, expiring) invite token IS the
// credential — cross-server invitees have no session here yet.
app.get("/api/v1/calendars/tokens/:token", rateLimit(30, 15 * 60_000), wrap(handlerGetCalendarFromToken));
app.get("/api/v1/calendars/:id/export", requireAuth, wrap(handlerExportCalendar)); // .ics snapshot
app.get("/api/v1/calendars/:id", requireAuth, wrap(handlerGetCalendar));
app.post("/api/v1/calendars", requireAuth, wrap(handlerCreateCalendar));
// Raw iCalendar body — its own text parser (the global 512 KB JSON cap is too small)
app.post("/api/v1/calendars/import", requireAuth, express.text({ type: "*/*", limit: "10mb" }), wrap(handlerImportCalendar));
app.put("/api/v1/calendars", requireAuth, wrap(handlerUpdateCalendar));
app.delete("/api/v1/calendars", requireAuth, wrap(handlerRemoveCalendar));

// Members & invites
app.post("/api/v1/calendars/invites", requireAuth, wrap(handlerCreateCalendarInvite));
app.get("/api/v1/calendars/:calendarId/invites", requireAuth, wrap(handlerGetCalendarInvites));
app.delete("/api/v1/calendars/invites/:inviteId", requireAuth, wrap(handlerRevokeInvite));
app.get("/api/v1/calendars/:calendarId/members", requireAuth, wrap(handlerGetCalendarMembers));
app.post("/api/v1/calendars/members/:calendarId", requireAuth, wrap(handlerJoinCalendar));
app.delete("/api/v1/calendars/members/:calendarId", requireAuth, wrap(handlerLeaveCalendar));
app.put("/api/v1/calendars/:calendarId/members/:userId", requireAuth, wrap(handlerSetMemberRole));
app.delete("/api/v1/calendars/:calendarId/members/:userId", requireAuth, wrap(handlerKickMember));

// Users & connections
app.get("/api/v1/users/settings", requireAuth, wrap(handlerGetSettings));
app.put("/api/v1/users/settings", requireAuth, wrap(handlerSaveSettings));
app.delete("/api/v1/users", requireAuth, wrap(handlerDeleteUser));
// Public: the emailed confirmation link lands on the website (no session); the
// token is the proof. Rate-limited against token guessing.
app.post("/api/v1/users/delete/confirm", rateLimit(10, 15 * 60_000), wrap(handlerConfirmDeleteUser));
app.post("/api/v1/users/avatar", requireAuth, wrap(handlerUploadAvatar));
app.get("/api/v1/users/connections/google", requireAuth, wrap(handlerCheckGoogleStatus));
app.post("/api/v1/users/connections/google/revoke", requireAuth, wrap(handlerRevokeGoogle));
app.get("/api/v1/users/connections/caldav", requireAuth, wrap(handlerCheckCaldavStatus));
app.post("/api/v1/users/connections/caldav", requireAuth, wrap(handlerConnectCaldav));
app.delete("/api/v1/users/connections/caldav", requireAuth, wrap(handlerDisconnectCaldav));
app.post("/api/v1/users/connections/disconnect", requireAuth, wrap(handlerDisconnectAccount));
app.post("/api/v1/users/connections/calendars/disconnect", requireAuth, wrap(handlerDisconnectExternalCalendar));
app.post("/api/v1/users/reset", wrap(handlerResetUsers)); // public — password reset entry
app.get("/api/v1/users/:userId/avatar", wrap(handlerGetAvatar)); // public — <Image> can't send auth headers

// ── Server ────────────────────────────────────────────────────────────────────
// Error middleware must be registered last so it catches everything above.
app.use(middlewareErrorHandler);

app.listen(port, "0.0.0.0", () => {
  logger.info("server.started", {
    port,
    environment: config.api.environment,
    logLevel: config.api.logLevel,
    externalSyncIntervalMin: config.api.externalSyncIntervalMin,
  });
});

if (config.api.metricsPort > 0) {
  startMetricsServer(config.api.metricsPort);
} else {
  logger.info("metrics.server.disabled");
}

// Periodic cleanup of expired rows (Postgres has no native row TTL).
// Scheduling lives here (app concern); the deletes live in @musubi/db.
async function cleanupExpired() {
  const startedAt = performance.now();
  try {
    await deleteExpiredInvites();
    await deleteExpiredMemberTokens();
    await deleteExpiredSessions();
    await purgeDeletedEvents(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)); // tombstones > 30d
    logger.debug("cleanup.completed", {
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  } catch (e) {
    logger.error("cleanup.failed", { error: e });
  }
}
cleanupExpired();                          // run once at boot (setInterval's first tick is delayed)
setInterval(cleanupExpired, 60 * 60 * 1000); // then hourly

// Near-realtime external sync: poll every connected Google/CalDAV account on a
// schedule; syncUser broadcasts an SSE "external_sync" to affected members when
// something actually changed, and their clients run a silent delta refresh.
// Polling is the uniform answer here — true Google push (watch webhooks) needs a
// public HTTPS endpoint + channel renewal (self-host-unfriendly), and CalDAV has
// no push protocol at all. EXTERNAL_SYNC_INTERVAL_MIN=0 disables.
if (config.api.externalSyncIntervalMin > 0) {
  logger.info("sync.scheduler.enabled", { intervalMin: config.api.externalSyncIntervalMin });
  setInterval(async () => {
    const startedAt = performance.now();
    try {
      const userIDs = await getExternalSyncUserIDs();
      let changedCalendars = 0;
      for (const userID of userIDs) {
        changedCalendars += (await syncUser(userID)).length; // per-provider errors are caught inside
      }
      const fields = {
        users: userIDs.length,
        changedCalendars,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      };
      if (changedCalendars > 0) logger.info("sync.scheduler.completed", fields);
      else logger.debug("sync.scheduler.completed", fields);
    } catch (e) {
      recordExternalSyncFailure("scheduler", "all");
      logger.error("sync.scheduler.failed", {
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        error: e,
      });
    }
  }, config.api.externalSyncIntervalMin * 60 * 1000);
} else {
  logger.info("sync.scheduler.disabled");
}
