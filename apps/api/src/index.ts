import { config } from "@musubi/config";
import { auth } from "@musubi/auth";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { middlewareErrorHandler } from "./middleware/error_handler";
import { handlerCreateCalendar, handlerGetCalendars, handlerGetCalendar, handlerRemoveCalendar, handlerUpdateCalendar, handlerJoinCalendar, handlerLeaveCalendar, handlerGetCalendarFromToken } from "./handlers/calendars";
import { handlerDeleteUser, handlerResetPassword, handlerResetUsers } from "./handlers/users";
import { handlerCreateEvent, handlerGetEvents, handlerRemoveEvent, handlerUpdateEvent } from "./handlers/events";
import { requireAuth } from "./middleware/require_auth";
import { handlerCreateCalendarInvite } from "./handlers/invites";
import { handlerStream } from "./handlers/stream";
import { middlewareLogHandler } from "./middleware/log_handler";
import { handlerGetSettings, handlerSaveSettings } from "./handlers/settings";
import { handlerServerStatus } from "./handlers/server";

const app = express()
const port = config.api.port;


//MIDDLEWARE

app.use(express.json());
app.use(middlewareLogHandler);

//

// AUTH

app.all("/api/auth/{*any}", toNodeHandler(auth));

//

// GET REQUESTS

app.get("/api/server/ok", handlerServerStatus);

app.get("/api/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetCalendars(req, res).catch(next));
});

app.get("/api/calendars/:id", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetCalendar(req, res).catch(next));
});

app.get("/api/calendars/tokens/:token", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetCalendarFromToken(req, res).catch(next));
});

app.get("/api/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetEvents(req, res).catch(next));
});

app.get("/api/stream", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerStream(req, res).catch(next));
});

app.get("/api/users/settings", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerGetSettings(req, res).catch(next));
});

//

// POST REQUESTS

app.post("/api/users/reset", (
  req,
  res,
  next) => {
  Promise.resolve(handlerResetUsers(req, res).catch(next));
});

app.post("/api/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCreateCalendar(req, res).catch(next));
});

app.post("/api/calendars/members/:calendarId", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerJoinCalendar(req, res).catch(next));
});

app.post("/api/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCreateEvent(req, res).catch(next));
});

app.post("/api/calendars/invites", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerCreateCalendarInvite(req, res).catch(next));
});

// app.post("/api/users/reset-password", requireAuth, (
//   req,
//   res,
//   next) => {
//   Promise.resolve(handlerResetPassword(req, res).catch(next));
// });

//

// PUT REQUESTS

app.put("/api/events", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerUpdateEvent(req, res).catch(next));
});

app.put("/api/calendars", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerUpdateCalendar(req, res).catch(next));
});

app.put("/api/users/settings", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerSaveSettings(req, res).catch(next));
});

//

// DELETE REQUESTS

app.delete("/api/users", requireAuth, (
  req,
  res,
  next) => {
  Promise.resolve(handlerDeleteUser(req, res).catch(next));
});

app.delete("/api/events", requireAuth, (
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
