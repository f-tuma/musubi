import { AppError } from "@musubi/types";
import { ZodError } from "zod";

export function httpErrorFor(err: Error) {
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      errorMessage: "Request contains invalid data.",
    };
  }

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
      // stale session on delete-account is a 400, not a 500).
      const libStatus = (err as { statusCode?: unknown }).statusCode;
      if (typeof libStatus === "number") {
        statusCode = libStatus;
        errorMessage = err.message;
      }
      break;
    }
  }

  return { statusCode, errorMessage };
}
