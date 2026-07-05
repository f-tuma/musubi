import { NextFunction, Request, Response } from "express";


export function middlewareLogHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  res.on("finish", () => {
    console.log(`URL: ${req.path} | METHOD: ${req.method} | STATUS: ${res.statusCode}`);
  });
  next();
}
