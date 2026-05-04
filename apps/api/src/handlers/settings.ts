import { getUserSettings, saveUserSettings } from "@musubi/db";
import { BadRequestError } from "@musubi/types";
import { Request, Response } from "express";
import * as z from "zod";


const Settings = z.object({
  showKanji: z.boolean(),
  defaultCalendarView: z.string(),
  weekStartsOn: z.string(),
});

export type Settings = z.infer<typeof Settings>;

export async function handlerGetSettings(req: Request, res: Response) {
  const result = await getUserSettings(req.user!.id);

  res.status(200).json(result);
}

export async function handlerSaveSettings(req: Request, res: Response) {
  let settings: Settings;

  try {
    settings = Settings.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid settings data...");
  }

  const result = await saveUserSettings(req.user!.id, { ...settings, id: req.user!.id });

  res.status(200).json(result);
}
