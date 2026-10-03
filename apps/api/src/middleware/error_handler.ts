import { DuplicateEventMutationError, DuplicateTaskMutationError, TaskSourceChangedError } from "@musubi/db";
import type { NextFunction, Request, Response } from "express";
import { logger } from "@musubi/config";
import { httpErrorFor } from "./http_error";
import { ProviderEventWriteError } from "../sync/event_write";
import { EventWriteError } from "@musubi/types";

export function middlewareErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const { statusCode, errorMessage } =
    err instanceof DuplicateEventMutationError || err instanceof DuplicateTaskMutationError || err instanceof TaskSourceChangedError
      ? { statusCode: 409, errorMessage: err.message }
      : err instanceof ProviderEventWriteError
      ? {
          statusCode: 409,
          errorMessage:
            "Remote event version changed or is unavailable. No changes were saved. Refresh and reconcile before retrying.",
        }
      : httpErrorFor(err);
  const fields = {
    requestId: req.requestId,
    method: req.method,
    route: typeof req.route?.path === "string" ? req.route.path : "<unmatched>",
    status: statusCode,
    ...(req.user?.id ? { userId: req.user.id } : {}),
  };
  if (statusCode >= 500) {
    logger.error("http.request.failed", { ...fields, error: err });
  } else {
    logger.warn("http.request.rejected", {
      ...fields,
      errorName: err.name,
      errorMessage: err.message,
    });
  }

  res.status(statusCode).json({
    error: errorMessage,
    ...(err instanceof DuplicateEventMutationError
      ? { code: "event-mutation-duplicate", localCommitted: false } : {}),
    ...(err instanceof DuplicateTaskMutationError ? { code: "task-mutation-duplicate", localCommitted: false } : {}),
    ...(err instanceof TaskSourceChangedError ? { code: "task-source-changed", localCommitted: false } : {}),
    ...(err instanceof ProviderEventWriteError
      ? { code: err.code, localCommitted: false }
      : {}),
    ...(err instanceof EventWriteError
      ? { reason: err.reason, capability: err.capability }
      : {}),
    requestId: req.requestId,
  });
}
