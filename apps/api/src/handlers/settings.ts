import { getUserSettings, saveUserSettings } from "@musubi/db";
import { BadRequestError, Settings, SettingsSchema } from "@musubi/types";
import { Request, Response } from "express";


export async function handlerGetSettings(req: Request, res: Response) {
  const result = await getUserSettings(req.user!.id);

  res.status(200).json(result);
}

export async function handlerSaveSettings(req: Request, res: Response) {
  let settings: Settings;

  try {
    settings = SettingsSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid settings data...");
  }

  const result = await saveUserSettings(req.user!.id, settings);

  res.status(200).json(result);
}
