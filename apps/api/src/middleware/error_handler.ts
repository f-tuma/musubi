import { DuplicateEventMutationError, DuplicateTaskMutationError, TaskSourceChangedError } from "@musubi/db";
import type { NextFunction, Request, Response } from "express";
import { logger } from "@musubi/config";
import { httpErrorFor } from "./http_error";
import { ProviderEventWriteError } from "../sync/event_write";
import { EventWritePending, eventWritePendingRetryAfterSeconds } from "../sync/event_write_pending";
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
      // A pre-commit preflight that was deferred or timed out before any raw
      // dispatch is a known temporary wait, not a permission answer or a failure.
      : err instanceof EventWritePending
      ? { statusCode: 503, errorMessage: err.message }
      : httpErrorFor(err);
  const fields = {
    requestId: req.requestId,
    method: req.method,
    route: typeof req.route?.path === "string" ? req.route.path : "<unmatched>",
    status: statusCode,
    ...(req.user?.id ? { userId: req.user.id } : {}),
  };
  if (err instanceof EventWritePending) {
    res.setHeader("Retry-After", String(eventWritePendingRetryAfterSeconds(err)));
    logger.warn("http.request.rejected", { ...fields, errorName: err.name, errorMessage: err.message, reason: err.reason, retryAtMs: err.retryAtMs });
  } else if (statusCode >= 500) {
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
    ...(err instanceof EventWritePending
      ? { code: err.code, localCommitted: false, retryAt: new Date(err.retryAtMs).toISOString() }
      : {}),
    ...(err instanceof EventWriteError
      ? { reason: err.reason, capability: err.capability }
      : {}),
    requestId: req.requestId,
  });
}
