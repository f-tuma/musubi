import { Request, Response } from "express";


export function handlerServerStatus(_: Request, res: Response) {
  res.status(200).json({ ok: true });
}

export function handlerServer(_: Request, res: Response) {
  res.status(200).json({ minClientVersion: "0.0.15" });
}

