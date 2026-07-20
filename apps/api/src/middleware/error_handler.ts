import { NextFunction, Request, Response } from "express";
import { AppError } from "@musubi/types";
import { logger } from "@musubi/config";


export function middlewareErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  let statusCode = 500;
  let errorMessage: string = "500 - Internal Server Error";
  const appError = err as AppError;
  switch (appError.kind) {
    case "BadRequest":
      statusCode = 400;
      errorMessage = appError.message;
      break;
    case "Unauthorized":
      statusCode = 401;
      errorMessage = appError.message;
      break;
    case "Forbidden":
      statusCode = 403;
      errorMessage = appError.message;
      break;
    case "NotFound":
      statusCode = 404;
      errorMessage = appError.message;
      break;
    default: {
      // Better Auth / better-call APIError carries its own HTTP status (e.g. a
      // stale session on delete-account is a 400, not a 500). Surface it instead
      // of masking every library error as an Internal Server Error.
      const libStatus = (err as { statusCode?: unknown }).statusCode;
      if (typeof libStatus === "number") {
        statusCode = libStatus;
        errorMessage = err.message;
      }
      break;
    }
  }

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
    requestId: req.requestId,
  });
}
