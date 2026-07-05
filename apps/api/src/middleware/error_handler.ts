import { NextFunction, Request, Response } from "express";
import { AppError } from "@musubi/types";


export function middlewareErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  let statusCode: number = 500;
  let errorMessage: String = "500 - Internal Server Errors";
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
    default:
      break;
  }
  console.error(err.message);
  res.status(statusCode).json({
    error: errorMessage,
  });
}
