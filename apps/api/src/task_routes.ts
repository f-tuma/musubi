import type { Express, RequestHandler } from "express";
import { TaskClientUpgradeRequiredSchema, TASK_MUTATION_PATH } from "@musubi/types";
import { requireAuth } from "./middleware/require_auth";
import { rateLimit } from "./middleware/rate_limit";
import {
  handlerCreateTask, handlerGetTask, handlerGetTasks, handlerUpdateTask,
  handlerRemoveTask, handlerLinkTask, handlerForkTask,
} from "./handlers/tasks";
import { handlerGetTaskDeliveryInbox, handlerGetTaskDelivery, handlerRetryTaskDelivery } from "./handlers/task_delivery";

const wrap = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const requireTaskClientUpgrade: RequestHandler = (req, res) => {
  // Refuse before any handler/preflight/DB write. A version header cannot make a
  // legacy DTO client understand a committed mutation receipt or supply CAS.
  res.status(426).json(TaskClientUpgradeRequiredSchema.parse({
    error: "Update Musubi to save tasks. Your task changes have not been saved.",
    code: "task-client-upgrade-required",
    message: "Update Musubi to save tasks. Your task changes have not been saved.",
    localCommitted: false,
    taskMutationPath: TASK_MUTATION_PATH,
    requestId: req.requestId,
  }));
};

/** Used by the production app and the authenticated compatibility tests. */
export function registerTaskRoutes(app: Express) {
  app.get("/api/v1/tasks", requireAuth, wrap(handlerGetTasks));
  app.get("/api/v1/tasks/:taskId", requireAuth, wrap(handlerGetTask));
  app.get("/api/v1/task-deliveries", requireAuth, wrap(handlerGetTaskDeliveryInbox));
  app.get("/api/v1/tasks/:taskId/delivery", requireAuth, wrap(handlerGetTaskDelivery));
  app.post("/api/v1/tasks/:taskId/delivery/:operationId/retry", requireAuth, rateLimit(30, 60_000, { byUser: true }), wrap(handlerRetryTaskDelivery));

  // Kept registered for already shipped clients: explicit update-required,
  // never a successful write followed by an unreadable response.
  app.post("/api/v1/tasks", requireAuth, requireTaskClientUpgrade);
  app.patch("/api/v1/tasks/:taskId", requireAuth, requireTaskClientUpgrade);
  app.put("/api/v1/tasks/:taskId", requireAuth, requireTaskClientUpgrade);
  app.delete("/api/v1/tasks/:taskId", requireAuth, requireTaskClientUpgrade);
  app.post("/api/v1/tasks/:taskId/link", requireAuth, requireTaskClientUpgrade);
  app.post("/api/v1/tasks/:taskId/fork", requireAuth, requireTaskClientUpgrade);

  app.post("/api/v1/task-mutations", requireAuth, wrap(handlerCreateTask));
  app.patch("/api/v1/task-mutations/:taskId", requireAuth, wrap(handlerUpdateTask));
  app.put("/api/v1/task-mutations/:taskId", requireAuth, wrap(handlerUpdateTask));
  app.delete("/api/v1/task-mutations/:taskId", requireAuth, wrap(handlerRemoveTask));
  app.post("/api/v1/task-mutations/:taskId/link", requireAuth, wrap(handlerLinkTask));
  app.post("/api/v1/task-mutations/:taskId/fork", requireAuth, wrap(handlerForkTask));
}
