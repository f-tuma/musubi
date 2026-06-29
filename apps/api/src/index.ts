import { config } from "@musubi/config";
import { auth } from "@musubi/auth";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import cors from "cors";
import { middlewareErrorHandler } from "./middleware/error_handler";
import { handlerCreateCalendar, handlerGetCalendars, handlerGetCalendar, handlerRemoveCalendar, handlerUpdateCalendar, handlerJoinCalendar, handlerLeaveCalendar, handlerGetCalendarFromToken } from "./handlers/calendars";
import { handlerDeleteUser, handlerResetUsers } from "./handlers/users";
import { handlerCreateEvent, handlerGetEvents, handlerRemoveEvent, handlerUpdateEvent } from "./handlers/events";
import { requireAuth } from "./middleware/require_auth";
import { handlerCreateCalendarInvite } from "./handlers/invites";
import { handlerStream } from "./handlers/stream";
import { middlewareLogHandler } from "./middleware/log_handler";
import { handlerGetSettings, handlerSaveSettings } from "./handlers/settings";
import { handlerServer, handlerServerStatus } from "./handlers/server";
import { handlerCheckGoogleStatus, handlerRevokeGoogle } from "./handlers/google";

const app = express()
const port = config.api.port;

const allowedOrigins = [
  config.api.url,
  ...(config.api.environment === "dev" ? ["http://localhost:3000", "http://localhost:8081"] : []),
];

//MIDDLEWARE

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
app.use(express.json());
app.use(middlewareLogHandler);

//

// AUTH

app.all("/api/auth/{*any}", toNodeHandler(auth));

//

// GET REQUESTS

app.get("/api/v1/server", handlerServer);
app.get("/api/v1/server/ok", handlerServerStatus);

app.get("/api/v1/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetCalendars(req, res).catch(next));
});

app.get("/api/v1/calendars/:id", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetCalendar(req, res).catch(next));
});

app.get("/api/v1/calendars/tokens/:token", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetCalendarFromToken(req, res).catch(next));
});

app.get("/api/v1/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetEvents(req, res).catch(next));
});

app.get("/api/v1/stream", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerStream(req, res).catch(next));
});

app.get("/api/v1/users/settings", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetSettings(req, res).catch(next));
});

app.get("/api/v1/users/connections/google", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCheckGoogleStatus(req, res).catch(next));
});

//

// POST REQUESTS

app.post("/api/v1/users/reset", (
  req,
  res,
  next) => {
  Promise.resolve(handlerResetUsers(req, res).catch(next));
});

app.post("/api/v1/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCreateCalendar(req, res).catch(next));
});

app.post("/api/v1/calendars/members/:calendarId", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerJoinCalendar(req, res).catch(next));
});

app.post("/api/v1/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCreateEvent(req, res).catch(next));
});

app.post("/api/v1/calendars/invites", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCreateCalendarInvite(req, res).catch(next));
});

app.post("/api/v1/users/connections/google/revoke", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerRevokeGoogle(req, res).catch(next));
});

//

// PUT REQUESTS

app.put("/api/v1/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerUpdateEvent(req, res).catch(next));
});

app.put("/api/v1/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerUpdateCalendar(req, res).catch(next));
});

app.put("/api/v1/users/settings", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerSaveSettings(req, res).catch(next));
});

//

// DELETE REQUESTS

app.delete("/api/v1/users", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerDeleteUser(req, res).catch(next));
});

app.delete("/api/v1/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerRemoveEvent(req, res).catch(next));
});

app.delete("/api/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerRemoveCalendar(req, res).catch(next));
});

app.delete("/api/calendars/members/:calendarId", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerLeaveCalendar(req, res).catch(next));
});

//


// SERVER
// These should be last...

app.use(middlewareErrorHandler);

app.listen(port, "0.0.0.0")
