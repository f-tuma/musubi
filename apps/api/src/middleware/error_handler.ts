import { NextFunction, Request, Response } from "express";
import { logger } from "@musubi/config";
import { httpErrorFor } from "./http_error";

export function middlewareErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const { statusCode, errorMessage } = httpErrorFor(err);
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
