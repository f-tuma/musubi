import { googleCheck } from "@musubi/db";
import { Request, Response } from "express";

export async function handlerCheckGoogleStatus(req: Request, res: Response) {
  const result = await googleCheck(req.user!.id);
  res.status(200).json(result);
}

