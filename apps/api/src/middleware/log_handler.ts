import { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "@musubi/config";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function middlewareLogHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const supplied = req.get("x-request-id");
  const requestId = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  const startedAt = performance.now();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  logger.runWithContext({ requestId }, () => {
    res.once("finish", () => {
      // Prefer the registered route pattern so invite/auth tokens embedded in a
      // concrete URL never land in logs. Fall back only for unmatched routes.
      const route = typeof req.route?.path === "string" ? req.route.path : "<unmatched>";
      const fields = {
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        ...(req.user?.id ? { userId: req.user.id } : {}),
      };

      if (res.statusCode >= 500) logger.error("http.request.completed", fields);
      else if (res.statusCode >= 400) logger.warn("http.request.completed", fields);
      else logger.info("http.request.completed", fields);
    });
    next();
  });
}
